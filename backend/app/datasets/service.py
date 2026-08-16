import math
from dataclasses import dataclass, field

from sqlalchemy import func
from sqlalchemy.orm import Session

from app.annotation.models import Annotation
from app.datasets.models import Dataset, DatasetItem, SplitName, TaskType
from app.media.models import Frame, Sequence
from app.taxonomy.hierarchy import GroupingRules, LabelTree, build_label_tree, resolve_class
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


def _apportion(total: int, weights: dict, order: list) -> dict:
    """Split `total` across `order` proportionally to `weights`.

    Largest-remainder: floor each share, then hand the leftovers to the
    largest fractional parts, ties broken by the caller's order. Never
    allocates more to a key than its own weight.
    """
    weight_sum = sum(weights[key] for key in order)
    if weight_sum <= 0 or total <= 0:
        return {key: 0 for key in order}

    exact = {key: total * weights[key] / weight_sum for key in order}
    allocation = {key: min(int(exact[key]), weights[key]) for key in order}
    leftover = total - sum(allocation.values())

    while leftover > 0:
        candidates = [key for key in order if allocation[key] < weights[key]]
        if not candidates:
            break
        best = max(candidates, key=lambda key: (exact[key] - allocation[key],))
        allocation[best] += 1
        leftover -= 1
    return allocation


def apply_class_limits(
    composition: list[FrameComposition],
    class_by_annotation: dict[int, int],
    limits: dict[int, int],
    unit_by_frame: dict[int, "GroupingKey"],
    sequence_by_frame: dict[int, int],
) -> list[FrameComposition]:
    """Cap each limited class, spreading the survivors across grouping units.

    Taking the first N by id would draw from whichever procedures were
    annotated first; taking N at random would need a stored seed, which
    conflicts with composition being frozen at save time. Apportioning by
    unit gives the model the class under different scopes, preps and
    patients, and is reproducible with no seed because every tie breaks by
    id.

    A frame whose annotations are all capped away leaves the dataset rather
    than becoming a negative -- a cap is a bookkeeping decision, not a claim
    that the frame is empty.
    """
    if not limits:
        return composition

    # annotation ids of each limited class, bucketed by unit then sequence
    per_class: dict[int, dict["GroupingKey", dict[int, list[int]]]] = {}
    for item in composition:
        unit = unit_by_frame.get(item.frame_id, ("sequence", item.frame_id))
        sequence_id = sequence_by_frame.get(item.frame_id, 0)
        for annotation_id in item.annotation_ids:
            class_id = class_by_annotation.get(annotation_id)
            if class_id is None or class_id not in limits:
                continue
            per_class.setdefault(class_id, {}).setdefault(unit, {}).setdefault(
                sequence_id, []
            ).append(annotation_id)

    keep: set[int] = set()
    for class_id, by_unit in per_class.items():
        cap = limits[class_id]
        unit_order = sorted(by_unit, key=lambda unit: (unit[0], unit[1]))
        unit_weights = {
            unit: sum(len(ids) for ids in by_unit[unit].values()) for unit in unit_order
        }
        per_unit = _apportion(cap, unit_weights, unit_order)

        for unit in unit_order:
            by_sequence = by_unit[unit]
            sequence_order = sorted(by_sequence)
            sequence_weights = {sid: len(by_sequence[sid]) for sid in sequence_order}
            per_sequence = _apportion(per_unit[unit], sequence_weights, sequence_order)
            for sequence_id in sequence_order:
                keep.update(sorted(by_sequence[sequence_id])[: per_sequence[sequence_id]])

    limited: list[FrameComposition] = []
    for item in composition:
        if item.is_negative:
            limited.append(item)
            continue
        kept_ids = [
            annotation_id
            for annotation_id in item.annotation_ids
            if class_by_annotation.get(annotation_id) not in limits
            or annotation_id in keep
        ]
        if kept_ids:
            limited.append(
                FrameComposition(frame_id=item.frame_id, annotation_ids=kept_ids)
            )
    return limited


def collect_frames(
    session: Session,
    sequence_ids: list[int],
    task_type: TaskType,
    excluded_label_ids: set[int],
    tree: LabelTree | None = None,
    rules: GroupingRules | None = None,
    class_limits: dict[int, int] | None = None,
) -> list[FrameComposition]:
    """Frames entering a dataset: annotated-and-compatible, or flagged negative.

    A frame whose every annotation is excluded leaves the dataset entirely
    rather than becoming a negative -- excluding a class is a bookkeeping
    decision, not a claim that the frame is empty.

    An id in excluded_label_ids may name either the raw annotation label
    (a leaf) or the resolved class the balance panel actually displays (the
    highest collapsed ancestor, e.g. an abstract parent like "polyp" that no
    annotation ever references directly). Both must be checked -- excluding
    a leaf only, without resolving through the same tree/rules the panel
    uses, would make excluding a collapsed group a silent no-op. When
    tree/rules are omitted, resolution is skipped and only the raw label id
    is matched, preserving the old behavior for callers that don't have a
    tree handy.
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
    class_by_annotation: dict[int, int] = {}
    for annotation_id, frame_id, label_id in rows:
        if label_id in excluded_label_ids:
            continue
        resolved_id = label_id
        if tree is not None and rules is not None:
            resolved_id = resolve_class(label_id, tree, rules)
            if resolved_id in excluded_label_ids:
                continue
        class_by_annotation[annotation_id] = resolved_id
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

    if class_limits:
        sequence_by_frame = {frame.id: frame.sequence_id for frame in frames}
        keys_by_sequence = grouping_keys_for_sequences(session, sequence_ids)
        unit_by_frame = {
            frame.id: keys_by_sequence.get(frame.sequence_id, ("sequence", frame.sequence_id))
            for frame in frames
        }
        composition = apply_class_limits(
            composition, class_by_annotation, class_limits, unit_by_frame, sequence_by_frame
        )

    return composition


@dataclass
class ClassCount:
    label_id: int
    name: str
    instances: int
    frames: int


@dataclass
class Recommendation:
    kind: str
    message: str


@dataclass
class BalanceReport:
    classes: list[ClassCount]
    total_frames: int
    negative_frames: int
    below_threshold: list[str]
    threshold: int
    metrics: dict
    recommendations: list["Recommendation"] = field(default_factory=list)


def build_recommendations(
    report: BalanceReport, concentration: dict[int, float]
) -> list[Recommendation]:
    """Concrete next actions, computed from this selection's own numbers.

    `concentration[label_id]` is the share of that class's instances coming
    from its single largest grouping unit. Advisory only: this never applies
    an exclusion or a cap on the user's behalf, it only names one.
    """
    if not report.classes:
        return []

    recommendations: list[Recommendation] = []

    if report.below_threshold:
        names = ", ".join(report.below_threshold)
        count = len(report.below_threshold)
        noun = "class" if count == 1 else "classes"
        recommendations.append(
            Recommendation(
                kind="under_threshold",
                message=(
                    f"{count} {noun} below {report.threshold} "
                    f"instances: {names}. Annotate more, collapse them into a parent "
                    f"class, or exclude them."
                ),
            )
        )

    severity = report.metrics.get("severity")
    if severity in {"severe_imbalance", "extreme_imbalance"}:
        recommendations.append(
            Recommendation(
                kind="loss_weighting",
                message=(
                    f"Imbalance is {severity.replace('_', ' ')}. Consider Focal Loss or "
                    f"weighted sampling so the rare classes still contribute gradient."
                ),
            )
        )

    ratio = report.metrics.get("imbalance_ratio") or 0
    if ratio > 10 and report.classes:
        largest = report.classes[0]
        smallest = min(report.classes, key=lambda c: c.instances)
        suggested = max(smallest.instances * 10, report.threshold)
        if suggested < largest.instances:
            recommendations.append(
                Recommendation(
                    kind="cap_largest",
                    message=(
                        f"'{largest.name}' has {largest.instances} instances against "
                        f"'{smallest.name}' at {smallest.instances}. Capping "
                        f"'{largest.name}' to about {suggested} would even the ratio."
                    ),
                )
            )

    for entry in report.classes:
        share = concentration.get(entry.label_id)
        if share is not None and share >= 0.9 and entry.instances >= 2:
            recommendations.append(
                Recommendation(
                    kind="single_unit_concentration",
                    message=(
                        f"{round(share * 100)}% of '{entry.name}' comes from one video "
                        f"or photo batch. The model may learn that procedure rather "
                        f"than the finding -- annotate it in other studies."
                    ),
                )
            )

    return recommendations


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
    tree: LabelTree | None = None,
    class_limits: dict[int, int] | None = None,
    composition: list[FrameComposition] | None = None,
    grouping_keys: dict[int, "GroupingKey"] | None = None,
) -> BalanceReport:
    """Live class balance for a selection. Writes nothing.

    Classes resolve through the taxonomy's shared resolve_class, so this panel
    and any future export cannot disagree about what a class is.

    `tree` may be passed in by a caller (e.g. create_dataset) that already
    built one, to avoid loading the full label table twice in one request.

    `composition`/`grouping_keys` may likewise be passed in by a caller that
    already computed them (e.g. create_dataset, which needs both again right
    after this call) -- when omitted, this function computes them itself,
    preserving the old behavior for callers like the /balance endpoint that
    only want a report.
    """
    tree = tree if tree is not None else build_label_tree(session)
    if composition is None:
        composition = collect_frames(
            session, sequence_ids, task_type, excluded_label_ids, tree, rules, class_limits
        )
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

    resolved_ids = {row.label_id: resolve_class(row.label_id, tree, rules) for row in rows}
    names = {
        label.id: label.name
        for label in session.query(Label).filter(Label.id.in_(set(resolved_ids.values()))).all()
    }

    frame_ids_in_rows = {row.frame_id for row in rows}
    sequence_by_frame = dict(
        session.query(Frame.id, Frame.sequence_id).filter(Frame.id.in_(frame_ids_in_rows)).all()
    ) if frame_ids_in_rows else {}
    if grouping_keys is None:
        grouping_keys = grouping_keys_for_sequences(session, sequence_ids)

    instances: dict[int, int] = {}
    frames_by_class: dict[int, set[int]] = {}
    instances_by_class_and_unit: dict[int, dict[GroupingKey, int]] = {}
    for row in rows:
        class_id = resolved_ids[row.label_id]
        instances[class_id] = instances.get(class_id, 0) + 1
        frames_by_class.setdefault(class_id, set()).add(row.frame_id)

        sequence_id = sequence_by_frame.get(row.frame_id)
        unit = grouping_keys.get(sequence_id, ("sequence", sequence_id))
        by_unit = instances_by_class_and_unit.setdefault(class_id, {})
        by_unit[unit] = by_unit.get(unit, 0) + 1

    concentration: dict[int, float] = {
        class_id: max(by_unit.values()) / instances[class_id]
        for class_id, by_unit in instances_by_class_and_unit.items()
        if instances[class_id] > 0
    }

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

    report = BalanceReport(
        classes=classes,
        total_frames=len(composition),
        negative_frames=negative_frames,
        below_threshold=below,
        threshold=threshold,
        metrics=metrics,
    )
    report.recommendations = build_recommendations(report, concentration)
    return report


def assign_splits(
    sequence_ids: list[int],
    split_config: dict,
    frame_counts_by_sequence: dict[int, int] | None = None,
    grouping_keys: dict[int, "GroupingKey"] | None = None,
) -> dict[int, SplitName]:
    """Assign whole grouping units to splits; sequences inherit their unit's.

    The indivisible unit is the video, not the sequence: several sequences
    cut from one video are the same procedure, so putting one in train and
    another in val leaks -- validation would measure memorisation of that
    procedure. A sequence with no video is its own unit.

    Units are processed in DESCENDING contributed-frame-count order (summed
    over the unit's sequences), largest first, and dealt largest-remainder
    style: each unit goes to whichever split is currently furthest below its
    target share. Dealing largest-first into "most under target" rather than
    block-filling train, then val, then test means the few units that
    actually carry content get spread across all three splits.

    With few units the realized fractions cannot match the requested ones --
    expected, and the caller reports realized counts rather than forcing
    them even.

    When `grouping_keys` is omitted every sequence is treated as its own
    unit, preserving the old behaviour for callers without keys.
    """
    if not sequence_ids:
        return {}

    frame_counts_by_sequence = frame_counts_by_sequence or {}
    keys = grouping_keys or {sid: ("sequence", sid) for sid in sequence_ids}

    sequences_by_unit: dict[GroupingKey, list[int]] = {}
    for sequence_id in sequence_ids:
        unit = keys.get(sequence_id, ("sequence", sequence_id))
        sequences_by_unit.setdefault(unit, []).append(sequence_id)

    frames_by_unit = {
        unit: sum(frame_counts_by_sequence.get(sid, 0) for sid in members)
        for unit, members in sequences_by_unit.items()
    }
    ordered_units = sorted(
        sequences_by_unit,
        key=lambda unit: (-frames_by_unit[unit], unit[0], unit[1]),
    )
    total = len(ordered_units)

    train_pct = split_config.get("train", 70) / 100
    val_pct = split_config.get("val", 20) / 100
    test_pct = max(1 - train_pct - val_pct, 0.0)
    targets = {"train": total * train_pct, "val": total * val_pct, "test": total * test_pct}

    # Minimums come first and are satisfied directly against the
    # descending-content order, so the guarantee actually lands on
    # content-bearing units when there are enough of them to go around,
    # rather than being satisfiable by an empty unit. train always gets
    # >=1; val gets >=1 once there are 2+ units; test gets >=1 once there
    # are 3+ -- these sum to at most `total` by construction (1+1+1 <=
    # total whenever total >= 3), so they never compete with each other
    # for the same unit.
    min_order = ["train", "val", "test"]
    min_n = {
        "train": 1 if total >= 1 else 0,
        "val": 1 if total >= 2 else 0,
        "test": 1 if total >= 3 else 0,
    }

    counts = {"train": 0, "val": 0, "test": 0}
    unit_split: dict[GroupingKey, SplitName] = {}
    remaining = list(ordered_units)

    for name in min_order:
        while counts[name] < min_n[name] and remaining:
            unit = remaining.pop(0)
            counts[name] += 1
            unit_split[unit] = SplitName(name)

    # Deal the rest, largest-content-first, to whichever split is
    # currently furthest below its (possibly fractional) target share --
    # a largest-remainder-style apportionment that spreads any remaining
    # content across all three splits instead of block-filling train.
    for unit in remaining:
        chosen = max(counts, key=lambda name: targets[name] - counts[name])
        counts[chosen] += 1
        unit_split[unit] = SplitName(chosen)

    assignment: dict[int, SplitName] = {}
    for unit, members in sequences_by_unit.items():
        for sequence_id in members:
            assignment[sequence_id] = unit_split[unit]
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
    class_limits = dict(payload.class_limits)
    tree = build_label_tree(session)

    # Computed once and threaded through both compute_balance and the item
    # materialization below -- collect_frames (frame/annotation queries plus
    # the apply_class_limits apportionment) and grouping_keys_for_sequences
    # are each otherwise expensive enough, and deterministic enough, that
    # running them twice per save would be pure waste.
    composition = collect_frames(
        session, payload.sequence_ids, payload.task_type, excluded, tree, rules, class_limits
    )
    grouping_keys = grouping_keys_for_sequences(session, payload.sequence_ids)

    report = compute_balance(
        session, payload.sequence_ids, payload.task_type, rules, excluded,
        payload.threshold, tree, class_limits,
        composition=composition, grouping_keys=grouping_keys,
    )

    frame_ids = [item.frame_id for item in composition]
    sequence_by_frame = dict(
        session.query(Frame.id, Frame.sequence_id).filter(Frame.id.in_(frame_ids)).all()
    ) if frame_ids else {}

    # taxonomy_version is pinned from the annotations this dataset actually
    # includes -- never re-derived from the global Label table, which can
    # carry newer/unrelated taxonomy versions (e.g. test/import debris) that
    # have nothing to do with what this dataset's frames were labeled with.
    # Falls back to 1 for an all-negatives or empty selection, where no
    # annotation exists to pin a version from.
    all_annotation_ids = [aid for item in composition for aid in item.annotation_ids]
    taxonomy_version = (
        session.query(func.max(Annotation.taxonomy_version))
        .filter(Annotation.id.in_(all_annotation_ids))
        .scalar()
        if all_annotation_ids
        else None
    ) or 1

    dataset = Dataset(
        name=payload.name,
        task_type=payload.task_type,
        taxonomy_version=taxonomy_version,
        split_config=payload.split_config,
        grouping_overrides=payload.grouping_overrides.model_dump(),
        excluded_label_ids=list(excluded),
        class_limits=class_limits,
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
            "recommendations": [
                {"kind": r.kind, "message": r.message} for r in report.recommendations
            ],
        },
        created_by_id=user.id,
    )
    session.add(dataset)
    session.flush()

    frame_counts_by_sequence: dict[int, int] = {}
    for sequence_id in sequence_by_frame.values():
        frame_counts_by_sequence[sequence_id] = frame_counts_by_sequence.get(sequence_id, 0) + 1

    split_by_sequence = assign_splits(
        payload.sequence_ids, payload.split_config, frame_counts_by_sequence, grouping_keys
    )

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


GroupingKey = tuple[str, int]


def grouping_key(video_id: int | None, sequence_id: int) -> GroupingKey:
    """The unit within which data is NOT independent.

    A sequence is a slice of one video, so every sequence cut from the same
    video shares a patient, a scope, a bowel prep and a session. Treating
    those as independent samples leaks: the same procedure lands on both
    sides of a split, and validation then measures memorisation of that
    procedure rather than generalisation. A photo batch has no video, so the
    sequence is its own unit.

    The tag distinguishes the two id spaces -- ("video", 7) and
    ("sequence", 7) are different units.
    """
    if video_id is not None:
        return ("video", video_id)
    return ("sequence", sequence_id)


def grouping_keys_for_sequences(
    session: Session, sequence_ids: list[int]
) -> dict[int, GroupingKey]:
    """Map each sequence id to its grouping key in one query."""
    if not sequence_ids:
        return {}
    rows = (
        session.query(Sequence.id, Sequence.video_id)
        .filter(Sequence.id.in_(sequence_ids))
        .all()
    )
    return {row.id: grouping_key(row.video_id, row.id) for row in rows}
