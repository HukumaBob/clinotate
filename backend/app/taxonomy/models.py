import enum
from datetime import datetime, timezone

from sqlalchemy import DateTime, Enum, ForeignKey, String, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column

from app.db import Base


class AnnotationScope(str, enum.Enum):
    FRAME = "frame"
    REGION = "region"


class Procedure(Base):
    __tablename__ = "procedures"

    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String(100), unique=True)


class Category(Base):
    __tablename__ = "categories"
    __table_args__ = (UniqueConstraint("name", "procedure_id"),)

    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String(100))
    procedure_id: Mapped[int] = mapped_column(ForeignKey("procedures.id"))


class EvaluationType(Base):
    __tablename__ = "evaluation_types"

    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String(100), unique=True)
    annotation_scope: Mapped[AnnotationScope] = mapped_column(Enum(AnnotationScope))


class Label(Base):
    __tablename__ = "labels"

    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String(100))
    color: Mapped[str] = mapped_column(String(7), default="#FFFFFF")
    category_id: Mapped[int] = mapped_column(ForeignKey("categories.id"))
    evaluation_type_id: Mapped[int] = mapped_column(ForeignKey("evaluation_types.id"))
    taxonomy_version: Mapped[int] = mapped_column(default=1)
    parent_label_id: Mapped[int | None] = mapped_column(
        ForeignKey("labels.id"), nullable=True, default=None
    )
    is_abstract: Mapped[bool] = mapped_column(default=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=lambda: datetime.now(timezone.utc)
    )
