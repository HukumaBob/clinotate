from datetime import datetime
from typing import Literal

from pydantic import BaseModel


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
