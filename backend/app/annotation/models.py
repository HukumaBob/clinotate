import enum
from datetime import datetime, timezone

from sqlalchemy import JSON, DateTime, Enum, ForeignKey, Integer, String
from sqlalchemy.orm import Mapped, mapped_column

from app.db import Base


class AnnotationType(str, enum.Enum):
    CLASSIFICATION = "classification"
    MASK = "mask"
    BBOX = "bbox"


class AnnotationStatus(str, enum.Enum):
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
    payload: Mapped[dict] = mapped_column(JSON, default=dict)
    status: Mapped[AnnotationStatus] = mapped_column(Enum(AnnotationStatus), default=AnnotationStatus.DRAFT)
    created_by_id: Mapped[int] = mapped_column(ForeignKey("users.id"))
    reviewed_by_id: Mapped[int | None] = mapped_column(ForeignKey("users.id"), nullable=True)
    storage_key: Mapped[str | None] = mapped_column(String(500), nullable=True)
    # The untouched SAM2 mask output, written once at Annotation-creation
    # time by ml-worker's tasks.py and never overwritten afterward.
    # `storage_key` is always the CURRENT post-processed mask (may equal
    # this value if post-processing strength is 0); this column is what
    # both the default-apply step (jobs/router.py's get_job) and the
    # per-mask re-apply endpoint (PATCH .../mask-postprocess) re-derive
    # from. NULL for annotations created before this column existed, and
    # for SAM3 annotations (post-processing is SAM2-only for now) -- see
    # docs/superpowers/specs/2026-08-11-mask-postprocessing-design.md.
    raw_mask_storage_key: Mapped[str | None] = mapped_column(String(500), nullable=True)
    job_id: Mapped[int | None] = mapped_column(ForeignKey("jobs.id"), nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=lambda: datetime.now(timezone.utc)
    )
