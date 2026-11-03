import random

import pytest

import app.main  # noqa: F401  (registers every model for the shared test-database fixture)
from app.reference.evaluation import EvalFrame, EvalInterval, score_frames

MODEL = ["caecum", "colon_left", "rectum"]
PREDS = [
    ("caecum", 0.95), ("caecum", 0.95), ("colon_left", 0.90), ("caecum", 0.60),
    ("colon_left", 0.95), ("colon_left", 0.95), ("rectum", 0.95), ("rectum", 0.95),
    ("colon_left", 0.95), ("rectum", 0.80), ("colon_left", 0.95), ("colon_left", 0.95),
]
INTERVALS = [
    EvalInterval(0, 3000, "caecum"),
    EvalInterval(3000, 6000, "colon_left"),
    EvalInterval(8000, 10000, "colon_left"),
]


def scenario_frames():
    return [EvalFrame(i * 1000, p, c) for i, (p, c) in enumerate(PREDS)]


def by_name(core):
    return {c.name: c for c in core.classes}


def test_worked_scenario():
    core = score_frames(scenario_frames(), INTERVALS, MODEL, ["caecum", "colon_left"])
    assert (core.frames_total, core.frames_evaluated, core.frames_excluded) == (12, 8, 4)
    assert core.accuracy == 0.625
    assert core.labels == MODEL
    assert core.matrix == [[2, 1, 0], [1, 3, 1], [0, 0, 0]]
    c = by_name(core)
    cae, col, rec = c["caecum"], c["colon_left"], c["rectum"]
    assert (cae.tp, cae.fp, cae.fn, cae.support) == (2, 1, 1, 3)
    assert cae.precision == pytest.approx(2 / 3)
    assert cae.recall == pytest.approx(2 / 3)
    assert cae.f1 == pytest.approx(2 / 3)
    assert (col.tp, col.fp, col.fn, col.support) == (3, 1, 2, 5)
    assert col.precision == 0.75
    assert col.recall == 0.6
    assert col.f1 == pytest.approx(2 / 3)
    assert (rec.tp, rec.fp, rec.fn, rec.support) == (0, 1, 0, 0)
    assert rec.precision == 0.0
    assert rec.recall is None
    assert rec.f1 == 0.0
    assert core.macro_f1 == pytest.approx(2 / 3)


def test_end_exclusive_start_inclusive():
    frames = [EvalFrame(999, "a", 1.0), EvalFrame(1000, "a", 1.0), EvalFrame(2000, "a", 1.0)]
    core = score_frames(frames, [EvalInterval(1000, 2000, "a")], ["a"], ["a"])
    assert core.frames_evaluated == 1
    assert core.frames_excluded == 2
    assert core.accuracy == 1.0


def test_truth_class_the_model_cannot_output():
    frames = [EvalFrame(0, "a", 1.0), EvalFrame(1000, "a", 1.0)]
    intervals = [EvalInterval(0, 1000, "a"), EvalInterval(1000, 2000, "z")]
    core = score_frames(frames, intervals, ["a"], ["a", "z"])
    assert core.labels == ["a", "z"]
    assert core.matrix == [[1, 0], [1, 0]]
    z = by_name(core)["z"]
    assert z.support == 1
    assert z.recall == 0.0
    assert z.precision is None
    assert z.f1 == 0.0


def test_model_class_never_in_truth():
    frames = [EvalFrame(0, "b", 1.0)]
    core = score_frames(frames, [EvalInterval(0, 1000, "a")], ["a", "b"], ["a"])
    b = by_name(core)["b"]
    assert (b.support, b.tp, b.fp, b.fn) == (0, 0, 1, 0)
    assert b.recall is None
    assert core.accuracy == 0.0


def test_empty_frames():
    core = score_frames([], INTERVALS, MODEL, ["caecum", "colon_left"])
    assert core.frames_total == 0
    assert core.accuracy is None
    assert core.macro_f1 is None
    assert core.matrix == [[0, 0, 0]] * 3


def test_empty_intervals():
    core = score_frames(scenario_frames(), [], MODEL, [])
    assert (core.frames_total, core.frames_evaluated, core.frames_excluded) == (12, 0, 12)
    assert core.accuracy is None
    assert core.macro_f1 is None


def test_unsorted_input_same_result():
    ordered = score_frames(scenario_frames(), INTERVALS, MODEL, ["caecum", "colon_left"])
    frames = scenario_frames()
    random.Random(1).shuffle(frames)
    intervals = list(reversed(INTERVALS))
    assert score_frames(frames, intervals, MODEL, ["caecum", "colon_left"]) == ordered
