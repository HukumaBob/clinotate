import enum
from datetime import datetime, timezone

from sqlalchemy import DateTime, Enum, Float, ForeignKey, String
from sqlalchemy.orm import Mapped, mapped_column

from app.db import Base


class LabelType(str, enum.Enum):
    GEOMETRIC = "geometric"
    MORPHOLOGICAL = "morphological"
    QUALITY = "quality"


class Procedure(Base):
    __tablename__ = "procedures"

    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String(100), unique=True)


class Label(Base):
    __tablename__ = "labels"

    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String(100))
    label_type: Mapped[LabelType] = mapped_column(Enum(LabelType))
    color: Mapped[str] = mapped_column(String(7), default="#FFFFFF")
    procedure_id: Mapped[int | None] = mapped_column(ForeignKey("procedures.id"), nullable=True)
    taxonomy_version: Mapped[int] = mapped_column(default=1)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=lambda: datetime.now(timezone.utc)
    )


class LabelRelation(Base):
    __tablename__ = "label_relations"

    id: Mapped[int] = mapped_column(primary_key=True)
    parent_id: Mapped[int] = mapped_column(ForeignKey("labels.id"))
    child_id: Mapped[int] = mapped_column(ForeignKey("labels.id"))
    confidence: Mapped[float] = mapped_column(Float, default=1.0)
