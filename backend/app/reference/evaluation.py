"""Score classification frames against hand-labeled reference intervals.

Pure functions over plain data: no database, no storage, no I/O.
"""

from bisect import bisect_right
from dataclasses import dataclass, field


@dataclass
class EvalFrame:
    ts_ms: int
    predicted: str
    confidence: float


@dataclass
class EvalInterval:
    start_ms: int
    end_ms: int
    label: str


@dataclass
class ClassScore:
    name: str
    support: int
    tp: int
    fp: int
    fn: int
    precision: float | None
    recall: float | None
    f1: float | None


@dataclass
class AxisCore:
    frames_total: int
    frames_evaluated: int
    frames_excluded: int
    accuracy: float | None
    macro_f1: float | None
    classes: list[ClassScore] = field(default_factory=list)
    labels: list[str] = field(default_factory=list)
    matrix: list[list[int]] = field(default_factory=list)


def _ratio(numerator: int, denominator: int) -> float | None:
    """A zero denominator is `None`, never 0, NaN or infinity."""
    return numerator / denominator if denominator else None


def _vocabulary(model_classes: list[str], reference_classes: list[str]) -> list[str]:
    """Model classes in order, then reference classes not already present."""
    labels = list(model_classes)
    seen = set(labels)
    for name in reference_classes:
        if name not in seen:
            seen.add(name)
            labels.append(name)
    return labels


def containing_interval(
    starts: list[int], intervals: list[EvalInterval], ts_ms: int
) -> int | None:
    """Index of the interval with `start <= ts < end`, via bisect over sorted starts."""
    i = bisect_right(starts, ts_ms) - 1
    if i >= 0 and ts_ms < intervals[i].end_ms:
        return i
    return None


def score_frames(
    frames: list[EvalFrame],
    intervals: list[EvalInterval],
    model_classes: list[str],
    reference_classes: list[str],
) -> AxisCore:
    """Confusion matrix and per-class numbers over the frames that fall inside
    a reference interval (end exclusive); every other frame is excluded.
    Rows of the matrix are the truth, columns the prediction."""
    ordered_intervals = sorted(intervals, key=lambda iv: iv.start_ms)
    starts = [iv.start_ms for iv in ordered_intervals]
    labels = _vocabulary(model_classes, reference_classes)
    index = {name: i for i, name in enumerate(labels)}

    def slot(name: str) -> int:
        # A name outside both vocabularies would otherwise be dropped silently.
        if name not in index:
            index[name] = len(labels)
            labels.append(name)
        return index[name]

    pairs: list[tuple[int, int]] = []
    for frame in sorted(frames, key=lambda f: f.ts_ms):
        found = containing_interval(starts, ordered_intervals, frame.ts_ms)
        if found is not None:
            pairs.append((slot(ordered_intervals[found].label), slot(frame.predicted)))

    size = len(labels)
    matrix = [[0] * size for _ in range(size)]
    for truth, predicted in pairs:
        matrix[truth][predicted] += 1

    classes: list[ClassScore] = []
    for i, name in enumerate(labels):
        tp = matrix[i][i]
        support = sum(matrix[i])
        fp = sum(matrix[r][i] for r in range(size)) - tp
        fn = support - tp
        classes.append(
            ClassScore(
                name=name,
                support=support,
                tp=tp,
                fp=fp,
                fn=fn,
                precision=_ratio(tp, tp + fp),
                recall=_ratio(tp, tp + fn),
                f1=_ratio(2 * tp, 2 * tp + fp + fn),
            )
        )

    evaluated = len(pairs)
    supported = [c.f1 for c in classes if c.support > 0 and c.f1 is not None]
    return AxisCore(
        frames_total=len(frames),
        frames_evaluated=evaluated,
        frames_excluded=len(frames) - evaluated,
        accuracy=_ratio(sum(matrix[i][i] for i in range(size)), evaluated),
        macro_f1=sum(supported) / len(supported) if supported else None,
        classes=classes,
        labels=labels,
        matrix=matrix,
    )
