import io

import numpy as np
from fastapi import HTTPException, status
from PIL import Image
from sqlalchemy.orm import Session

from app.annotation.mask_postprocess import postprocess_mask
from app.annotation.models import Annotation, AnnotationType
from app.auth.models import User, UserRole
from app.jobs.models import Job
from app.settings.service import get_platform_settings
from app.storage import StorageService
from app.taxonomy.models import Label


def create_classification_annotation(
    session: Session, frame_id: int, label_id: int, created_by: User
) -> Annotation:
    label = session.get(Label, label_id)
    if label is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Label not found")

    annotation = Annotation(
        frame_id=frame_id,
        label_id=label_id,
        taxonomy_version=label.taxonomy_version,
        annotation_type=AnnotationType.CLASSIFICATION,
        payload={},
        created_by_id=created_by.id,
    )
    session.add(annotation)
    session.commit()
    session.refresh(annotation)
    return annotation


def bulk_classify_frames(
    session: Session, frame_ids: list[int], label_id: int, created_by: User
) -> list[int]:
    label = session.get(Label, label_id)
    if label is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Label not found")

    category_label_ids = {
        row.id
        for row in session.query(Label).filter(Label.category_id == label.category_id).all()
    }

    for frame_id in frame_ids:
        existing = (
            session.query(Annotation)
            .filter(
                Annotation.frame_id == frame_id,
                Annotation.annotation_type == AnnotationType.CLASSIFICATION,
                Annotation.label_id.in_(category_label_ids),
            )
            .all()
        )
        for annotation in existing:
            session.delete(annotation)

        session.add(
            Annotation(
                frame_id=frame_id,
                label_id=label_id,
                taxonomy_version=label.taxonomy_version,
                annotation_type=AnnotationType.CLASSIFICATION,
                payload={},
                created_by_id=created_by.id,
            )
        )

    session.commit()
    return frame_ids


def require_reviewer_or_admin(user: User) -> None:
    if user.role not in (UserRole.REVIEWER, UserRole.ADMIN):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Reviewer or admin role required")


def apply_default_postprocess_for_job(session: Session, job: Job, storage: StorageService) -> None:
    """Applies the default mask-cleanup strength to every Annotation
    created by `job`, exactly once. Called from jobs/router.py's get_job
    on the request where the job's status is first observed as SUCCEEDED.
    A second poll is a no-op because every Annotation this function
    touches has `payload["mask_postprocess_strength"]` set afterward,
    which this function checks before doing any work.

    Only Annotations with a `raw_mask_storage_key` are eligible -- SAM3
    annotations (post-processing is SAM2-only for now) and any annotation
    predating this column simply have nothing to derive a cleaned mask
    from, so they're skipped rather than erroring the whole job-status
    request.
    """
    annotations = session.query(Annotation).filter(Annotation.job_id == job.id).all()
    pending = [
        a
        for a in annotations
        if a.raw_mask_storage_key is not None
        and (not a.payload or "mask_postprocess_strength" not in a.payload)
    ]
    if not pending:
        return

    # The job's own request can carry an explicit strength (set at enqueue
    # time via the request's mask_postprocess_strength field, e.g. the
    # user moved the ToolsPanel slider before hitting Predict/Track) --
    # that value is used here rather than the platform default, so a mask
    # gets cleaned up either way: with the request-time choice if one was
    # made, or the admin-configured default otherwise.
    strength = job.payload.get("mask_postprocess_strength") if job.payload else None
    if strength is None:
        strength = get_platform_settings(session).mask_postprocess_strength

    for annotation in pending:
        raw_bytes = storage.download(annotation.raw_mask_storage_key)
        raw_image = Image.open(io.BytesIO(raw_bytes)).convert("L")
        raw_mask = np.array(raw_image) > 127

        cleaned_mask = postprocess_mask(raw_mask, strength)

        cleaned_image = Image.fromarray((cleaned_mask.astype(np.uint8)) * 255, mode="L")
        buffer = io.BytesIO()
        cleaned_image.save(buffer, format="PNG")
        storage.upload(annotation.storage_key, buffer.getvalue(), content_type="image/png")

        annotation.payload = {**(annotation.payload or {}), "mask_postprocess_strength": strength}

    session.commit()


def reapply_mask_postprocess(
    session: Session, annotation_id: int, strength: float, storage: StorageService
) -> Annotation:
    annotation = session.get(Annotation, annotation_id)
    if annotation is None or annotation.raw_mask_storage_key is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Annotation or raw mask not found")

    raw_bytes = storage.download(annotation.raw_mask_storage_key)
    raw_image = Image.open(io.BytesIO(raw_bytes)).convert("L")
    raw_mask = np.array(raw_image) > 127

    cleaned_mask = postprocess_mask(raw_mask, strength)

    cleaned_image = Image.fromarray((cleaned_mask.astype(np.uint8)) * 255, mode="L")
    buffer = io.BytesIO()
    cleaned_image.save(buffer, format="PNG")
    storage.upload(annotation.storage_key, buffer.getvalue(), content_type="image/png")

    annotation.payload = {**(annotation.payload or {}), "mask_postprocess_strength": strength}
    session.commit()
    session.refresh(annotation)
    return annotation
