from datetime import datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from app.datasets.models import TaskType
from app.training.models import TrainingRunStatus


def _clean_text(value: str | None) -> str | None:
    if value is None:
        return None
    value = value.strip()
    return value or None


class TrainingRunCreate(BaseModel):
    # Unknown keys are a 422: a stale client posting the removed top-level
    # epochs/batch/imgsz fields must not silently start a default run.
    model_config = ConfigDict(extra="forbid")

    dataset_id: int
    # Exactly one of base_model / base_model_version_id: a pretrained
    # weights name, or an earlier ModelVersion to fine-tune from.
    base_model: str | None = Field(default=None, min_length=1, max_length=200)
    base_model_version_id: int | None = None
    name: str | None = Field(default=None, max_length=200)
    note: str | None = Field(default=None, max_length=5000)
    # Validated against the adapter's schema (app.training.params); an unknown
    # key, an out-of-range value or a key the task does not use is a 422.
    settings: dict = Field(default_factory=dict)

    @model_validator(mode="after")
    def _exactly_one_base(self):
        if (self.base_model is None) == (self.base_model_version_id is None):
            raise ValueError("Provide exactly one of base_model and base_model_version_id")
        return self

    @field_validator("name", "note")
    @classmethod
    def _blank_is_none(cls, value: str | None) -> str | None:
        return _clean_text(value)


class TrainingRunUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    name: str | None = Field(default=None, max_length=200)
    note: str | None = Field(default=None, max_length=5000)

    @field_validator("name", "note")
    @classmethod
    def _blank_is_none(cls, value: str | None) -> str | None:
        return _clean_text(value)


class SettingFieldRead(BaseModel):
    key: str
    label: str
    type: Literal["int", "float", "bool", "choice"]
    default: bool | int | float | str | None
    help: str
    min: float | None
    max: float | None
    step: float | None
    choices: list[str] | None
    optional: bool


class SettingGroupRead(BaseModel):
    id: str
    label: str
    fields: list[SettingFieldRead]


class PresetRead(BaseModel):
    id: str
    label: str
    description: str
    values: dict[str, bool | int | float | str]


class SettingsSchemaRead(BaseModel):
    groups: list[SettingGroupRead]
    presets: list[PresetRead]


class TrainingRunRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    dataset_id: int
    job_id: int | None
    adapter: str
    base_model: str
    base_model_version_id: int | None
    name: str | None
    note: str | None
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
