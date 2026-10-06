from datetime import datetime

from pydantic import BaseModel, ConfigDict, Field

from app.inference.models import InferenceRunStatus


class InferenceRunCreate(BaseModel):
    video_id: int
    model_version_id: int
    # Upper bound is a sanity limit, not a product rule: a stride beyond
    # any plausible video length just yields frame 0.
    frame_stride: int = Field(default=1, ge=1, le=1000)


class InferenceRunRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    video_id: int
    model_version_id: int | None
    model_name: str
    job_id: int | None
    frame_stride: int
    status: InferenceRunStatus
    frames_total: int
    frames_processed: int
    error: str | None
    created_at: datetime
    started_at: datetime | None
    finished_at: datetime | None


class PredictionsRead(BaseModel):
    download_url: str
