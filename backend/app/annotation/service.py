from fastapi import HTTPException, status
from sqlalchemy.orm import Session

from app.annotation.models import Annotation, AnnotationType
from app.auth.models import User, UserRole
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


def require_reviewer_or_admin(user: User) -> None:
    if user.role not in (UserRole.REVIEWER, UserRole.ADMIN):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Reviewer or admin role required")
