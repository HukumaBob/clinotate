import hashlib
import json
import subprocess
import tempfile
import uuid
from datetime import date
from pathlib import Path

import cv2
from sqlalchemy import func
from sqlalchemy.orm import Session

from app.annotation.models import Annotation
from app.media.models import Frame, Sequence, Video
from app.media.schemas import CropBox
from app.storage import StorageService
from app.taxonomy.models import Procedure


def compute_checksum(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def suggest_sequence_name(session: Session, procedure: Procedure, today: date) -> str:
    base = f"{procedure.name} {today.isoformat()}"
    existing_count = (
        session.query(func.count(Sequence.id))
        .filter(Sequence.name.like(f"{base}%"))
        .scalar()
        or 0
    )
    return f"{base} #{existing_count + 1}"


def probe_video(video_bytes: bytes) -> tuple[float, float]:
    """Returns (fps, duration_seconds)."""
    with tempfile.NamedTemporaryFile(suffix=".mp4") as tmp:
        tmp.write(video_bytes)
        tmp.flush()
        capture = cv2.VideoCapture(tmp.name)
        fps = capture.get(cv2.CAP_PROP_FPS) or 0.0
        frame_count = capture.get(cv2.CAP_PROP_FRAME_COUNT) or 0.0
        capture.release()
    duration = frame_count / fps if fps > 0 else 0.0
    return fps, duration


# Browsers reliably play H.264 in an MP4/MOV-family container, and
# VP8/VP9 in a WebM (Matroska) container. ffprobe reports these container
# families' format_name as these exact comma-joined strings (confirmed
# empirically against a real ffprobe build, not assumed from
# documentation) -- verify against your ffprobe version if this check
# ever starts rejecting normal MP4/WebM uploads. `playable` below checks
# container AND codec membership independently, not a matched pairing --
# an unusual combination like VP9-in-MP4 would also read as playable,
# which is a deliberate simplification (real-world uploads pair codecs
# with their conventional container almost universally) rather than a
# gap worth the added complexity of pairing them explicitly.
_BROWSER_PLAYABLE_CONTAINERS = {"mov,mp4,m4a,3gp,3g2,mj2", "matroska,webm"}
_BROWSER_PLAYABLE_CODECS = {"h264", "vp8", "vp9"}


def probe_codec_compatibility(video_bytes: bytes) -> tuple[bool, str | None, str | None]:
    """Returns (browser_playable, container_format_name, video_codec_name).

    Runs real ffprobe against the file (not a guess from the filename
    extension) -- a `.mp4` file can still contain a codec (e.g. MPEG-4
    Part 2 / "mpeg4") no mainstream browser's <video> element will
    decode. Whitelist, not blacklist: an unrecognized/unparseable
    container or codec is treated as NOT playable, since a false "yes"
    here means a silent black-screen player with no path forward, while
    a false "no" only costs one avoidable transcode offer.
    """
    with tempfile.NamedTemporaryFile(suffix=".mp4") as tmp:
        tmp.write(video_bytes)
        tmp.flush()
        try:
            result = subprocess.run(
                [
                    "ffprobe",
                    "-v", "error",
                    "-select_streams", "v:0",
                    "-show_entries", "stream=codec_name",
                    "-show_entries", "format=format_name",
                    "-of", "json",
                    tmp.name,
                ],
                capture_output=True,
                text=True,
                timeout=30,
                check=True,
            )
        except (subprocess.CalledProcessError, subprocess.TimeoutExpired, FileNotFoundError):
            return False, None, None

    try:
        parsed = json.loads(result.stdout)
        container = parsed.get("format", {}).get("format_name")
        streams = parsed.get("streams", [])
        codec = streams[0].get("codec_name") if streams else None
    except (json.JSONDecodeError, IndexError, AttributeError):
        return False, None, None

    playable = container in _BROWSER_PLAYABLE_CONTAINERS and codec in _BROWSER_PLAYABLE_CODECS
    return playable, container, codec


def _apply_crop(frame, crop: "CropBox | None"):
    if crop is None:
        return frame
    height, width = frame.shape[:2]
    left_px = int(width * crop.left / 100)
    right_px = int(width * crop.right / 100)
    top_px = int(height * crop.top / 100)
    bottom_px = int(height * crop.bottom / 100)
    return frame[top_px : height - bottom_px, left_px : width - right_px]


def extract_frames(
    video_bytes: bytes, sample_fps: float = 1.0, crop: "CropBox | None" = None
) -> list[tuple[int, bytes, int, int]]:
    """Extracts frames at `sample_fps`, returns (frame_index, png_bytes, width, height)."""
    results: list[tuple[int, bytes, int, int]] = []
    with tempfile.NamedTemporaryFile(suffix=".mp4") as tmp:
        tmp.write(video_bytes)
        tmp.flush()
        capture = cv2.VideoCapture(tmp.name)
        source_fps = capture.get(cv2.CAP_PROP_FPS) or sample_fps
        step = max(int(round(source_fps / sample_fps)), 1)

        frame_index = 0
        source_frame_number = 0
        while True:
            success, frame = capture.read()
            if not success:
                break
            if source_frame_number % step == 0:
                frame = _apply_crop(frame, crop)
                height, width = frame.shape[:2]
                success_encode, buffer = cv2.imencode(".png", frame)
                if success_encode:
                    results.append((frame_index, buffer.tobytes(), width, height))
                    frame_index += 1
            source_frame_number += 1
        capture.release()
    return results


def recut_sequence(
    session: Session,
    storage: StorageService,
    sequence: Sequence,
    video: Video,
    start_time: int,
    duration: int,
    fps: float,
    crop: CropBox | None = None,
) -> None:
    """Re-extracts a Sequence's frames with new start/end/fps.

    Extracts and uploads the new frames first, then deletes the old
    Frame rows (cascading to their Annotation rows) and updates the
    sequence's timing -- in that order, so a failure during extraction
    or upload leaves the sequence's existing frames and annotations
    untouched and the caller can simply retry.

    If `crop` is provided, it is used for extraction and persisted as
    the sequence's new crop_box. If omitted, replays the sequence's
    already-persisted crop box (if any) so a re-cut doesn't silently
    discard cropping applied at creation time. New frames get storage
    keys unique to this re-cut operation (not just to the
    sequence/frame_index pair) so a second re-cut can't overwrite a
    first re-cut's still-referenced objects before the old Frame rows
    are deleted. The old frames' storage objects are deleted from MinIO
    only after the DB commit succeeds, so a storage failure here can't
    roll back already-committed DB state.
    """
    video_bytes = storage.download(video.storage_key)
    resolved_crop = crop if crop is not None else (
        CropBox(**sequence.crop_box) if sequence.crop_box else None
    )
    extracted = extract_frames(video_bytes, sample_fps=fps, crop=resolved_crop)

    old_frames = (
        session.query(Frame.id, Frame.storage_key).filter(Frame.sequence_id == sequence.id).all()
    )
    old_frame_ids = [frame_id for frame_id, _ in old_frames]
    old_storage_keys = [storage_key for _, storage_key in old_frames]

    recut_batch = uuid.uuid4().hex
    new_frames = []
    for frame_index, png_bytes, width, height in extracted:
        storage_key = f"frames/{sequence.id}/{recut_batch}-{frame_index}.png"
        storage.upload(storage_key, png_bytes, content_type="image/png")
        new_frames.append(
            Frame(
                sequence_id=sequence.id,
                storage_key=storage_key,
                frame_index=frame_index,
                width=width,
                height=height,
            )
        )

    if old_frame_ids:
        session.query(Annotation).filter(Annotation.frame_id.in_(old_frame_ids)).delete(
            synchronize_session=False
        )
        session.query(Frame).filter(Frame.id.in_(old_frame_ids)).delete(synchronize_session=False)

    for frame in new_frames:
        session.add(frame)

    if crop is not None:
        sequence.crop_box = crop.model_dump()

    sequence.start_time = start_time
    sequence.duration = duration
    session.commit()

    for storage_key in old_storage_keys:
        storage.delete(storage_key)
