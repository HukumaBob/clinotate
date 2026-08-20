from datetime import datetime

from pydantic import BaseModel, ConfigDict, Field

from app.datasets.models import TaskType
from app.training.models import TrainingRunStatus


class TrainingRunCreate(BaseModel):
    dataset_id: int
    base_model: str = Field(min_length=1, max_length=200)
    # Bounded rather than free-form: an accidental 100000-epoch run would
    # hold this single-GPU host's only worker for days.
    epochs: int = Field(ge=1, le=1000)
    batch: int = Field(ge=1, le=256)
    imgsz: int = Field(default=640, ge=32, le=4096)
    advanced: dict = Field(default_factory=dict)


class TrainingRunRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    dataset_id: int
    job_id: int | None
    adapter: str
    base_model: str
    task_type: TaskType
    config: dict
    status: TrainingRunStatus
    stop_requested: bool
    metrics: dict
    current_epoch: int
    total_epochs: int
    error: str | None
    created_at: datetime
    started_at: datetime | None
    finished_at: datetime | None


class TrainingLogRead(BaseModel):
    """The log tail past a caller-supplied offset. Never bundled into
    TrainingRunRead: over an hour log_text grows to megabytes, and the
    status is polled every two seconds."""

    text: str
    offset: int
    status: TrainingRunStatus


class ModelVersionRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    training_run_id: int
    name: str
    task_type: TaskType
    metrics: dict
    is_active: bool
    created_at: datetime


class ModelDownloadRead(BaseModel):
    download_url: str
