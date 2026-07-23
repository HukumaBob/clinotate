import enum
from datetime import datetime, timezone

from sqlalchemy import JSON, DateTime, Enum, ForeignKey, Integer, String
from sqlalchemy.orm import Mapped, mapped_column

from app.db import Base


class JobType(str, enum.Enum):
    SAM3_PREDICT = "sam3_predict"
    SAM3_TRACK = "sam3_track"


class JobStatus(str, enum.Enum):
    PENDING = "pending"
    RUNNING = "running"
    SUCCEEDED = "succeeded"
    FAILED = "failed"


class Job(Base):
    __tablename__ = "jobs"

    id: Mapped[int] = mapped_column(primary_key=True)
    job_type: Mapped[JobType] = mapped_column(Enum(JobType))
    status: Mapped[JobStatus] = mapped_column(Enum(JobStatus))
    progress: Mapped[int] = mapped_column(Integer)
    payload: Mapped[dict] = mapped_column(JSON)
    result_ref: Mapped[str | None] = mapped_column(String(500), nullable=True)
    error: Mapped[str | None] = mapped_column(String(2000), nullable=True)
    created_by_id: Mapped[int] = mapped_column(Integer)
    started_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    finished_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=lambda: datetime.now(timezone.utc)
    )


class Frame(Base):
    __tablename__ = "frames"

    id: Mapped[int] = mapped_column(primary_key=True)
    sequence_id: Mapped[int] = mapped_column(Integer)
    storage_key: Mapped[str] = mapped_column(String(500))
    frame_index: Mapped[int] = mapped_column(Integer)
    width: Mapped[int] = mapped_column(Integer)
    height: Mapped[int] = mapped_column(Integer)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=lambda: datetime.now(timezone.utc)
    )


class LabelType(str, enum.Enum):
    """Duplicate of backend/app/taxonomy/models.py's LabelType — member
    names must match exactly, since SQLAlchemy's Enum(str, enum.Enum)
    stores Postgres enum labels by member *name* (e.g. "MORPHOLOGICAL"),
    not by value."""

    GEOMETRIC = "geometric"
    MORPHOLOGICAL = "morphological"
    QUALITY = "quality"


class Label(Base):
    """Minimal duplicate of backend/app/taxonomy/models.py's Label — only
    the columns the ml-worker needs to read taxonomy_version for provenance
    when tagging a SAM-3 mask Annotation. Never write through this model;
    Labels are owned and created by the backend."""

    __tablename__ = "labels"

    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String(100))
    label_type: Mapped[LabelType] = mapped_column(Enum(LabelType))
    color: Mapped[str] = mapped_column(String(7), default="#FFFFFF")
    # Plain int, not a ForeignKey: ml-worker has no duplicate `procedures`
    # table mapping (it never reads/writes Procedure rows), and declaring
    # an unresolvable FK breaks SQLAlchemy's mapper configuration for the
    # whole Base metadata. The real FK constraint lives in the backend's
    # migration-owned schema; this column is read-only here.
    procedure_id: Mapped[int | None] = mapped_column(Integer, nullable=True)
    taxonomy_version: Mapped[int] = mapped_column(default=1)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=lambda: datetime.now(timezone.utc)
    )


class AnnotationType(str, enum.Enum):
    """Duplicate of backend/app/annotation/models.py's AnnotationType —
    member names must match the real Postgres enum labels exactly."""

    CLASSIFICATION = "classification"
    MASK = "mask"
    BBOX = "bbox"


class AnnotationStatus(str, enum.Enum):
    """Duplicate of backend/app/annotation/models.py's AnnotationStatus —
    member names must match the real Postgres enum labels exactly."""

    DRAFT = "draft"
    REVIEWED = "reviewed"
    REJECTED = "rejected"


class Annotation(Base):
    __tablename__ = "annotations"

    id: Mapped[int] = mapped_column(primary_key=True)
    frame_id: Mapped[int] = mapped_column(ForeignKey("frames.id"))
    label_id: Mapped[int] = mapped_column(ForeignKey("labels.id"))
    taxonomy_version: Mapped[int] = mapped_column(Integer)
    annotation_type: Mapped[AnnotationType] = mapped_column(Enum(AnnotationType))
    payload: Mapped[dict] = mapped_column(JSON)
    status: Mapped[AnnotationStatus] = mapped_column(Enum(AnnotationStatus))
    created_by_id: Mapped[int] = mapped_column(Integer)
    storage_key: Mapped[str | None] = mapped_column(String(500), nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=lambda: datetime.now(timezone.utc)
    )
