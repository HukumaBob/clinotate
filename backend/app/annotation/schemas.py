from pydantic import BaseModel, ConfigDict, Field

from app.annotation.models import AnnotationStatus, AnnotationType


class AnnotationCreate(BaseModel):
    label_id: int


class AnnotationStatusUpdate(BaseModel):
    status: AnnotationStatus


class MaskPostprocessUpdate(BaseModel):
    strength: float = Field(ge=0.0, le=1.0)


class BulkClassifyRequest(BaseModel):
    frame_ids: list[int]
    label_id: int


class BulkClassifyResult(BaseModel):
    frame_ids: list[int]


class BulkClearClassificationRequest(BaseModel):
    frame_ids: list[int]
    category_id: int
    evaluation_type_id: int


class BulkMarkNoFindingsRequest(BaseModel):
    frame_ids: list[int]


class BulkMarkNoFindingsResult(BaseModel):
    marked_frame_ids: list[int]
    skipped_frame_ids: list[int]


class BulkClearNoFindingsRequest(BaseModel):
    frame_ids: list[int]


class BulkClearNoFindingsResult(BaseModel):
    frame_ids: list[int]


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
