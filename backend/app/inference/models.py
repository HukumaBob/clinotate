import enum
from datetime import datetime, timezone

from sqlalchemy import DateTime, Enum, ForeignKey, Integer, String, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column

from app.db import Base


class InferenceRunStatus(str, enum.Enum):
    """No STOPPED: cancelling a run is out of scope for the first QC slice."""

    PENDING = "pending"
    RUNNING = "running"
    SUCCEEDED = "succeeded"
    FAILED = "failed"


class InferenceRun(Base):
    """One model applied to one video, kept so the result can be reopened.

    model_name is copied at creation and model_version_id is SET NULL on
    delete: a run must stay listable and viewable after its model is
    deleted, because the predictions JSON is self-contained.
    """

    __tablename__ = "inference_runs"

    id: Mapped[int] = mapped_column(primary_key=True)
    video_id: Mapped[int] = mapped_column(ForeignKey("videos.id"))
    model_version_id: Mapped[int | None] = mapped_column(
        ForeignKey("model_versions.id", ondelete="SET NULL"), nullable=True
    )
    model_name: Mapped[str] = mapped_column(String(200))
    job_id: Mapped[int | None] = mapped_column(ForeignKey("jobs.id"), nullable=True)
    frame_stride: Mapped[int] = mapped_column(Integer, default=1)
    status: Mapped[InferenceRunStatus] = mapped_column(
        Enum(InferenceRunStatus), default=InferenceRunStatus.PENDING
    )
    frames_total: Mapped[int] = mapped_column(Integer, default=0)
    frames_processed: Mapped[int] = mapped_column(Integer, default=0)
    predictions_key: Mapped[str | None] = mapped_column(String(500), nullable=True)
    error: Mapped[str | None] = mapped_column(String(2000), nullable=True)
    created_by_id: Mapped[int] = mapped_column(ForeignKey("users.id"))
    started_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    finished_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=lambda: datetime.now(timezone.utc)
    )


class QcFlagKind(str, enum.Enum):
    """fp: nothing real in the frame (saved as a hard negative).
    fn: a real object needs labelling (saved unannotated)."""

    FP = "fp"
    FN = "fn"


class QcFlag(Base):
    """A reviewer's mark on one processed frame of a run.

    Pending until a commit turns it into a Frame (committed_at/frame_id).
    Deleted with its run; the Sequence a commit created is not.
    """

    __tablename__ = "qc_flags"
    __table_args__ = (UniqueConstraint("run_id", "frame_index", name="uq_qc_flags_run_frame"),)

    id: Mapped[int] = mapped_column(primary_key=True)
    run_id: Mapped[int] = mapped_column(ForeignKey("inference_runs.id", ondelete="CASCADE"))
    kind: Mapped[QcFlagKind] = mapped_column(Enum(QcFlagKind))
    frame_index: Mapped[int] = mapped_column(Integer)
    timestamp_ms: Mapped[int] = mapped_column(Integer)
    note: Mapped[str | None] = mapped_column(String(500), nullable=True)
    created_by_id: Mapped[int] = mapped_column(ForeignKey("users.id"))
    committed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    frame_id: Mapped[int | None] = mapped_column(
        ForeignKey("frames.id", ondelete="SET NULL"), nullable=True
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=lambda: datetime.now(timezone.utc)
    )
