"""Sample frames around classification error episodes and label them.

Pure functions over plain data: no database, no storage, no I/O.
"""

from bisect import bisect_left
from dataclasses import dataclass


@dataclass
class ProcessedFrame:
    frame_index: int
    ts_ms: int


@dataclass
class EpisodeSpan:
    axis: str
    start_ms: int
    end_ms: int


@dataclass
class RefInterval:
    category_id: int
    label_id: int
    start_ms: int
    end_ms: int


def sample_frames(
    episodes: list[EpisodeSpan],
    processed: list[ProcessedFrame],
    step_ms: int,
    margin_ms: int,
) -> list[ProcessedFrame]:
    """Pick the processed frames nearest to a regular grid around each episode.

    For each episode the instants are ``start - margin + k * step`` while
    ``t <= end + margin``; instants below 0 are skipped. Each instant takes the
    nearest processed frame (ties go to the lower timestamp) if it lies within
    ``step_ms / 2`` (inclusive), otherwise nothing. The result is deduplicated
    by frame and ascending by timestamp.
    """
    if not episodes or not processed:
        return []
    frames = sorted(processed, key=lambda f: f.ts_ms)
    stamps = [f.ts_ms for f in frames]
    picked: dict[int, ProcessedFrame] = {}
    for ep in episodes:
        t = ep.start_ms - margin_ms
        last = ep.end_ms + margin_ms
        while t <= last:
            if t >= 0:
                i = bisect_left(stamps, t)
                best = None
                # lower neighbour first so an exact tie keeps the lower timestamp
                for j in (i - 1, i):
                    if 0 <= j < len(stamps):
                        d = abs(stamps[j] - t)
                        if best is None or d < best[0]:
                            best = (d, j)
                if best is not None and 2 * best[0] <= step_ms:
                    picked[best[1]] = frames[best[1]]
            t += step_ms
    return [frames[j] for j in sorted(picked)]


def labels_at(ts_ms: int, intervals: list[RefInterval]) -> list[tuple[int, int]]:
    """(category_id, label_id) of every interval containing ts_ms, by category id."""
    return sorted(
        (iv.category_id, iv.label_id)
        for iv in intervals
        if iv.start_ms <= ts_ms < iv.end_ms
    )
