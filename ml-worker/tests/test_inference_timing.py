import pytest

from app.inference_timing import summarize_timing


def _sample(pre, inf, post):
    return {"preprocess": pre, "inference": inf, "postprocess": post}


def test_no_samples_gives_none():
    assert summarize_timing([]) is None


def test_samples_missing_a_stage_are_ignored():
    assert summarize_timing([{"preprocess": 1.0, "inference": 2.0}]) is None
    assert summarize_timing([_sample("1", 2.0, 3.0)]) is None


def test_a_single_frame_is_kept_rather_than_discarded_as_warm_up():
    timing = summarize_timing([_sample(1.0, 2.0, 3.0)])
    assert timing["frames_measured"] == 1
    assert timing["total_ms"]["mean"] == 6.0
    assert timing["model_fps"] == pytest.approx(166.7, abs=0.1)


def test_the_first_frame_is_discarded_as_warm_up():
    timing = summarize_timing(
        [_sample(5.0, 500.0, 5.0), _sample(1.0, 10.0, 1.0), _sample(1.0, 10.0, 1.0)]
    )
    assert timing["frames_measured"] == 2
    assert timing["inference_ms"]["max"] == 10.0
    assert timing["inference_ms"]["mean"] == 10.0


def test_percentiles_use_the_nearest_rank_method():
    # one warm-up frame, then inference times 1..10
    samples = [_sample(0.0, 999.0, 0.0)] + [_sample(0.0, float(i), 0.0) for i in range(1, 11)]
    stats = summarize_timing(samples)["inference_ms"]
    assert stats["mean"] == 5.5
    assert stats["p50"] == 5.0
    assert stats["p95"] == 10.0
    assert stats["max"] == 10.0


def test_total_is_the_per_frame_sum_and_fps_follows_its_mean():
    samples = [_sample(9.0, 9.0, 9.0), _sample(2.0, 6.0, 2.0), _sample(2.0, 6.0, 2.0)]
    timing = summarize_timing(samples)
    assert timing["total_ms"] == {"mean": 10.0, "p50": 10.0, "p95": 10.0, "max": 10.0}
    assert timing["model_fps"] == 100.0


@pytest.mark.parametrize(
    "bad",
    [float("nan"), float("inf"), float("-inf"), True, False],
)
def test_non_finite_or_bool_stage_makes_a_sample_unusable(bad):
    assert summarize_timing([_sample(bad, 2.0, 3.0)]) is None
    assert summarize_timing([_sample(1.0, bad, 3.0)]) is None
    assert summarize_timing([_sample(1.0, 2.0, bad)]) is None


def test_an_unusable_first_sample_does_not_consume_the_warm_up_discard():
    bad = _sample(float("nan"), 1.0, 1.0)
    timing = summarize_timing([bad, _sample(1, 50, 1), _sample(1, 10, 1)])
    assert timing["frames_measured"] == 1
    assert timing["inference_ms"]["mean"] == 10.0


def test_all_zero_samples_give_zero_fps():
    timing = summarize_timing([_sample(0, 0, 0), _sample(0, 0, 0)])
    assert timing["model_fps"] == 0.0


def test_result_is_strict_json_round_trippable():
    import json

    samples = [_sample(1.5, 9.0, 2.0), _sample(1.0, 8.0, 2.0), _sample(float("nan"), 1.0, 1.0)]
    text = json.dumps(summarize_timing(samples), allow_nan=False)
    assert "NaN" not in text and "Infinity" not in text
    assert json.loads(text)["frames_measured"] == 1
