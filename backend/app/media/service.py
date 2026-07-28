import hashlib
import tempfile
from datetime import date
from pathlib import Path

import cv2
from sqlalchemy import func
from sqlalchemy.orm import Session

from app.media.models import Sequence
from app.media.schemas import CropBox
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
