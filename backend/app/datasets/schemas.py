from datetime import datetime

from pydantic import BaseModel, ConfigDict, Field, field_validator

from app.datasets.models import SplitName, TaskType


class GroupingOverrides(BaseModel):
    collapse: list[int] = Field(default_factory=list)
    expand: list[int] = Field(default_factory=list)


class BalanceRequest(BaseModel):
    sequence_ids: list[int] = Field(default_factory=list)
    task_type: TaskType
    grouping_overrides: GroupingOverrides = Field(default_factory=GroupingOverrides)
    excluded_label_ids: list[int] = Field(default_factory=list)
    threshold: int = 10


class ClassCountRead(BaseModel):
    label_id: int
    name: str
    instances: int
    frames: int


class BalanceReportRead(BaseModel):
    classes: list[ClassCountRead]
    total_frames: int
    negative_frames: int
    below_threshold: list[str]
    threshold: int
    metrics: dict


class DatasetCreate(BaseModel):
    name: str
    task_type: TaskType
    sequence_ids: list[int] = Field(default_factory=list)
    split_config: dict = Field(default_factory=lambda: {"train": 70, "val": 20})
    grouping_overrides: GroupingOverrides = Field(default_factory=GroupingOverrides)
    excluded_label_ids: list[int] = Field(default_factory=list)
    threshold: int = 10

    @field_validator("split_config")
    @classmethod
    def _validate_split_config(cls, value: dict) -> dict:
        train = value.get("train", 0)
        val = value.get("val", 0)
        if not isinstance(train, (int, float)) or not isinstance(val, (int, float)):
            raise ValueError("split_config train/val must be numbers")
        if train < 0 or val < 0:
            raise ValueError("split_config train/val must each be >= 0")
        if train + val > 100:
            raise ValueError("split_config train + val must be <= 100")
        return value


class DatasetItemRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    frame_id: int
    sequence_id: int
    split: SplitName


class DatasetRead(BaseModel):
    id: int
    name: str
    task_type: TaskType
    taxonomy_version: int
    split_config: dict
    grouping_overrides: dict
    excluded_label_ids: list[int]
    balance_metrics: dict
    created_at: datetime
    item_count: int
    split_counts: dict[str, int]
    items: list[DatasetItemRead] = Field(default_factory=list)
