"""Cut stored frames (and the masks of their annotations) to a rectangle, in place.

The crop is irreversible by design: the old image and mask objects are deleted
once the database points at the new ones. New objects get new storage keys, so
no browser or presigned-URL cache can keep showing the old picture.
"""

import logging
import uuid

import cv2
import numpy as np
from sqlalchemy import or_
from sqlalchemy.orm import Session

from app.annotation.models import Annotation
from app.media.models import Frame, Sequence
from app.media.schemas import CropBox, FrameCropResult
from app.media.service import _apply_crop
from app.storage import StorageService

logger = logging.getLogger(__name__)


class SequenceNotFound(Exception):
    """No such sequence."""


class CropRefused(Exception):
    """The request cannot be applied; nothing was changed."""


def _decode(data: bytes, flags: int, what: str) -> np.ndarray:
    image = cv2.imdecode(np.frombuffer(data, np.uint8), flags)
    if image is None:
        raise CropRefused(f"{what} could not be read as an image")
    return image


def _encode_png(image: np.ndarray) -> bytes:
    return cv2.imencode(".png", image)[1].tobytes()


def _new_key(old_key: str) -> str:
    return f"{old_key.rsplit('.', 1)[0]}-{uuid.uuid4().hex[:8]}.png"


def load_frames(session: Session, sequence_id: int, frame_ids: list[int]) -> list[Frame]:
    """The requested frames, all of which must belong to the sequence."""
    if session.get(Sequence, sequence_id) is None:
        raise SequenceNotFound(f"Sequence {sequence_id} not found")
    wanted = set(frame_ids)
    frames = (
        session.query(Frame)
        .filter(Frame.id.in_(wanted), Frame.sequence_id == sequence_id)
        .order_by(Frame.id)
        .all()
    )
    missing = sorted(wanted - {frame.id for frame in frames})
    if missing:
        raise CropRefused(f"Frames {missing} are not in sequence {sequence_id}")
    return frames


def crop_frames(
    session: Session,
    storage: StorageService,
    sequence_id: int,
    frame_ids: list[int],
    crop: CropBox,
    dry_run: bool,
) -> FrameCropResult:
    frames = load_frames(session, sequence_id, frame_ids)
    annotations = (
        session.query(Annotation)
        .filter(
            Annotation.frame_id.in_([frame.id for frame in frames]),
            or_(Annotation.storage_key.isnot(None), Annotation.raw_mask_storage_key.isnot(None)),
        )
        .all()
    )

    cut_frames: dict[int, tuple[bytes, int, int]] = {}
    frame_shapes: dict[int, tuple[int, int]] = {}
    for frame in frames:
        image = _decode(storage.download(frame.storage_key), cv2.IMREAD_COLOR, f"Frame {frame.id}")
        frame_shapes[frame.id] = image.shape[:2]
        cut = _apply_crop(image, crop)
        cut_frames[frame.id] = (_encode_png(cut), cut.shape[1], cut.shape[0])

    cut_masks: dict[tuple[int, str], bytes] = {}
    masks_clipped = 0
    for annotation in annotations:
        clipped = False
        for attribute in ("storage_key", "raw_mask_storage_key"):
            key = getattr(annotation, attribute)
            if key is None:
                continue
            mask = _decode(
                storage.download(key), cv2.IMREAD_GRAYSCALE, f"The mask of annotation {annotation.id}"
            )
            if mask.shape != frame_shapes[annotation.frame_id]:
                raise CropRefused(
                    f"The mask of annotation {annotation.id} is {mask.shape[1]}x{mask.shape[0]} "
                    f"but its frame is {frame_shapes[annotation.frame_id][1]}x"
                    f"{frame_shapes[annotation.frame_id][0]}"
                )
            cut = _apply_crop(mask, crop)
            if attribute == "storage_key" or annotation.storage_key is None:
                clipped = np.count_nonzero(mask) > np.count_nonzero(cut)
            cut_masks[(annotation.id, attribute)] = _encode_png(cut)
        masks_clipped += int(clipped)

    result = FrameCropResult(
        frames=len(frames),
        annotations=len(annotations),
        masks_clipped=masks_clipped,
        applied=not dry_run,
    )
    if dry_run:
        return result

    old_keys: list[str] = []
    uploaded: list[str] = []
    try:
        for frame in frames:
            data, width, height = cut_frames[frame.id]
            new_key = _new_key(frame.storage_key)
            storage.upload(new_key, data, content_type="image/png")
            uploaded.append(new_key)
            old_keys.append(frame.storage_key)
            frame.storage_key, frame.width, frame.height, frame.size_bytes = (
                new_key, width, height, len(data),
            )
        for annotation in annotations:
            for attribute in ("storage_key", "raw_mask_storage_key"):
                data = cut_masks.get((annotation.id, attribute))
                if data is None:
                    continue
                old_key = getattr(annotation, attribute)
                new_key = _new_key(old_key)
                storage.upload(new_key, data, content_type="image/png")
                uploaded.append(new_key)
                old_keys.append(old_key)
                setattr(annotation, attribute, new_key)
        session.commit()
    except Exception:
        session.rollback()
        for key in uploaded:
            try:
                storage.delete(key)
            except Exception:  # noqa: BLE001 -- best effort; the original error is the one to surface
                logger.warning("crop_frames: could not remove %s", key)
        raise
    # Only after the commit: a failed commit must not leave rows whose image is gone.
    for key in old_keys:
        storage.delete(key)
    return result


# Detection tuning. Pixels at or below this grey level count as border.
_NEAR_BLACK = 12
_DETECT_WIDTH = 320
_MIN_PICTURE_AREA = 0.05
_MAX_SIDE_SPREAD_PCT = 5.0
_MIN_INSET_PCT = 1.0
_MARGIN_PCT = 1.0


def _picture_insets(image: np.ndarray) -> dict[str, float] | None:
    """Insets (percent) of the largest non-black region, or None if it is tiny."""
    gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
    scale = _DETECT_WIDTH / gray.shape[1]
    if scale < 1:
        gray = cv2.resize(gray, None, fx=scale, fy=scale, interpolation=cv2.INTER_AREA)
    picture = (gray > _NEAR_BLACK).astype(np.uint8)
    picture = cv2.morphologyEx(picture, cv2.MORPH_OPEN, np.ones((3, 3), np.uint8))
    count, _labels, stats, _centroids = cv2.connectedComponentsWithStats(picture)
    if count < 2:
        return None
    biggest = 1 + int(np.argmax(stats[1:, cv2.CC_STAT_AREA]))
    x, y, w, h, _area = stats[biggest]
    height, width = picture.shape
    if w * h < _MIN_PICTURE_AREA * width * height:
        return None
    return {
        "left": x / width * 100,
        "right": (width - x - w) / width * 100,
        "top": y / height * 100,
        "bottom": (height - y - h) / height * 100,
    }


def detect_frames_crop(storage: StorageService, frames: list[Frame]) -> CropBox | None:
    """Propose a crop from the black border of the given frames.

    Each frame's picture is the largest non-black region (burned-in text in the
    border is small and drops out). The per-side insets are combined by the
    median, and the proposal is withheld when the frames disagree by more than
    `_MAX_SIDE_SPREAD_PCT`, when any picture is tiny, or when there is no
    border to remove. The result is loosened by `_MARGIN_PCT`, never tightened.
    """
    per_frame = []
    for frame in frames:
        image = _decode(storage.download(frame.storage_key), cv2.IMREAD_COLOR, f"Frame {frame.id}")
        insets = _picture_insets(image)
        if insets is None:
            return None
        per_frame.append(insets)
    if not per_frame:
        return None
    medians: dict[str, float] = {}
    for side in ("left", "right", "top", "bottom"):
        values = [insets[side] for insets in per_frame]
        if max(values) - min(values) > _MAX_SIDE_SPREAD_PCT:
            return None
        medians[side] = float(np.median(values))
    if all(value < _MIN_INSET_PCT for value in medians.values()):
        return None
    return CropBox(**{side: round(max(0.0, value - _MARGIN_PCT), 1) for side, value in medians.items()})
