from datetime import datetime
from typing import Literal

from pydantic import BaseModel, model_validator


class ReferenceClassRead(BaseModel):
    label_id: int
    name: str
    key: str | None


class ReferenceAxisRead(BaseModel):
    category_id: int
    name: str
    classes: list[ReferenceClassRead]


class ReferenceIntervalRead(BaseModel):
    id: int
    video_id: int
    category_id: int
    label_id: int
    taxonomy_version: int
    start_ms: int
    end_ms: int
    orphaned: bool


class ReferenceRead(BaseModel):
    video_id: int
    procedure_id: int | None
    duration_ms: int
    status: Literal["none", "clean", "compromised"]
    compromised_at: datetime | None
    compromised_by_training_run_id: int | None
    axes: list[ReferenceAxisRead]
    intervals: list[ReferenceIntervalRead]


class IntervalCreate(BaseModel):
    label_id: int
    start_ms: int
    end_ms: int


class IntervalUpdate(BaseModel):
    label_id: int | None = None
    start_ms: int | None = None
    end_ms: int | None = None

    @model_validator(mode="after")
    def _at_least_one_field(self):
        if not self.model_fields_set & {"label_id", "start_ms", "end_ms"}:
            raise ValueError("at least one of label_id, start_ms, end_ms is required")
        return self


class ExposureVideoRead(BaseModel):
    video_id: int
    title: str
    frames: int
