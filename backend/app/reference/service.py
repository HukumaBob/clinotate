import json
from dataclasses import dataclass
from datetime import datetime, timezone

from botocore.exceptions import ClientError
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.auth.models import User
from app.datasets.models import Dataset, DatasetItem, TaskType
from app.media.models import Frame, Sequence, Video
from app.reference.commit import RefInterval
from app.reference.evaluation import AxisEvaluation, EvalFrame, EvalInterval, evaluate_axis
from app.reference.models import ReferenceInterval, VideoReference
from app.reference.schemas import (
    AxisEvaluationRead,
    EvalClassRead,
    EvalConfusionRead,
    EvalEpisodeRead,
    EvalErrorsRead,
    EvalLagRead,
    EvalTransitionsRead,
    EvaluationRead,
    ExposureVideoRead,
    IntervalCreate,
    IntervalUpdate,
    ReferenceAxisRead,
    ReferenceClassRead,
    ReferenceIntervalRead,
    ReferenceRead,
)
from app.inference.models import InferenceRun, InferenceRunStatus
from app.storage import StorageService
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
                orphaned=_is_orphaned(axis_labels, i),
            )
            for i in intervals
        ],
    )


def _is_orphaned(axis_labels: dict[int, set[int]], interval: ReferenceInterval) -> bool:
    """An interval no longer on its axis: the category is not an axis of the
    video's procedure, or the label is not among that axis's classes (moved to
    another category, or no longer a frame-classification label)."""
    return interval.label_id not in axis_labels.get(interval.category_id, set())


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


def _to_read(session: Session, video: Video, interval: ReferenceInterval) -> ReferenceIntervalRead:
    axis_labels = {
        axis.category_id: {c.label_id for c in axis.classes}
        for axis in build_axes(session, video.procedure_id)
    }
    return ReferenceIntervalRead(
        id=interval.id,
        video_id=interval.video_id,
        category_id=interval.category_id,
        label_id=interval.label_id,
        taxonomy_version=interval.taxonomy_version,
        start_ms=interval.start_ms,
        end_ms=interval.end_ms,
        orphaned=_is_orphaned(axis_labels, interval),
    )


def _dataset_holds_video(video_id: int, dataset_id):
    """EXISTS: the dataset holds a frame of the video (DatasetItem -> Frame -> Sequence)."""
    return (
        select(DatasetItem.id)
        .join(Frame, Frame.id == DatasetItem.frame_id)
        .join(Sequence, Sequence.id == Frame.sequence_id)
        .where(DatasetItem.dataset_id == dataset_id, Sequence.video_id == video_id)
        .exists()
    )


def _new_reference(session: Session, video_id: int) -> VideoReference:
    """A first reference row, compromised from the start when a classification
    run already trained on frames of the video (latest such run wins)."""
    from app.training.models import TrainingRun

    run_id = session.scalars(
        select(TrainingRun.id)
        .where(
            TrainingRun.task_type == TaskType.CLASSIFICATION,
            _dataset_holds_video(video_id, TrainingRun.dataset_id),
        )
        .order_by(TrainingRun.id.desc())
        .limit(1)
    ).first()
    if run_id is None:
        return VideoReference(video_id=video_id)
    return VideoReference(
        video_id=video_id,
        compromised_at=datetime.now(timezone.utc),
        compromised_by_training_run_id=run_id,
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
            session.add(_new_reference(session, video_id))
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
    return _to_read(session, video, interval)


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
    return _to_read(session, video, interval)


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
    """Flag clean reference videos whose frames a classification run trains on.

    Every existing reference row counts, even one with no intervals right now:
    it may be labeled again later and must not read clean then."""
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


class RunNotFound(Exception):
    pass


class RunNotEvaluable(Exception):
    pass


def match_axes(model_axes: list[dict], reference_axes: list[ReferenceAxisRead]) -> list[int | None]:
    """For each model axis, the index of the reference axis sharing the most
    class names (ties to the earlier one, i.e. the lower category id); None
    when no class name is shared."""
    matched: list[int | None] = []
    for model in model_axes:
        names = set(model["classes"])
        best: int | None = None
        best_shared = 0
        for i, ref in enumerate(reference_axes):
            shared = len({c.name for c in ref.classes} & names)
            if shared > best_shared:
                best, best_shared = i, shared
        matched.append(best)
    return matched


def _unmatched(name: str, frames_total: int) -> AxisEvaluationRead:
    return AxisEvaluationRead(
        name=name, matched=False, reference_category_id=None, reference_axis_name=None,
        frames_total=frames_total, frames_evaluated=0, frames_excluded=frames_total,
        accuracy=None, macro_f1=None, classes=[],
        confusion=EvalConfusionRead(labels=[], matrix=[]),
        errors=EvalErrorsRead(boundary_frames=0, interior_frames=0),
        transitions=EvalTransitionsRead(
            reference=0, model_switches=0, excess_switches=0, median_lag_ms=None,
            never_switched=0, lags=[],
        ),
        episodes=[],
    )


def _axis_read(
    name: str, axis: ReferenceAxisRead, result: AxisEvaluation
) -> AxisEvaluationRead:
    t = result.transitions
    return AxisEvaluationRead(
        name=name, matched=True, reference_category_id=axis.category_id,
        reference_axis_name=axis.name, frames_total=result.frames_total,
        frames_evaluated=result.frames_evaluated, frames_excluded=result.frames_excluded,
        accuracy=result.accuracy, macro_f1=result.macro_f1,
        classes=[EvalClassRead(**vars(c)) for c in result.classes],
        confusion=EvalConfusionRead(labels=result.labels, matrix=result.matrix),
        errors=EvalErrorsRead(**vars(result.errors)),
        transitions=EvalTransitionsRead(
            reference=t.reference, model_switches=t.model_switches,
            excess_switches=t.excess_switches, median_lag_ms=t.median_lag_ms,
            never_switched=t.never_switched,
            lags=[
                EvalLagRead(at_ms=lag.at_ms, from_=lag.from_label, to=lag.to_label,
                            lag_ms=lag.lag_ms)
                for lag in t.lags
            ],
        ),
        episodes=[EvalEpisodeRead(**vars(e)) for e in result.episodes],
    )


@dataclass
class AxisContext:
    """One model axis of a classification predictions document, read for scoring.

    `frames` are the axis's valid frames in document order; `frame_indices`
    runs parallel to them (the video frame number, from the document key,
    or None when the key is not an integer). `invalid` counts the malformed
    frames (too few axes, a class id outside the axis): excluded, never
    scored. `reference_axis` indexes `RunEvalContext.reference.axes` (None
    when no class name is shared) and `intervals` are that axis's
    non-orphaned reference intervals, named by class (empty when unmatched).
    """

    name: str
    classes: list[str]
    reference_axis: int | None
    frames: list[EvalFrame]
    frame_indices: list[int | None]
    invalid: int
    intervals: list[EvalInterval]


@dataclass
class RunEvalContext:
    """Everything a finished classification run is scored and committed from.

    `reference_intervals` are ALL non-orphaned reference intervals of the
    video, over every reference axis (not only the matched ones);
    `reference_axis_names` maps each reference axis's category id to its name.
    """

    run: InferenceRun
    video: Video
    reference: ReferenceRead
    document: dict
    axes: list[AxisContext]
    reference_intervals: list[RefInterval]
    reference_axis_names: dict[int, str]


def _frame_index(key) -> int | None:
    try:
        return int(key)
    except (TypeError, ValueError):
        return None


def build_axis_contexts(document: dict, reference: ReferenceRead) -> list[AxisContext]:
    """Read every model axis of a (skeleton-valid) predictions document."""
    model_axes = document["axes"]
    matches = match_axes(model_axes, reference.axes)
    doc_frames = list(document["frames"].items())
    contexts: list[AxisContext] = []
    for i, model_axis in enumerate(model_axes):
        classes = model_axis["classes"]
        frames: list[EvalFrame] = []
        frame_indices: list[int | None] = []
        # Malformed frames (too few axes, a class id outside the axis) are
        # excluded frames: counted, never scored.
        invalid = 0
        for key, frame in doc_frames:
            try:
                entries = frame["axes"]
                class_id = entries[i]["class_id"] if i < len(entries) else None
                if (
                    not isinstance(class_id, int)
                    or isinstance(class_id, bool)
                    or not 0 <= class_id < len(classes)
                ):
                    invalid += 1
                    continue
                frames.append(
                    EvalFrame(
                        ts_ms=frame["timestamp_ms"], predicted=classes[class_id],
                        confidence=entries[i]["confidence"],
                    )
                )
                frame_indices.append(_frame_index(key))
            except (KeyError, TypeError, IndexError):
                invalid += 1
        intervals: list[EvalInterval] = []
        if matches[i] is not None:
            ref_axis = reference.axes[matches[i]]
            label_names = {c.label_id: c.name for c in ref_axis.classes}
            intervals = [
                EvalInterval(iv.start_ms, iv.end_ms, label_names[iv.label_id])
                for iv in reference.intervals
                if not iv.orphaned and iv.category_id == ref_axis.category_id
            ]
        contexts.append(
            AxisContext(
                name=model_axis["name"], classes=classes, reference_axis=matches[i],
                frames=frames, frame_indices=frame_indices, invalid=invalid,
                intervals=intervals,
            )
        )
    return contexts


def _score_axes(
    axes: list[AxisContext], reference: ReferenceRead, boundary_ms: int
) -> list[AxisEvaluationRead]:
    results: list[AxisEvaluationRead] = []
    for axis in axes:
        if axis.reference_axis is None:
            results.append(_unmatched(axis.name, len(axis.frames) + axis.invalid))
            continue
        ref_axis = reference.axes[axis.reference_axis]
        result = evaluate_axis(
            axis.frames, axis.intervals, axis.classes, [c.name for c in ref_axis.classes],
            boundary_ms,
        )
        result.frames_total += axis.invalid
        result.frames_excluded += axis.invalid
        results.append(_axis_read(axis.name, ref_axis, result))
    return results


def evaluate_document(
    run: InferenceRun, document: dict, reference: ReferenceRead, boundary_ms: int
) -> EvaluationRead:
    """Score every axis of a classification predictions document in memory."""
    axes = build_axis_contexts(document, reference)
    return EvaluationRead(
        run_id=run.id, video_id=run.video_id, reference_status=reference.status,
        boundary_ms=boundary_ms, axes=_score_axes(axes, reference, boundary_ms),
    )


_NOT_FOUND_CODES = {"NoSuchKey", "404", "NotFound"}


def _is_valid_document(document) -> bool:
    """The skeleton evaluate_document relies on; single frames are checked there."""
    if not isinstance(document, dict):
        return False
    axes, frames = document.get("axes"), document.get("frames")
    if not isinstance(axes, list) or not isinstance(frames, dict):
        return False
    return all(
        isinstance(a, dict) and isinstance(a.get("name"), str) and isinstance(a.get("classes"), list)
        for a in axes
    )


def load_run_eval_context(
    session: Session, storage: StorageService, run_id: int
) -> RunEvalContext:
    """Load and validate what scoring (and committing) a run needs.

    Raises `RunNotFound` (no such run), `VideoNotFound` (its video is gone),
    and `RunNotEvaluable` when the run is not finished, has no stored
    predictions, is not a classification run, its video has no non-orphaned
    reference interval, the predictions object is gone, or the document is
    not valid. Any other storage error propagates.
    """
    run = session.get(InferenceRun, run_id)
    if run is None:
        raise RunNotFound(f"Inference run {run_id} not found")
    if run.status != InferenceRunStatus.SUCCEEDED:
        raise RunNotEvaluable(f"Run {run_id} is {run.status.value}, not finished")
    if not run.predictions_key:
        raise RunNotEvaluable(f"Run {run_id} has no stored predictions")
    if run.axes is None:
        raise RunNotEvaluable(f"Run {run_id} is not a classification run")
    reference = get_reference(session, run.video_id)
    if not any(not iv.orphaned for iv in reference.intervals):
        raise RunNotEvaluable("The video has no reference intervals to score against")
    try:
        raw = storage.download(run.predictions_key)
    except ClientError as exc:
        # Only a missing object is a 409; anything else (outage, credentials,
        # timeout) is an infrastructure failure and propagates as a 5xx.
        code = str(exc.response.get("Error", {}).get("Code", ""))
        if code not in _NOT_FOUND_CODES:
            raise
        raise RunNotEvaluable(f"Predictions of run {run_id} are no longer stored") from exc
    invalid = RunNotEvaluable(f"Predictions of run {run_id} are not a valid document")
    try:
        document = json.loads(raw)
    except ValueError as exc:  # includes UnicodeDecodeError
        raise invalid from exc
    if not _is_valid_document(document):
        raise invalid
    return RunEvalContext(
        run=run,
        video=session.get(Video, run.video_id),
        reference=reference,
        document=document,
        axes=build_axis_contexts(document, reference),
        reference_intervals=[
            RefInterval(iv.category_id, iv.label_id, iv.start_ms, iv.end_ms)
            for iv in reference.intervals
            if not iv.orphaned
        ],
        reference_axis_names={axis.category_id: axis.name for axis in reference.axes},
    )


def evaluate_run(
    session: Session, storage: StorageService, run_id: int, boundary_ms: int
) -> EvaluationRead:
    context = load_run_eval_context(session, storage, run_id)
    return EvaluationRead(
        run_id=context.run.id, video_id=context.run.video_id,
        reference_status=context.reference.status, boundary_ms=boundary_ms,
        axes=_score_axes(context.axes, context.reference, boundary_ms),
    )
