from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session

from app.annotation.models import Annotation
from app.annotation.schemas import AnnotationCreate, AnnotationRead, AnnotationStatusUpdate
from app.annotation.service import create_classification_annotation, require_reviewer_or_admin
from app.auth.dependencies import get_current_user
from app.auth.models import User
from app.db import get_session

router = APIRouter(prefix="/annotation", tags=["annotation"], dependencies=[Depends(get_current_user)])


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
def list_annotations(frame_id: int, session: Session = Depends(get_session)) -> list[Annotation]:
    return session.query(Annotation).filter(Annotation.frame_id == frame_id).all()


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
