"""Cut stored frames (and the masks of their annotations) to a rectangle, in place.

The crop is irreversible by design: the old image and mask objects are deleted
once the database points at the new ones. New objects get new storage keys, so
no browser or presigned-URL cache can keep showing the old picture.
"""

import uuid

import cv2
import numpy as np
from sqlalchemy import or_
from sqlalchemy.orm import Session

from app.annotation.models import Annotation
from app.media.models import Frame
from app.media.schemas import CropBox, FrameCropResult
from app.media.service import _apply_crop
from app.storage import StorageService


def _decode(data: bytes, flags: int) -> np.ndarray:
    return cv2.imdecode(np.frombuffer(data, np.uint8), flags)


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
    frames = (
        session.query(Frame)
        .filter(Frame.id.in_(set(frame_ids)), Frame.sequence_id == sequence_id)
        .order_by(Frame.id)
        .all()
    )
    annotations = (
        session.query(Annotation)
        .filter(
            Annotation.frame_id.in_([frame.id for frame in frames]),
            or_(Annotation.storage_key.isnot(None), Annotation.raw_mask_storage_key.isnot(None)),
        )
        .all()
    )

    cut_frames: dict[int, tuple[bytes, int, int]] = {}
    for frame in frames:
        cut = _apply_crop(_decode(storage.download(frame.storage_key), cv2.IMREAD_COLOR), crop)
        cut_frames[frame.id] = (_encode_png(cut), cut.shape[1], cut.shape[0])

    cut_masks: dict[tuple[int, str], bytes] = {}
    masks_clipped = 0
    for annotation in annotations:
        clipped = False
        for attribute in ("storage_key", "raw_mask_storage_key"):
            key = getattr(annotation, attribute)
            if key is None:
                continue
            mask = _decode(storage.download(key), cv2.IMREAD_GRAYSCALE)
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
    for frame in frames:
        data, width, height = cut_frames[frame.id]
        new_key = _new_key(frame.storage_key)
        storage.upload(new_key, data, content_type="image/png")
        old_keys.append(frame.storage_key)
        frame.storage_key, frame.width, frame.height, frame.size_bytes = (
            new_key, width, height, len(data),
        )
    for annotation in annotations:
        for attribute in ("storage_key", "raw_mask_storage_key"):
            data = cut_masks.get((annotation.id, attribute))
            if data is None:
                continue
            old_keys.append(getattr(annotation, attribute))
            new_key = _new_key(getattr(annotation, attribute))
            storage.upload(new_key, data, content_type="image/png")
            setattr(annotation, attribute, new_key)
    session.commit()
    # Only after the commit: a failed commit must not leave rows whose image is gone.
    for key in old_keys:
        storage.delete(key)
    return result
