import math
from dataclasses import dataclass, field

from sqlalchemy.orm import Session

from app.annotation.models import Annotation
from app.datasets.models import TaskType
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
