import app.main  # noqa: F401  (registers every model for the shared test-database fixture)
from app.reference.commit import (
    EpisodeSpan,
    ProcessedFrame,
    RefInterval,
    labels_at,
    sample_frames,
)


def every(step: int, end: int) -> list[ProcessedFrame]:
    return [ProcessedFrame(i, i * step) for i in range(end // step + 1)]


def test_worked_scenario_union_of_frames():
    processed = every(500, 10000)
    episodes = [EpisodeSpan("Anatomy", 2000, 3000), EpisodeSpan("Anatomy", 3500, 4000)]
    got = sample_frames(episodes, processed, 1000, 1000)
    assert [f.frame_index for f in got] == [2, 4, 5, 6, 7, 8, 9]
    assert [f.ts_ms for f in got] == [1000, 2000, 2500, 3000, 3500, 4000, 4500]


def test_tolerance_700ms_frames():
    processed = every(700, 7000)
    got = sample_frames([EpisodeSpan("A", 2000, 2000)], processed, 1000, 1000)
    assert [f.ts_ms for f in got] == [700, 2100, 2800]


def test_instant_without_frame_within_half_step_is_skipped():
    processed = [ProcessedFrame(0, 0), ProcessedFrame(10, 5000)]
    assert sample_frames([EpisodeSpan("A", 2000, 2000)], processed, 1000, 0) == []


def test_tolerance_is_inclusive():
    processed = [ProcessedFrame(0, 0), ProcessedFrame(1, 2500)]
    got = sample_frames([EpisodeSpan("A", 2000, 2000)], processed, 1000, 0)
    assert [f.ts_ms for f in got] == [2500]


def test_tie_goes_to_lower_timestamp():
    processed = [ProcessedFrame(0, 1500), ProcessedFrame(1, 2500)]
    got = sample_frames([EpisodeSpan("A", 2000, 2000)], processed, 1000, 0)
    assert [f.ts_ms for f in got] == [1500]


def test_margin_clipped_at_zero():
    processed = every(500, 5000)
    got = sample_frames([EpisodeSpan("A", 500, 1000)], processed, 1000, 2000)
    # instants -1500, -500 skipped; 500, 1500, 2500 remain (last <= 3000)
    assert [f.ts_ms for f in got] == [500, 1500, 2500]


def test_empty_inputs():
    assert sample_frames([], every(500, 2000), 1000, 1000) == []
    assert sample_frames([EpisodeSpan("A", 0, 1000)], [], 1000, 1000) == []


def test_overlapping_episodes_collapse():
    processed = every(500, 10000)
    eps = [EpisodeSpan("A", 2000, 3000), EpisodeSpan("B", 2000, 3000)]
    got = sample_frames(eps, processed, 1000, 1000)
    assert [f.ts_ms for f in got] == [1000, 2000, 3000, 4000]


def test_unsorted_processed():
    processed = list(reversed(every(500, 10000)))
    episodes = [EpisodeSpan("Anatomy", 3500, 4000), EpisodeSpan("Anatomy", 2000, 3000)]
    got = sample_frames(episodes, processed, 1000, 1000)
    assert [f.frame_index for f in got] == [2, 4, 5, 6, 7, 8, 9]


def test_labels_at_boundaries_and_axes():
    intervals = [
        RefInterval(2, 20, 2200, 3800),
        RefInterval(1, 10, 0, 4200),
    ]
    assert labels_at(0, intervals) == [(1, 10)]
    assert labels_at(2200, intervals) == [(1, 10), (2, 20)]
    assert labels_at(3799, intervals) == [(1, 10), (2, 20)]
    assert labels_at(3800, intervals) == [(1, 10)]
    assert labels_at(4200, intervals) == []
    assert labels_at(5, []) == []


def test_grid_is_anchored_at_the_episode_start():
    # margin 1000 is not a multiple of step 2000: the mistaken frame at 14000
    # must still be sampled; 12000 and 16000 lie outside 13000..15000.
    processed = every(500, 30000)
    got = sample_frames([EpisodeSpan("A", 14000, 14000)], processed, 2000, 1000)
    assert [f.ts_ms for f in got] == [14000]


def test_anchored_grid_step_1000_margin_500():
    processed = every(500, 30000)
    got = sample_frames([EpisodeSpan("A", 14000, 16000)], processed, 1000, 500)
    # window 13500..16500 -> 14000, 15000, 16000
    assert [f.ts_ms for f in got] == [14000, 15000, 16000]


def test_anchored_grid_margin_zero():
    processed = every(100, 10000)
    got = sample_frames([EpisodeSpan("A", 2300, 4700)], processed, 1000, 0)
    assert [f.ts_ms for f in got] == [2300, 3300, 4300]


def test_anchored_grid_long_episode():
    processed = every(100, 60000)
    got = sample_frames([EpisodeSpan("A", 10050, 40050)], processed, 5000, 2500)
    # instants 10050 + k*5000 within 7550..42550: 10050 .. 40050 (7 instants);
    # each lands on the nearest 100-ms frame, the tie at 50 going lower.
    assert [f.ts_ms for f in got] == [10000, 15000, 20000, 25000, 30000, 35000, 40000]


def test_anchored_grid_skips_instants_below_zero():
    processed = every(100, 10000)
    got = sample_frames([EpisodeSpan("A", 700, 700)], processed, 500, 1500)
    # window -800..2200 anchored at 700: -300 skipped; 200, 700, 1200, 1700, 2200
    assert [f.ts_ms for f in got] == [200, 700, 1200, 1700, 2200]


def test_anchored_overlapping_episodes_still_collapse():
    processed = every(100, 10000)
    eps = [EpisodeSpan("A", 2000, 3000), EpisodeSpan("B", 2500, 3000)]
    got = sample_frames(eps, processed, 1000, 500)
    # A: 2000, 3000; B: 2500, 3500 (window 2000..3500); 2000/3000 appear once
    assert [f.ts_ms for f in got] == [2000, 2500, 3000, 3500]
