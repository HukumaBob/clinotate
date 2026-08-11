from pydantic import BaseModel, ConfigDict

from app.annotation.models import AnnotationStatus, AnnotationType


class AnnotationCreate(BaseModel):
    label_id: int


class AnnotationStatusUpdate(BaseModel):
    status: AnnotationStatus


class AnnotationRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: int
    frame_id: int
    label_id: int
    taxonomy_version: int
    annotation_type: AnnotationType
    status: AnnotationStatus
    created_by_id: int
    reviewed_by_id: int | None
    mask_url: str | None = None
    job_id: int | None = None
    mask_postprocess_strength: float | None = None
