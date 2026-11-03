from sqlalchemy import select
from sqlalchemy.orm import Session

from app.media.models import Video
from app.reference.models import ReferenceInterval, VideoReference
from app.reference.schemas import (
    ReferenceAxisRead,
    ReferenceClassRead,
    ReferenceIntervalRead,
    ReferenceRead,
)
from app.taxonomy.models import Category, EvaluationType, Label

MIN_INTERVAL_MS = 100
FRAME_CLASSIFICATION = "frame_classification"
# One running sequence over all axes: 1..9, then 0.
DIGIT_KEYS = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "0"]


class VideoNotFound(Exception):
    pass


def build_axes(session: Session, procedure_id: int | None) -> list[ReferenceAxisRead]:
    if procedure_id is None:
        return []
    rows = session.execute(
        select(Category.id, Category.name, Label.id, Label.name)
        .join(Label, Label.category_id == Category.id)
        .join(EvaluationType, EvaluationType.id == Label.evaluation_type_id)
        .where(Category.procedure_id == procedure_id, EvaluationType.name == FRAME_CLASSIFICATION)
        .order_by(Category.id, Label.id)
    ).all()
    axes: list[ReferenceAxisRead] = []
    position = 0
    for category_id, category_name, label_id, label_name in rows:
        if not axes or axes[-1].category_id != category_id:
            axes.append(ReferenceAxisRead(category_id=category_id, name=category_name, classes=[]))
        key = DIGIT_KEYS[position] if position < len(DIGIT_KEYS) else None
        position += 1
        axes[-1].classes.append(ReferenceClassRead(label_id=label_id, name=label_name, key=key))
    return axes


def get_reference(session: Session, video_id: int) -> ReferenceRead:
    video = session.get(Video, video_id)
    if video is None:
        raise VideoNotFound(f"Video {video_id} not found")
    axes = build_axes(session, video.procedure_id)
    axis_labels = {axis.category_id: {c.label_id for c in axis.classes} for axis in axes}
    intervals = session.scalars(
        select(ReferenceInterval)
        .where(ReferenceInterval.video_id == video_id)
        .order_by(ReferenceInterval.category_id, ReferenceInterval.start_ms, ReferenceInterval.id)
    ).all()
    label_categories = {}
    label_ids = {i.label_id for i in intervals}
    if label_ids:
        label_categories = dict(
            session.execute(select(Label.id, Label.category_id).where(Label.id.in_(label_ids))).all()
        )
    reference = session.get(VideoReference, video_id)
    compromised_at = reference.compromised_at if reference else None
    if compromised_at is not None:
        status = "compromised"
    elif intervals:
        status = "clean"
    else:
        status = "none"
    return ReferenceRead(
        video_id=video.id,
        procedure_id=video.procedure_id,
        duration_ms=round(video.duration_seconds * 1000),
        status=status,
        compromised_at=compromised_at,
        compromised_by_training_run_id=(
            reference.compromised_by_training_run_id if reference else None
        ),
        axes=axes,
        intervals=[
            ReferenceIntervalRead(
                id=i.id,
                video_id=i.video_id,
                category_id=i.category_id,
                label_id=i.label_id,
                taxonomy_version=i.taxonomy_version,
                start_ms=i.start_ms,
                end_ms=i.end_ms,
                orphaned=(
                    label_categories.get(i.label_id) != i.category_id
                    or i.category_id not in axis_labels
                ),
            )
            for i in intervals
        ],
    )
