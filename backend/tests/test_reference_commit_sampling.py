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
