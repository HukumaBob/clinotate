from datetime import datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator

from app.datasets.models import TaskType
from app.training.models import TrainingRunStatus


class TrainingRunCreate(BaseModel):
    dataset_id: int
    # Exactly one of base_model / base_model_version_id: a pretrained
    # weights name, or an earlier ModelVersion to fine-tune from.
    base_model: str | None = Field(default=None, min_length=1, max_length=200)
    base_model_version_id: int | None = None
    # Bounded rather than free-form: an accidental 100000-epoch run would
    # hold this single-GPU host's only worker for days.
    epochs: int = Field(ge=1, le=1000)
    batch: int = Field(ge=1, le=256)
    imgsz: int = Field(default=640, ge=32, le=4096)
    advanced: dict = Field(default_factory=dict)

    @model_validator(mode="after")
    def _exactly_one_base(self):
        if (self.base_model is None) == (self.base_model_version_id is None):
            raise ValueError("Provide exactly one of base_model and base_model_version_id")
        return self


class TrainingRunRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    dataset_id: int
    job_id: int | None
    adapter: str
    base_model: str
    base_model_version_id: int | None
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
    base_model: str
    base_model_version_id: int | None
    task_type: TaskType
    metrics: dict
    is_active: bool
    created_at: datetime


class ModelDownloadRead(BaseModel):
    download_url: str


class ArtifactRead(BaseModel):
    """One trainer-written file, addressed by index rather than by key so
    a storage key never travels in a URL."""

    name: str
    index: int


class ModelMetricsRead(BaseModel):
    """Everything the Info panel draws, in one request.

    Deliberately not folded into ModelVersionRead: the models list is
    polled, and a 180-class confusion matrix is ~130 KB per row -- the
    same reason log_text is not part of TrainingRunRead.
    """

    metrics: dict
    history: list[dict]
    per_class: list[dict]
    confusion: dict | None
    artifacts: list[ArtifactRead]


class BaseModelOption(BaseModel):
    kind: Literal["pretrained", "model_version"]
    weights: str | None
    label: str
    family: str | None
    size: str | None
    note: str | None
    model_version_id: int | None
