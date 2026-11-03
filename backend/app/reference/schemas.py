from datetime import datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator


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


class EvalClassRead(BaseModel):
    name: str
    support: int
    tp: int
    fp: int
    fn: int
    precision: float | None
    recall: float | None
    f1: float | None


class EvalConfusionRead(BaseModel):
    labels: list[str]
    matrix: list[list[int]]


class EvalErrorsRead(BaseModel):
    boundary_frames: int
    interior_frames: int


class EvalLagRead(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    at_ms: int
    from_: str = Field(alias="from")
    to: str
    lag_ms: int | None


class EvalTransitionsRead(BaseModel):
    reference: int
    model_switches: int
    excess_switches: int
    median_lag_ms: float | None
    never_switched: int
    lags: list[EvalLagRead]


class EvalEpisodeRead(BaseModel):
    start_ms: int
    end_ms: int
    frames: int
    truth: str
    predicted: str
    kind: Literal["boundary", "interior"]
    mean_confidence: float
    max_confidence: float


class AxisEvaluationRead(BaseModel):
    name: str
    matched: bool
    reference_category_id: int | None
    reference_axis_name: str | None
    frames_total: int
    frames_evaluated: int
    frames_excluded: int
    accuracy: float | None
    macro_f1: float | None
    classes: list[EvalClassRead]
    confusion: EvalConfusionRead
    errors: EvalErrorsRead
    transitions: EvalTransitionsRead
    episodes: list[EvalEpisodeRead]


class EvaluationRead(BaseModel):
    run_id: int
    video_id: int
    reference_status: Literal["none", "clean", "compromised"]
    boundary_ms: int
    axes: list[AxisEvaluationRead]
