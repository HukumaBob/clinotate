from datetime import datetime, timezone

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.auth.models import User
from app.datasets.models import Dataset, DatasetItem, TaskType
from app.media.models import Frame, Sequence, Video
from app.reference.models import ReferenceInterval, VideoReference
from app.reference.schemas import (
    ExposureVideoRead,
    IntervalCreate,
    IntervalUpdate,
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


class NoReference(Exception):
    pass


class IntervalNotFound(Exception):
    pass


class InvalidInterval(Exception):
    pass


class IntervalOverlap(Exception):
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


def _lock_video(session: Session, video_id: int) -> Video:
    """Lock the video row so concurrent interval writes on it serialize."""
    video = session.get(Video, video_id, with_for_update=True)
    if video is None:
        raise VideoNotFound(f"Video {video_id} not found")
    return video


def _category_of(session: Session, video: Video, label_id: int) -> int:
    for axis in build_axes(session, video.procedure_id):
        if any(c.label_id == label_id for c in axis.classes):
            return axis.category_id
    raise InvalidInterval(
        f"Label {label_id} is not a frame-classification label of this video's procedure"
    )


def _check_span(video: Video, start_ms: int, end_ms: int) -> None:
    if end_ms <= start_ms:
        raise InvalidInterval("end_ms must be greater than start_ms")
    if end_ms - start_ms < MIN_INTERVAL_MS:
        raise InvalidInterval(f"An interval must be at least {MIN_INTERVAL_MS} ms long")
    if start_ms < 0 or end_ms > round(video.duration_seconds * 1000):
        raise InvalidInterval("An interval must lie within the video")


def _check_overlap(
    session: Session, video_id: int, category_id: int, start_ms: int, end_ms: int,
    exclude_id: int | None = None,
) -> None:
    query = select(ReferenceInterval.id).where(
        ReferenceInterval.video_id == video_id,
        ReferenceInterval.category_id == category_id,
        ReferenceInterval.start_ms < end_ms,
        ReferenceInterval.end_ms > start_ms,
    )
    if exclude_id is not None:
        query = query.where(ReferenceInterval.id != exclude_id)
    if session.scalars(query.limit(1)).first() is not None:
        raise IntervalOverlap("The interval overlaps another interval of the same category")


def _to_read(interval: ReferenceInterval) -> ReferenceIntervalRead:
    return ReferenceIntervalRead(
        id=interval.id,
        video_id=interval.video_id,
        category_id=interval.category_id,
        label_id=interval.label_id,
        taxonomy_version=interval.taxonomy_version,
        start_ms=interval.start_ms,
        end_ms=interval.end_ms,
        orphaned=False,
    )


def create_interval(
    session: Session, video_id: int, payload: IntervalCreate, created_by: User
) -> ReferenceIntervalRead:
    video = _lock_video(session, video_id)
    try:
        category_id = _category_of(session, video, payload.label_id)
        _check_span(video, payload.start_ms, payload.end_ms)
        _check_overlap(session, video_id, category_id, payload.start_ms, payload.end_ms)
        label = session.get(Label, payload.label_id)
        if session.get(VideoReference, video_id) is None:
            session.add(VideoReference(video_id=video_id))
        interval = ReferenceInterval(
            video_id=video_id,
            category_id=category_id,
            label_id=label.id,
            taxonomy_version=label.taxonomy_version,
            start_ms=payload.start_ms,
            end_ms=payload.end_ms,
            created_by_id=created_by.id,
        )
        session.add(interval)
        session.commit()
    except Exception:
        session.rollback()
        raise
    return _to_read(interval)


def _get_interval(session: Session, video_id: int, interval_id: int) -> ReferenceInterval:
    interval = session.get(ReferenceInterval, interval_id)
    if interval is None or interval.video_id != video_id:
        raise IntervalNotFound(f"Interval {interval_id} not found")
    return interval


def update_interval(
    session: Session, video_id: int, interval_id: int, payload: IntervalUpdate
) -> ReferenceIntervalRead:
    video = _lock_video(session, video_id)
    try:
        interval = _get_interval(session, video_id, interval_id)
        label_id = payload.label_id if payload.label_id is not None else interval.label_id
        start_ms = payload.start_ms if payload.start_ms is not None else interval.start_ms
        end_ms = payload.end_ms if payload.end_ms is not None else interval.end_ms
        if label_id != interval.label_id:
            if _category_of(session, video, label_id) != interval.category_id:
                raise InvalidInterval("A relabel must stay within the interval's category")
            label = session.get(Label, label_id)
            interval.label_id = label.id
            interval.taxonomy_version = label.taxonomy_version
        _check_span(video, start_ms, end_ms)
        _check_overlap(session, video_id, interval.category_id, start_ms, end_ms, interval.id)
        interval.start_ms = start_ms
        interval.end_ms = end_ms
        session.commit()
    except Exception:
        session.rollback()
        raise
    return _to_read(interval)


def delete_interval(session: Session, video_id: int, interval_id: int) -> None:
    _lock_video(session, video_id)
    try:
        session.delete(_get_interval(session, video_id, interval_id))
        session.commit()
    except Exception:
        session.rollback()
        raise


def _frames_per_video(session: Session, *conditions) -> dict[int, int]:
    """Frame counts per video, over videos that have reference intervals."""
    rows = session.execute(
        select(Sequence.video_id, func.count(Frame.id))
        .select_from(Frame)
        .join(Sequence, Sequence.id == Frame.sequence_id)
        .where(Sequence.video_id.is_not(None), *conditions)
        .group_by(Sequence.video_id)
    ).all()
    return dict(rows)


def _clean_reference_exposure(session: Session, counts: dict[int, int]) -> list[ExposureVideoRead]:
    if not counts:
        return []
    rows = session.execute(
        select(Video.id, Video.title)
        .join(VideoReference, VideoReference.video_id == Video.id)
        .where(
            Video.id.in_(counts),
            VideoReference.compromised_at.is_(None),
            select(ReferenceInterval.id)
            .where(ReferenceInterval.video_id == Video.id)
            .exists(),
        )
        .order_by(Video.id)
    ).all()
    return [ExposureVideoRead(video_id=vid, title=title, frames=counts[vid]) for vid, title in rows]


def exposure_for_sequences(
    session: Session, sequence_ids: list[int], task_type: TaskType
) -> list[ExposureVideoRead]:
    if task_type != TaskType.CLASSIFICATION or not sequence_ids:
        return []
    return _clean_reference_exposure(
        session, _frames_per_video(session, Frame.sequence_id.in_(sequence_ids))
    )


def exposure_for_dataset(session: Session, dataset_id: int) -> list[ExposureVideoRead]:
    dataset = session.get(Dataset, dataset_id)
    if dataset is None or dataset.task_type != TaskType.CLASSIFICATION:
        return []
    item_frames = select(DatasetItem.frame_id).where(DatasetItem.dataset_id == dataset_id)
    return _clean_reference_exposure(session, _frames_per_video(session, Frame.id.in_(item_frames)))


def mark_compromised(session: Session, dataset_id: int, run_id: int) -> list[int]:
    """Flag clean reference videos whose frames a classification run trains on."""
    from app.training.models import TrainingRun

    run = session.get(TrainingRun, run_id)
    if run is None or run.task_type != TaskType.CLASSIFICATION:
        return []
    item_frames = select(DatasetItem.frame_id).where(DatasetItem.dataset_id == dataset_id)
    video_ids = list(_frames_per_video(session, Frame.id.in_(item_frames)))
    if not video_ids:
        return []
    references = session.scalars(
        select(VideoReference)
        .where(
            VideoReference.video_id.in_(video_ids),
            VideoReference.compromised_at.is_(None),
            select(ReferenceInterval.id)
            .where(ReferenceInterval.video_id == VideoReference.video_id)
            .exists(),
        )
        .with_for_update()
    ).all()
    now = datetime.now(timezone.utc)
    for reference in references:
        reference.compromised_at = now
        reference.compromised_by_training_run_id = run_id
    session.commit()
    return sorted(r.video_id for r in references)


def restore_clean(session: Session, video_id: int) -> None:
    if session.get(Video, video_id) is None:
        raise VideoNotFound(f"Video {video_id} not found")
    reference = session.get(VideoReference, video_id)
    if reference is None:
        raise NoReference(f"Video {video_id} has no reference")
    reference.compromised_at = None
    reference.compromised_by_training_run_id = None
    session.commit()
