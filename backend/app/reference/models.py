from datetime import datetime, timezone

from sqlalchemy import DateTime, ForeignKey, Index, Integer
from sqlalchemy.orm import Mapped, mapped_column

from app.db import Base


def _now() -> datetime:
    return datetime.now(timezone.utc)


class ReferenceInterval(Base):
    """A hand-labeled span of one video where one class of one category holds.

    taxonomy_version is copied from the label at creation. Videos are
    RESTRICTed on delete so a reference can never vanish silently.
    """

    __tablename__ = "reference_intervals"
    __table_args__ = (Index("ix_reference_intervals_video_category_start", "video_id", "category_id", "start_ms"),)

    id: Mapped[int] = mapped_column(primary_key=True)
    video_id: Mapped[int] = mapped_column(ForeignKey("videos.id", ondelete="RESTRICT"))
    category_id: Mapped[int] = mapped_column(ForeignKey("categories.id"))
    label_id: Mapped[int] = mapped_column(ForeignKey("labels.id"))
    taxonomy_version: Mapped[int] = mapped_column(Integer)
    start_ms: Mapped[int] = mapped_column(Integer)
    end_ms: Mapped[int] = mapped_column(Integer)
    created_by_id: Mapped[int] = mapped_column(ForeignKey("users.id"))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now, onupdate=_now)


class VideoReference(Base):
    """Per-video reference state: whether training has seen this video.

    compromised_by_training_run_id is deliberately a plain integer, not a
    foreign key: the origin must outlive deleting the run.
    """

    __tablename__ = "video_references"

    video_id: Mapped[int] = mapped_column(
        ForeignKey("videos.id", ondelete="RESTRICT"), primary_key=True
    )
    compromised_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    compromised_by_training_run_id: Mapped[int | None] = mapped_column(Integer, nullable=True)
