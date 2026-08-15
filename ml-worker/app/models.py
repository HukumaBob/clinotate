import enum
from datetime import datetime, timezone

from sqlalchemy import JSON, BigInteger, Boolean, DateTime, Enum, ForeignKey, Integer, String
from sqlalchemy.orm import Mapped, mapped_column

from app.db import Base


class JobType(str, enum.Enum):
    SAM3_PREDICT = "sam3_predict"
    SAM3_TRACK = "sam3_track"
    SAM2_PREDICT = "sam2_predict"
    SAM2_TRACK = "sam2_track"
    RANK_QUALITY = "rank_quality"
    FIND_SIMILAR = "find_similar"


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
    vram_used_bytes: Mapped[int | None] = mapped_column(BigInteger, nullable=True)
    vram_total_bytes: Mapped[int | None] = mapped_column(BigInteger, nullable=True)
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
    size_bytes: Mapped[int] = mapped_column(Integer, default=0)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=lambda: datetime.now(timezone.utc)
    )
    no_findings_reviewed: Mapped[bool] = mapped_column(Boolean, default=False)
    # Plain int, not a ForeignKey: same reasoning as Label.category_id below
    # -- ml-worker has no duplicate `users` table mapping, and declaring an
    # unresolvable FK breaks any real ORM write to this column (verified via
    # NoReferencedTableError on session.commit()). The real FK constraint
    # lives in the backend's migration-owned schema.
    no_findings_reviewed_by_id: Mapped[int | None] = mapped_column(Integer, nullable=True)
    no_findings_reviewed_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )


class Label(Base):
    """Minimal duplicate of backend/app/taxonomy/models.py's Label — only
    the columns the ml-worker needs to read taxonomy_version for provenance
    when tagging a SAM-3 mask Annotation. Never write through this model;
    Labels are owned and created by the backend."""

    __tablename__ = "labels"

    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String(100))
    color: Mapped[str] = mapped_column(String(7), default="#FFFFFF")
    # Plain int, not a ForeignKey: ml-worker has no duplicate `categories`/
    # `evaluation_types` table mapping (it never reads/writes those rows),
    # and declaring an unresolvable FK breaks SQLAlchemy's mapper
    # configuration for the whole Base metadata. The real FK constraints
    # live in the backend's migration-owned schema; these columns are
    # read-only here.
    category_id: Mapped[int] = mapped_column(Integer)
    evaluation_type_id: Mapped[int] = mapped_column(Integer)
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
    """Minimal duplicate of backend/app/annotation/models.py's Annotation
    — only the columns the ml-worker needs to create mask annotations.
    Never read through this model for anything the backend owns
    authoritatively; created rows are read back exclusively via the
    backend's own API."""

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
    # Mirrors backend/app/annotation/models.py's raw_mask_storage_key --
    # see that file's docstring and
    # docs/superpowers/specs/2026-08-11-mask-postprocessing-design.md.
    # ml-worker always writes this equal to storage_key at creation time;
    # only backend ever changes storage_key afterward (post-processing).
    raw_mask_storage_key: Mapped[str | None] = mapped_column(String(500), nullable=True)
    # Plain int, not a ForeignKey("jobs.id"): same reasoning as
    # Label.procedure_id above — this module has no duplicate Job table
    # mapping usable as an FK target within this process's metadata.
    job_id: Mapped[int | None] = mapped_column(Integer, nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=lambda: datetime.now(timezone.utc)
    )
