from datetime import datetime

from pydantic import BaseModel, ConfigDict, Field

from app.inference.models import InferenceRunStatus, QcFlagKind


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
    flags_pending: int = 0
    flags_committed: int = 0


class PredictionsRead(BaseModel):
    download_url: str


class QcFlagPut(BaseModel):
    frame_index: int = Field(ge=0)
    timestamp_ms: int = Field(ge=0)
    kind: QcFlagKind
    note: str | None = Field(default=None, max_length=500)


class QcFlagRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    run_id: int
    kind: QcFlagKind
    frame_index: int
    timestamp_ms: int
    note: str | None
    created_by_id: int
    committed_at: datetime | None
    frame_id: int | None
    # The sequence of the committed frame; None while pending.
    sequence_id: int | None = None


class QcCommitRequest(BaseModel):
    name: str | None = Field(default=None, max_length=255)


class VideoSentRead(BaseModel):
    sequences: int
    frames: int
