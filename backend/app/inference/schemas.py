import math
from datetime import datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, computed_field, field_validator, model_validator

from app.inference.models import InferenceRunStatus, QcFlagKind
from app.media.schemas import CropBox


# Mirrored by ml-worker/app/perturbation.py; keep the kinds in step.
PERTURBATION_RANGES = {
    "gaussian_noise": (1.0, 100.0),
    "blur": (0.5, 20.0),
    "brightness": (-100.0, 100.0),
    "jpeg": (5.0, 95.0),
}


class PerturbationSpec(BaseModel):
    kind: Literal["gaussian_noise", "blur", "brightness", "jpeg"]
    strength: float

    @model_validator(mode="after")
    def _strength_in_range(self):
        low, high = PERTURBATION_RANGES[self.kind]
        if not math.isfinite(self.strength) or not (low <= self.strength <= high):
            raise ValueError(f"{self.kind} strength must be between {low} and {high}")
        if self.kind == "brightness" and self.strength == 0:
            raise ValueError("brightness strength must not be 0")
        return self


class ClassifierSpec(BaseModel):
    model_version_id: int
    # Axis name; inferred from the taxonomy when omitted.
    name: str | None = Field(default=None, min_length=1, max_length=100)
    category_id: int | None = None

    @field_validator("name")
    @classmethod
    def _strip_name(cls, value: str | None) -> str | None:
        if value is None:
            return None
        value = value.strip()
        if not value:
            raise ValueError("Axis name must not be blank")
        return value


class InferenceRunCreate(BaseModel):
    video_id: int
    # Exactly one of these: one detection/segmentation model, or 1-6 classifiers.
    model_version_id: int | None = None
    classifiers: list[ClassifierSpec] | None = Field(default=None, min_length=1, max_length=6)
    # Upper bound is a sanity limit, not a product rule: a stride beyond
    # any plausible video length just yields frame 0.
    frame_stride: int = Field(default=1, ge=1, le=1000)
    perturbation: PerturbationSpec | None = None
    crop: CropBox | None = None

    @model_validator(mode="after")
    def _exactly_one_model_source(self):
        if (self.model_version_id is None) == (self.classifiers is None):
            raise ValueError("Give exactly one of model_version_id or classifiers")
        return self


class AxisRead(BaseModel):
    model_version_id: int | None
    model_name: str
    name: str
    category_id: int | None
    classes: list[str]


class InferenceRunRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    video_id: int
    model_version_id: int | None
    model_name: str
    job_id: int | None
    frame_stride: int
    perturbation: dict | None = None
    crop_box: dict | None = None
    axes: list[AxisRead] | None = None
    status: InferenceRunStatus
    frames_total: int
    frames_processed: int
    error: str | None
    created_at: datetime
    started_at: datetime | None
    finished_at: datetime | None
    flags_pending: int = 0
    flags_committed: int = 0

    @computed_field
    @property
    def task_type(self) -> Literal["detection", "segmentation", "classification"] | None:
        # Detection/segmentation runs carry no task column; only axes mark a classifier.
        return "classification" if self.axes else None


class PredictionsRead(BaseModel):
    download_url: str


class QcDisagreementRead(BaseModel):
    frame: int
    timestamp_ms: int
    only_a: list[str]
    only_b: list[str]


class QcCompareRead(BaseModel):
    frames: list[QcDisagreementRead]
    # Frames both documents processed.
    total: int
    disagreements: int


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
