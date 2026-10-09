import enum
from datetime import datetime, timezone

from sqlalchemy import (
    JSON,
    Boolean,
    DateTime,
    Enum,
    ForeignKey,
    Integer,
    String,
    Text,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.datasets.models import TaskType
from app.db import Base


class TrainingRunStatus(str, enum.Enum):
    """Deliberately parallel to JobStatus rather than reusing it: a run can
    end as STOPPED, which is neither success nor failure, and widening an
    enum shared by every job type to serve one of them is worse than a
    neighbouring enum."""

    PENDING = "pending"
    RUNNING = "running"
    SUCCEEDED = "succeeded"
    FAILED = "failed"
    STOPPED = "stopped"


class TrainingRun(Base):
    """One attempt at training, successful or not.

    Kept separate from ModelVersion because a run that dies in epoch three
    still belongs in the history table while having no weights at all.
    """

    __tablename__ = "training_runs"

    id: Mapped[int] = mapped_column(primary_key=True)
    dataset_id: Mapped[int] = mapped_column(ForeignKey("datasets.id"))
    job_id: Mapped[int | None] = mapped_column(ForeignKey("jobs.id"), nullable=True)
    adapter: Mapped[str] = mapped_column(String(100))
    base_model: Mapped[str] = mapped_column(String(200))
    # Set when the run starts from an earlier ModelVersion (fine-tuning);
    # base_model then holds that version's name as a readable label. No
    # ondelete cascade on purpose: deleting a parent that a run was trained
    # from is refused by the service (409), so lineage never dangles.
    base_model_version_id: Mapped[int | None] = mapped_column(
        ForeignKey("model_versions.id"), nullable=True
    )
    # Free-form labels the person gives a run so the history stays readable
    # ("why did I run this?"). Never used by the trainer.
    name: Mapped[str | None] = mapped_column(String(200), nullable=True)
    note: Mapped[str | None] = mapped_column(Text, nullable=True)
    task_type: Mapped[TaskType] = mapped_column(Enum(TaskType))
    config: Mapped[dict] = mapped_column(JSON, default=dict)
    status: Mapped[TrainingRunStatus] = mapped_column(
        Enum(TrainingRunStatus), default=TrainingRunStatus.PENDING
    )
    stop_requested: Mapped[bool] = mapped_column(Boolean, default=False)
    # Appended in chunks by the worker (~2s or ~20 lines), never per line.
    log_text: Mapped[str] = mapped_column(Text, default="")
    metrics: Mapped[dict] = mapped_column(JSON, default=dict)
    # Per-epoch points, appended as training runs. Lives on the run rather
    # than the model because a run that dies at epoch 12 has no
    # ModelVersion at all, and those 12 points are what it left behind.
    metrics_history: Mapped[list] = mapped_column(JSON, default=list)
    # Facts of the experiment, copied from the trainer's result: they belong to
    # the run, not to its weights, so deleting a model never erases them.
    per_class_metrics: Mapped[list] = mapped_column(JSON, default=list)
    confusion_matrix: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    current_epoch: Mapped[int] = mapped_column(Integer, default=0)
    total_epochs: Mapped[int] = mapped_column(Integer)
    error: Mapped[str | None] = mapped_column(String(2000), nullable=True)
    created_by_id: Mapped[int] = mapped_column(ForeignKey("users.id"))
    started_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    finished_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=lambda: datetime.now(timezone.utc)
    )
    # Read-only view of the model this run produced (zero or one in practice).
    # foreign_keys is required: runs and versions also reference each other
    # through base_model_version_id.
    model_versions: Mapped[list["ModelVersion"]] = relationship(
        "ModelVersion", foreign_keys="ModelVersion.training_run_id", viewonly=True
    )

    @property
    def model_version_id(self) -> int | None:
        return self.model_versions[0].id if self.model_versions else None


class ModelVersion(Base):
    """Trained weights worth keeping. Created only when a run reaches
    SUCCEEDED or STOPPED -- the Results screen reads this table and never
    needs to know that training exists."""

    __tablename__ = "model_versions"

    id: Mapped[int] = mapped_column(primary_key=True)
    training_run_id: Mapped[int] = mapped_column(ForeignKey("training_runs.id", ondelete="CASCADE"))
    name: Mapped[str] = mapped_column(String(200))
    task_type: Mapped[TaskType] = mapped_column(Enum(TaskType))
    storage_key: Mapped[str] = mapped_column(String(500))
    metrics: Mapped[dict] = mapped_column(JSON, default=dict)
    # Per-class rows in the trainer's own vocabulary, [{"class": ...}, ...].
    per_class_metrics: Mapped[list] = mapped_column(JSON, default=list)
    # {"labels": [...], "matrix": [[int, ...]]} -- numbers, not a picture,
    # so a trainer that ships no PNG renders the same as one that does.
    confusion_matrix: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    # Keys of the trainer's own files in object storage. Deleted with this
    # row -- see delete_model_version.
    artifact_keys: Mapped[list] = mapped_column(JSON, default=list)
    is_active: Mapped[bool] = mapped_column(Boolean, default=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=lambda: datetime.now(timezone.utc)
    )

    training_run: Mapped["TrainingRun"] = relationship(
        foreign_keys=[training_run_id], lazy="joined"
    )

    @property
    def base_model(self) -> str:
        return self.training_run.base_model

    @property
    def base_model_version_id(self) -> int | None:
        return self.training_run.base_model_version_id
