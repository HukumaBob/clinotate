"""Score classification frames against hand-labeled reference intervals.

Pure functions over plain data: no database, no storage, no I/O.
"""

from bisect import bisect_right
from dataclasses import dataclass, field
from typing import Literal


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


@dataclass
class Episode:
    start_ms: int
    end_ms: int
    frames: int
    truth: str
    predicted: str
    kind: Literal["boundary", "interior"]
    mean_confidence: float
    max_confidence: float


@dataclass
class Lag:
    at_ms: int
    from_label: str
    to_label: str
    lag_ms: int | None


@dataclass
class Transitions:
    reference: int
    model_switches: int
    excess_switches: int
    median_lag_ms: float | None
    never_switched: int
    lags: list[Lag] = field(default_factory=list)


@dataclass
class ErrorCounts:
    boundary_frames: int
    interior_frames: int


@dataclass
class AxisEvaluation(AxisCore):
    episodes: list[Episode] = field(default_factory=list)
    errors: ErrorCounts = field(default_factory=lambda: ErrorCounts(0, 0))
    transitions: Transitions = field(default_factory=lambda: Transitions(0, 0, 0, None, 0))


def _median(values: list[int]) -> float | None:
    if not values:
        return None
    ordered = sorted(values)
    mid = len(ordered) // 2
    if len(ordered) % 2:
        return float(ordered[mid])
    return (ordered[mid - 1] + ordered[mid]) / 2


def evaluate_axis(
    frames: list[EvalFrame],
    intervals: list[EvalInterval],
    model_classes: list[str],
    reference_classes: list[str],
    boundary_ms: int,
) -> AxisEvaluation:
    """`score_frames` plus error episodes, the boundary/interior split, switch
    counts and switch lags. Episodes are in time order."""
    core = score_frames(frames, intervals, model_classes, reference_classes)
    ordered_intervals = sorted(intervals, key=lambda iv: iv.start_ms)
    starts = [iv.start_ms for iv in ordered_intervals]

    # Open episode: [start, end, count, conf_sum, conf_max, truth, predicted, all_boundary]
    episodes: list[Episode] = []
    open_ep: list | None = None
    boundary_frames = interior_frames = 0
    model_switches = 0
    first_hit: dict[tuple[int, str], int] = {}  # (interval index, label) -> first ts

    def close() -> None:
        nonlocal open_ep
        if open_ep is not None:
            start, end, count, total, top, truth, pred, all_boundary = open_ep
            episodes.append(
                Episode(
                    start_ms=start, end_ms=end, frames=count, truth=truth,
                    predicted=pred, kind="boundary" if all_boundary else "interior",
                    mean_confidence=total / count, max_confidence=top,
                )
            )
            open_ep = None

    previous: EvalFrame | None = None  # the immediately preceding processed frame, if evaluated
    for frame in sorted(frames, key=lambda f: f.ts_ms):
        found = containing_interval(starts, ordered_intervals, frame.ts_ms)
        if found is None:
            close()
            previous = None
            continue
        interval = ordered_intervals[found]
        if previous is not None and previous.predicted != frame.predicted:
            model_switches += 1
        previous = frame
        first_hit.setdefault((found, frame.predicted), frame.ts_ms)

        if frame.predicted == interval.label:
            close()
            continue
        on_boundary = (
            min(frame.ts_ms - interval.start_ms, interval.end_ms - frame.ts_ms) <= boundary_ms
        )
        if on_boundary:
            boundary_frames += 1
        else:
            interior_frames += 1
        if (
            open_ep is not None
            and open_ep[5] == interval.label
            and open_ep[6] == frame.predicted
        ):
            open_ep[1] = frame.ts_ms
            open_ep[2] += 1
            open_ep[3] += frame.confidence
            open_ep[4] = max(open_ep[4], frame.confidence)
            open_ep[7] = open_ep[7] and on_boundary
        else:
            close()
            open_ep = [
                frame.ts_ms, frame.ts_ms, 1, frame.confidence, frame.confidence,
                interval.label, frame.predicted, on_boundary,
            ]
    close()

    model_set = set(model_classes)
    lags: list[Lag] = []
    for i in range(len(ordered_intervals) - 1):
        a, b = ordered_intervals[i], ordered_intervals[i + 1]
        if a.end_ms != b.start_ms or a.label == b.label:
            continue
        hit = first_hit.get((i + 1, b.label)) if b.label in model_set else None
        lags.append(
            Lag(
                at_ms=b.start_ms, from_label=a.label, to_label=b.label,
                lag_ms=None if hit is None else hit - b.start_ms,
            )
        )
    measured = [lag.lag_ms for lag in lags if lag.lag_ms is not None]
    transitions = Transitions(
        reference=len(lags),
        model_switches=model_switches,
        excess_switches=model_switches - len(lags),
        median_lag_ms=_median(measured),
        never_switched=len(lags) - len(measured),
        lags=lags,
    )
    return AxisEvaluation(
        **vars(core),
        episodes=episodes,
        errors=ErrorCounts(boundary_frames, interior_frames),
        transitions=transitions,
    )
