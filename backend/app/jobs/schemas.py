from datetime import datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict

from app.jobs.models import JobStatus, JobType


class JobRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    job_type: JobType
    status: JobStatus
    progress: int
    result_ref: str | None
    error: str | None
    created_by_id: int
    started_at: datetime | None
    finished_at: datetime | None


class PromptIn(BaseModel):
    type: Literal["point", "box"]
    coords: list[float]
    label: bool = True


class Sam3PredictRequest(BaseModel):
    frame_id: int
    label_id: int
    prompts: list[PromptIn]


class Sam3TrackRequest(BaseModel):
    sequence_id: int
    label_id: int
    prompts: list[PromptIn]
