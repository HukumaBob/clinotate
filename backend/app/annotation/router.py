from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session

from app.annotation.models import Annotation
from app.annotation.schemas import (
    AnnotationCreate,
    AnnotationRead,
    AnnotationStatusUpdate,
    MaskPostprocessUpdate,
)
from app.annotation.service import (
    create_classification_annotation,
    reapply_mask_postprocess,
    require_reviewer_or_admin,
)
from app.auth.dependencies import get_current_user
from app.auth.models import User
from app.db import get_session
from app.storage import StorageService, get_storage_service

router = APIRouter(prefix="/annotation", tags=["annotation"], dependencies=[Depends(get_current_user)])


def _annotation_read(annotation: Annotation, storage: StorageService) -> AnnotationRead:
    return AnnotationRead(
        id=annotation.id,
        frame_id=annotation.frame_id,
        label_id=annotation.label_id,
        taxonomy_version=annotation.taxonomy_version,
        annotation_type=annotation.annotation_type,
        status=annotation.status,
        created_by_id=annotation.created_by_id,
        reviewed_by_id=annotation.reviewed_by_id,
        mask_url=storage.url_for(annotation.storage_key) if annotation.storage_key else None,
        job_id=annotation.job_id,
        mask_postprocess_strength=annotation.payload.get("mask_postprocess_strength")
        if annotation.payload
        else None,
    )


@router.post(
    "/frames/{frame_id}/annotations", response_model=AnnotationRead, status_code=status.HTTP_201_CREATED
)
def create_annotation(
    frame_id: int,
    payload: AnnotationCreate,
    current_user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
) -> Annotation:
    return create_classification_annotation(session, frame_id, payload.label_id, current_user)


@router.get("/frames/{frame_id}/annotations", response_model=list[AnnotationRead])
def list_annotations(
    frame_id: int,
    session: Session = Depends(get_session),
    storage: StorageService = Depends(get_storage_service),
) -> list[AnnotationRead]:
    annotations = session.query(Annotation).filter(Annotation.frame_id == frame_id).all()
    return [_annotation_read(annotation, storage) for annotation in annotations]


@router.patch("/annotations/{annotation_id}/status", response_model=AnnotationRead)
def update_status(
    annotation_id: int,
    payload: AnnotationStatusUpdate,
    current_user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
) -> Annotation:
    require_reviewer_or_admin(current_user)
    annotation = session.get(Annotation, annotation_id)
    if annotation is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Annotation not found")
    annotation.status = payload.status
    annotation.reviewed_by_id = current_user.id
    session.commit()
    session.refresh(annotation)
    return annotation


@router.delete("/annotations/{annotation_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_annotation(
    annotation_id: int,
    session: Session = Depends(get_session),
    storage: StorageService = Depends(get_storage_service),
) -> None:
    annotation = session.get(Annotation, annotation_id)
    if annotation is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Annotation not found")
    if annotation.storage_key:
        storage.delete(annotation.storage_key)
    session.delete(annotation)
    session.commit()


@router.patch("/annotations/{annotation_id}/mask-postprocess", response_model=AnnotationRead)
def update_mask_postprocess(
    annotation_id: int,
    payload: MaskPostprocessUpdate,
    session: Session = Depends(get_session),
    storage: StorageService = Depends(get_storage_service),
) -> AnnotationRead:
    annotation = reapply_mask_postprocess(session, annotation_id, payload.strength, storage)
    return _annotation_read(annotation, storage)


@router.delete("/jobs/{job_id}/annotations")
def delete_job_annotations(
    job_id: int,
    session: Session = Depends(get_session),
    storage: StorageService = Depends(get_storage_service),
) -> dict[str, list[int]]:
    annotations = session.query(Annotation).filter(Annotation.job_id == job_id).all()
    deleted_ids = [annotation.id for annotation in annotations]
    for annotation in annotations:
        if annotation.storage_key:
            storage.delete(annotation.storage_key)
        session.delete(annotation)
    session.commit()
    return {"deleted_ids": deleted_ids}
