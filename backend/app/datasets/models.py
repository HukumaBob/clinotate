import enum
from datetime import datetime, timezone

from sqlalchemy import JSON, DateTime, Enum, ForeignKey, String
from sqlalchemy.orm import Mapped, mapped_column

from app.db import Base


class TaskType(str, enum.Enum):
    DETECTION = "detection"
    SEGMENTATION = "segmentation"
    CLASSIFICATION = "classification"


class SplitName(str, enum.Enum):
    TRAIN = "train"
    VAL = "val"
    TEST = "test"


class Dataset(Base):
    __tablename__ = "datasets"

    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String(200))
    task_type: Mapped[TaskType] = mapped_column(Enum(TaskType))
    # Pinned at creation, like Annotation's: records which taxonomy this
    # dataset belongs to. Grouping itself stays live -- a rebuild picks up
    # current parent edges. Provenance and behaviour are separate questions.
    taxonomy_version: Mapped[int] = mapped_column()
    split_config: Mapped[dict] = mapped_column(JSON, default=dict)
    # Delta over the taxonomy's default grouping: {"collapse": [...], "expand": [...]}
    grouping_overrides: Mapped[dict] = mapped_column(JSON, default=dict)
    excluded_label_ids: Mapped[list] = mapped_column(JSON, default=list)
    class_limits: Mapped[dict] = mapped_column(JSON, default=dict)
    balance_metrics: Mapped[dict] = mapped_column(JSON, default=dict)
    created_by_id: Mapped[int] = mapped_column(ForeignKey("users.id"))
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=lambda: datetime.now(timezone.utc)
    )


class DatasetItem(Base):
    __tablename__ = "dataset_items"

    id: Mapped[int] = mapped_column(primary_key=True)
    dataset_id: Mapped[int] = mapped_column(ForeignKey("datasets.id", ondelete="CASCADE"))
    frame_id: Mapped[int] = mapped_column(ForeignKey("frames.id"))
    annotation_ids: Mapped[list] = mapped_column(JSON, default=list)
    split: Mapped[SplitName] = mapped_column(Enum(SplitName))
