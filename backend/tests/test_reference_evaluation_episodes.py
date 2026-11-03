import pytest

import app.main  # noqa: F401  (registers every model for the shared test-database fixture)
from app.reference.evaluation import EvalFrame, EvalInterval, evaluate_axis

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


def scenario(boundary_ms):
    frames = [EvalFrame(i * 1000, p, c) for i, (p, c) in enumerate(PREDS)]
    return evaluate_axis(frames, INTERVALS, MODEL, ["caecum", "colon_left"], boundary_ms)


def frames_of(spec):
    return [EvalFrame(ts, pred, 0.5) for ts, pred in spec]


def test_worked_scenario_wide_boundary():
    ev = scenario(2000)
    assert ev.accuracy == 0.625
    assert [(e.start_ms, e.end_ms, e.frames, e.truth, e.predicted, e.kind,
             e.mean_confidence, e.max_confidence) for e in ev.episodes] == [
        (2000, 2000, 1, "caecum", "colon_left", "boundary", 0.90, 0.90),
        (3000, 3000, 1, "colon_left", "caecum", "boundary", 0.60, 0.60),
        (9000, 9000, 1, "colon_left", "rectum", "boundary", 0.80, 0.80),
    ]
    assert (ev.errors.boundary_frames, ev.errors.interior_frames) == (3, 0)
    t = ev.transitions
    assert t.reference == 1
    assert t.model_switches == 4
    assert t.excess_switches == 3
    assert t.median_lag_ms == 1000
    assert t.never_switched == 0
    assert [(l.at_ms, l.from_label, l.to_label, l.lag_ms) for l in t.lags] == [
        (3000, "caecum", "colon_left", 1000)
    ]


def test_worked_scenario_narrow_boundary():
    ev = scenario(500)
    assert [(e.start_ms, e.kind) for e in ev.episodes] == [
        (2000, "interior"), (3000, "boundary"), (9000, "interior"),
    ]
    assert (ev.errors.boundary_frames, ev.errors.interior_frames) == (1, 2)


def test_excluded_frame_splits_episode():
    intervals = [EvalInterval(0, 1000, "a"), EvalInterval(2000, 3000, "a")]
    frames = frames_of([(500, "b"), (1500, "b"), (2500, "b")])
    ev = evaluate_axis(frames, intervals, ["a", "b"], ["a"], 10_000)
    assert [(e.start_ms, e.frames) for e in ev.episodes] == [(500, 1), (2500, 1)]


def test_wrong_class_change_starts_new_episode():
    intervals = [EvalInterval(0, 5000, "a")]
    frames = frames_of([(0, "b"), (1000, "b"), (2000, "c"), (3000, "c"), (4000, "a")])
    ev = evaluate_axis(frames, intervals, ["a", "b", "c"], ["a"], 10_000)
    assert [(e.start_ms, e.end_ms, e.frames, e.predicted) for e in ev.episodes] == [
        (0, 1000, 2, "b"), (2000, 3000, 2, "c"),
    ]


def test_long_run_middle_is_interior_edges_count_as_boundary_frames():
    intervals = [EvalInterval(0, 10_000, "a")]
    frames = frames_of([(ts, "b") for ts in range(0, 10_000, 1000)])
    ev = evaluate_axis(frames, intervals, ["a", "b"], ["a"], 1000)
    assert len(ev.episodes) == 1
    assert ev.episodes[0].kind == "interior"
    assert ev.episodes[0].frames == 10
    # ts 0, 1000 (start side) and 9000 (end - ts = 1000) are within 1000 ms.
    assert (ev.errors.boundary_frames, ev.errors.interior_frames) == (3, 7)


def test_zero_boundary_only_exact_interval_start():
    intervals = [EvalInterval(0, 3000, "a")]
    frames = frames_of([(0, "b"), (1000, "b"), (2999, "b")])
    ev = evaluate_axis(frames, intervals, ["a", "b"], ["a"], 0)
    assert (ev.errors.boundary_frames, ev.errors.interior_frames) == (1, 2)
    assert ev.episodes[0].kind == "interior"


def test_lag_none_when_model_never_switches_or_label_not_a_model_class():
    intervals = [
        EvalInterval(0, 1000, "a"),
        EvalInterval(1000, 2000, "b"),
        EvalInterval(2000, 3000, "z"),
    ]
    frames = frames_of([(0, "a"), (1000, "a"), (2000, "a")])
    ev = evaluate_axis(frames, intervals, ["a", "b"], ["a", "b", "z"], 1000)
    t = ev.transitions
    assert t.reference == 2
    assert [l.lag_ms for l in t.lags] == [None, None]
    assert t.never_switched == 2
    assert t.median_lag_ms is None
    assert t.model_switches == 0
    assert t.excess_switches == -2


def test_label_not_a_model_class_never_counts_even_if_predicted_name_matches():
    intervals = [EvalInterval(0, 1000, "a"), EvalInterval(1000, 2000, "z")]
    frames = frames_of([(0, "a"), (1000, "z")])
    ev = evaluate_axis(frames, intervals, ["a"], ["a", "z"], 1000)
    assert ev.transitions.lags[0].lag_ms is None
    assert ev.transitions.never_switched == 1


def test_non_touching_intervals_produce_no_transition():
    intervals = [EvalInterval(0, 1000, "a"), EvalInterval(1500, 2500, "b")]
    frames = frames_of([(0, "a"), (1500, "b")])
    ev = evaluate_axis(frames, intervals, ["a", "b"], ["a", "b"], 1000)
    assert ev.transitions.reference == 0
    assert ev.transitions.lags == []
    assert ev.transitions.model_switches == 1
    assert ev.transitions.excess_switches == 1


def test_touching_same_label_is_not_a_transition():
    intervals = [EvalInterval(0, 1000, "a"), EvalInterval(1000, 2000, "a")]
    ev = evaluate_axis(frames_of([(0, "a"), (1000, "a")]), intervals, ["a"], ["a"], 0)
    assert ev.transitions.reference == 0


def test_even_number_of_lags_is_mean_of_middle_two():
    intervals = [
        EvalInterval(0, 1000, "a"),
        EvalInterval(1000, 2000, "b"),
        EvalInterval(2000, 3000, "c"),
    ]
    spec = [(0, "a"), (1000, "a"), (1250, "a"), (1500, "b"), (2000, "b"),
            (2500, "b"), (2750, "c")]
    ev = evaluate_axis(frames_of(spec), intervals, ["a", "b", "c"], ["a", "b", "c"], 0)
    assert [l.lag_ms for l in ev.transitions.lags] == [500, 750]
    assert ev.transitions.median_lag_ms == pytest.approx(625)


def test_odd_lag_count_median_and_unsorted_input():
    intervals = [
        EvalInterval(0, 1000, "a"),
        EvalInterval(1000, 2000, "b"),
        EvalInterval(2000, 3000, "c"),
        EvalInterval(3000, 4000, "a"),
    ]
    spec = [(0, "a"), (1100, "b"), (2300, "c"), (3900, "a")]
    frames = frames_of(spec)[::-1]
    ev = evaluate_axis(frames, list(reversed(intervals)), ["a", "b", "c"], ["a", "b", "c"], 0)
    assert [l.lag_ms for l in ev.transitions.lags] == [100, 300, 900]
    assert ev.transitions.median_lag_ms == 300


def test_core_fields_carried_through_and_empty_input():
    ev = evaluate_axis([], INTERVALS, MODEL, ["caecum", "colon_left"], 1000)
    assert ev.accuracy is None
    assert ev.episodes == []
    assert (ev.errors.boundary_frames, ev.errors.interior_frames) == (0, 0)
    assert ev.transitions.model_switches == 0
    assert ev.transitions.reference == 1
    assert ev.transitions.median_lag_ms is None
    assert ev.transitions.never_switched == 1


def test_prediction_matching_b_only_after_b_ends_gives_no_lag():
    intervals = [
        EvalInterval(0, 1000, "a"),
        EvalInterval(1000, 2000, "b"),
        EvalInterval(2000, 3000, "c"),
    ]
    frames = frames_of([(0, "a"), (1000, "a"), (1500, "a"), (2500, "b")])
    ev = evaluate_axis(frames, intervals, ["a", "b", "c"], ["a", "b", "c"], 0)
    assert ev.transitions.lags[0].to_label == "b"
    assert ev.transitions.lags[0].lag_ms is None


def test_multi_frame_episode_mean_and_max_confidence():
    intervals = [EvalInterval(0, 2000, "a")]
    frames = [EvalFrame(0, "b", 0.5), EvalFrame(500, "b", 0.6)]
    ev = evaluate_axis(frames, intervals, ["a", "b"], ["a"], 0)
    (episode,) = ev.episodes
    assert episode.frames == 2
    assert episode.mean_confidence == pytest.approx(0.55)
    assert episode.max_confidence == pytest.approx(0.6)


def test_two_classes_swapping_at_the_boundary():
    intervals = [EvalInterval(0, 3000, "x"), EvalInterval(3000, 6000, "y")]
    predicted = ["x"] * 4 + ["y"] * 2 + ["x"] * 2 + ["y"] * 4
    frames = [EvalFrame(i * 500, p, 0.9) for i, p in enumerate(predicted)]
    ev = evaluate_axis(frames, intervals, ["x", "y"], ["x", "y"], 2000)
    assert ev.accuracy == pytest.approx(8 / 12)
    assert [(e.start_ms, e.end_ms, e.truth, e.predicted, e.frames, e.kind)
            for e in ev.episodes] == [
        (2000, 2500, "x", "y", 2, "boundary"),
        (3000, 3500, "y", "x", 2, "boundary"),
    ]
    t = ev.transitions
    assert (t.model_switches, t.reference, t.excess_switches) == (3, 1, 2)
    assert [l.lag_ms for l in t.lags] == [1000]
