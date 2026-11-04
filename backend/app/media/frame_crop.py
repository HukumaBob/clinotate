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


def crop_frames(
    session: Session,
    storage: StorageService,
    sequence_id: int,
    frame_ids: list[int],
    crop: CropBox,
    dry_run: bool,
) -> FrameCropResult:
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
