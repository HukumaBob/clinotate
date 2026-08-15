import math
from dataclasses import dataclass, field

from sqlalchemy import func
from sqlalchemy.orm import Session

from app.annotation.models import Annotation
from app.datasets.models import Dataset, DatasetItem, SplitName, TaskType
from app.media.models import Frame
from app.taxonomy.hierarchy import GroupingRules, build_label_tree, resolve_class
from app.taxonomy.models import AnnotationScope, EvaluationType, Label

_SCOPE_BY_TASK = {
    TaskType.DETECTION: AnnotationScope.REGION,
    TaskType.SEGMENTATION: AnnotationScope.REGION,
    TaskType.CLASSIFICATION: AnnotationScope.FRAME,
}


@dataclass
class FrameComposition:
    frame_id: int
    annotation_ids: list[int] = field(default_factory=list)
    is_negative: bool = False


def scope_for_task(task_type: TaskType) -> AnnotationScope:
    """A classification label has no coordinates, so a detector cannot train on
    it alongside boxes. annotation_scope is what separates the two."""
    return _SCOPE_BY_TASK[task_type]


def collect_frames(
    session: Session,
    sequence_ids: list[int],
    task_type: TaskType,
    excluded_label_ids: set[int],
) -> list[FrameComposition]:
    """Frames entering a dataset: annotated-and-compatible, or flagged negative.

    A frame whose every annotation is excluded leaves the dataset entirely
    rather than becoming a negative -- excluding a class is a bookkeeping
    decision, not a claim that the frame is empty.
    """
    if not sequence_ids:
        return []

    scope = scope_for_task(task_type)

    frames = (
        session.query(Frame)
        .filter(Frame.sequence_id.in_(sequence_ids))
        .order_by(Frame.id)
        .all()
    )
    frame_ids = [frame.id for frame in frames]
    if not frame_ids:
        return []

    rows = (
        session.query(Annotation.id, Annotation.frame_id, Annotation.label_id)
        .join(Label, Label.id == Annotation.label_id)
        .join(EvaluationType, EvaluationType.id == Label.evaluation_type_id)
        .filter(Annotation.frame_id.in_(frame_ids))
        .filter(EvaluationType.annotation_scope == scope)
        .order_by(Annotation.id)
        .all()
    )

    kept_by_frame: dict[int, list[int]] = {}
    for annotation_id, frame_id, label_id in rows:
        if label_id in excluded_label_ids:
            continue
        kept_by_frame.setdefault(frame_id, []).append(annotation_id)

    composition: list[FrameComposition] = []
    for frame in frames:
        annotation_ids = kept_by_frame.get(frame.id, [])
        if annotation_ids:
            composition.append(
                FrameComposition(frame_id=frame.id, annotation_ids=annotation_ids)
            )
        elif frame.no_findings_reviewed:
            composition.append(FrameComposition(frame_id=frame.id, is_negative=True))
    return composition


@dataclass
class ClassCount:
    label_id: int
    name: str
    instances: int
    frames: int


@dataclass
class BalanceReport:
    classes: list[ClassCount]
    total_frames: int
    negative_frames: int
    below_threshold: list[str]
    threshold: int
    metrics: dict


def compute_imbalance_metrics(counts: dict[str, int]) -> dict:
    """Imbalance figures, thresholds taken from the Django reference's
    DatasetBalanceAnalyzer._assess_imbalance_severity.

    These are REFERENCE figures, not the headline. Collapsing a group raises
    imbalance_ratio (it grows the largest class while the singleton tail
    stays), so optimizing this number would push toward a few meaningless
    mega-classes. The actionable signal is BalanceReport.below_threshold.
    """
    if not counts:
        return {"severity": "no_data"}

    values = list(counts.values())
    total = sum(values)
    min_count, max_count = min(values), max(values)
    mean = total / len(values)
    variance = sum((v - mean) ** 2 for v in values) / len(values)
    std = math.sqrt(variance)

    imbalance_ratio = max_count / min_count if min_count > 0 else float("inf")

    entropy = -sum((v / total) * math.log(v / total) for v in values if v > 0)
    max_entropy = math.log(len(values)) if len(values) > 1 else 0.0
    normalized_entropy = entropy / max_entropy if max_entropy > 0 else 0.0

    ordered = sorted(values)
    n = len(ordered)
    cumulative = 0
    running_sum = 0
    for value in ordered:
        cumulative += value
        running_sum += cumulative
    gini = (n + 1 - 2 * running_sum / cumulative) / n if cumulative > 0 else 0.0

    if imbalance_ratio <= 1.5 and gini < 0.1 and min_count >= 10:
        severity = "balanced"
    elif imbalance_ratio <= 3.0 and gini < 0.3 and min_count >= 10:
        severity = "mild_imbalance"
    elif imbalance_ratio <= 10.0 and gini < 0.5 and min_count >= 10:
        severity = "moderate_imbalance"
    elif imbalance_ratio <= 100.0 or min_count < 10:
        severity = "severe_imbalance"
    else:
        severity = "extreme_imbalance"

    return {
        "min_count": min_count,
        "max_count": max_count,
        "mean_count": mean,
        "std_count": std,
        "imbalance_ratio": imbalance_ratio,
        "coefficient_of_variation": std / mean if mean > 0 else 0.0,
        "normalized_entropy": normalized_entropy,
        "gini_index": gini,
        "severity": severity,
    }


def compute_balance(
    session: Session,
    sequence_ids: list[int],
    task_type: TaskType,
    rules: GroupingRules,
    excluded_label_ids: set[int],
    threshold: int = 10,
) -> BalanceReport:
    """Live class balance for a selection. Writes nothing.

    Classes resolve through the taxonomy's shared resolve_class, so this panel
    and any future export cannot disagree about what a class is.
    """
    composition = collect_frames(session, sequence_ids, task_type, excluded_label_ids)
    negative_frames = sum(1 for item in composition if item.is_negative)

    annotation_ids = [aid for item in composition for aid in item.annotation_ids]
    if not annotation_ids:
        return BalanceReport(
            classes=[], total_frames=len(composition), negative_frames=negative_frames,
            below_threshold=[], threshold=threshold,
            metrics=compute_imbalance_metrics({}),
        )

    rows = (
        session.query(Annotation.id, Annotation.frame_id, Annotation.label_id)
        .filter(Annotation.id.in_(annotation_ids))
        .all()
    )

    tree = build_label_tree(session)
    resolved_ids = {row.label_id: resolve_class(row.label_id, tree, rules) for row in rows}
    names = {
        label.id: label.name
        for label in session.query(Label).filter(Label.id.in_(set(resolved_ids.values()))).all()
    }

    instances: dict[int, int] = {}
    frames_by_class: dict[int, set[int]] = {}
    for row in rows:
        class_id = resolved_ids[row.label_id]
        instances[class_id] = instances.get(class_id, 0) + 1
        frames_by_class.setdefault(class_id, set()).add(row.frame_id)

    classes = [
        ClassCount(
            label_id=class_id,
            name=names.get(class_id, f"label-{class_id}"),
            instances=count,
            frames=len(frames_by_class[class_id]),
        )
        for class_id, count in instances.items()
    ]
    classes.sort(key=lambda c: (-c.instances, c.name))

    below = [c.name for c in classes if c.instances < threshold]
    metrics = compute_imbalance_metrics({c.name: c.instances for c in classes})

    return BalanceReport(
        classes=classes,
        total_frames=len(composition),
        negative_frames=negative_frames,
        below_threshold=below,
        threshold=threshold,
        metrics=metrics,
    )


def assign_splits(
    sequence_ids: list[int], split_config: dict
) -> dict[int, SplitName]:
    """Assign whole sequences to splits; frames inherit their sequence's split.

    Splitting frames instead would leak -- consecutive frames of one video are
    near-duplicates, so the same image would sit on both sides of the split and
    inflate validation metrics into meaninglessness.

    With few sequences the realized fractions cannot match the requested ones
    (7 sequences at 70/20/10 lands on 71/14/14). Fill train first, then val,
    then test, and let the caller report realized counts.
    """
    ordered = sorted(sequence_ids)
    total = len(ordered)
    if total == 0:
        return {}

    train_pct = split_config.get("train", 70) / 100
    val_pct = split_config.get("val", 20) / 100

    train_n = int(total * train_pct)
    val_n = int(total * val_pct)
    # Guarantee at least one training sequence whenever anything was selected.
    if train_n == 0:
        train_n = 1
        val_n = min(val_n, max(total - train_n, 0))

    assignment: dict[int, SplitName] = {}
    for index, sequence_id in enumerate(ordered):
        if index < train_n:
            assignment[sequence_id] = SplitName.TRAIN
        elif index < train_n + val_n:
            assignment[sequence_id] = SplitName.VAL
        else:
            assignment[sequence_id] = SplitName.TEST
    return assignment


def create_dataset(session: Session, payload, user) -> Dataset:
    """Create a Dataset and freeze its frame list.

    Composition is materialized here rather than recomputed on read: otherwise
    tomorrow's annotation silently changes yesterday's dataset, and the split
    shifts with it.
    """
    rules = GroupingRules(
        collapse=frozenset(payload.grouping_overrides.collapse),
        expand=frozenset(payload.grouping_overrides.expand),
    )
    excluded = set(payload.excluded_label_ids)

    report = compute_balance(
        session, payload.sequence_ids, payload.task_type, rules, excluded, payload.threshold
    )
    composition = collect_frames(session, payload.sequence_ids, payload.task_type, excluded)

    taxonomy_version = (
        session.query(func.max(Label.taxonomy_version)).scalar() or 1
    )

    dataset = Dataset(
        name=payload.name,
        task_type=payload.task_type,
        taxonomy_version=taxonomy_version,
        split_config=payload.split_config,
        grouping_overrides=payload.grouping_overrides.model_dump(),
        excluded_label_ids=list(excluded),
        balance_metrics={
            "severity": report.metrics.get("severity"),
            "metrics": report.metrics,
            "classes": [
                {"label_id": c.label_id, "name": c.name,
                 "instances": c.instances, "frames": c.frames}
                for c in report.classes
            ],
            "below_threshold": report.below_threshold,
            "threshold": report.threshold,
            "negative_frames": report.negative_frames,
        },
        created_by_id=user.id,
    )
    session.add(dataset)
    session.flush()

    frame_ids = [item.frame_id for item in composition]
    sequence_by_frame = dict(
        session.query(Frame.id, Frame.sequence_id).filter(Frame.id.in_(frame_ids)).all()
    ) if frame_ids else {}

    split_by_sequence = assign_splits(payload.sequence_ids, payload.split_config)

    for item in composition:
        sequence_id = sequence_by_frame.get(item.frame_id)
        session.add(
            DatasetItem(
                dataset_id=dataset.id,
                frame_id=item.frame_id,
                annotation_ids=item.annotation_ids,
                split=split_by_sequence.get(sequence_id, SplitName.TRAIN),
            )
        )

    session.commit()
    session.refresh(dataset)
    return dataset
