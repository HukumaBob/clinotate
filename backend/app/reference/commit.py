"""Sample frames around classification error episodes and label them.

The sampling and labeling functions are pure; `commit_episodes` at the end
is the service that uses them to build a Sequence.
"""

import math
from bisect import bisect_left
from dataclasses import dataclass
from datetime import date

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.annotation.models import Annotation, AnnotationType
from app.auth.models import User
from app.inference.service import store_frames_as_sequence
from app.media.schemas import CropBox
from app.reference.schemas import CommitEpisodesRead, CommitEpisodesRequest
from app.storage import StorageService
from app.taxonomy.models import Label

# Every cut frame's PNG is held in memory before upload (about 0.5-1 MB each),
# in one synchronous request; streaming each frame to storage is the real fix.
MAX_COMMIT_FRAMES = 500


class InvalidSelection(Exception):
    pass


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

    The grid is anchored at the episode start, so its first frame (the
    mistake itself) is always an instant: for each episode the instants are
    ``start + k * step`` for every integer k (negative k included) with
    ``start - margin <= t <= end + margin``; instants below 0 are skipped. Each instant takes the
    nearest processed frame (ties go to the lower timestamp) if it lies within
    ``step_ms / 2`` (inclusive), otherwise nothing. The result is deduplicated
    by frame and ascending by timestamp.
    """
    if step_ms <= 0:
        raise ValueError("step_ms must be positive")
    if not episodes or not processed:
        return []
    frames = sorted(processed, key=lambda f: f.ts_ms)
    stamps = [f.ts_ms for f in frames]
    picked: dict[int, ProcessedFrame] = {}
    for ep in episodes:
        last = ep.end_ms + margin_ms
        # the smallest start + k * step that is >= start - margin (k <= 0)
        t = ep.start_ms - (margin_ms // step_ms) * step_ms
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


def commit_episodes(
    session: Session,
    storage: StorageService,
    run_id: int,
    request: CommitEpisodesRequest,
    user: User,
) -> CommitEpisodesRead:
    """Send frames around the selected error episodes to training (all or nothing).

    Episodes are identified by (model axis name, start_ms) and recomputed
    server-side. Frames not covered by any reference axis are dropped and
    counted. With `dry_run` only the counts are returned.
    """
    # Imported here: reference.service imports RefInterval from this module.
    from app.reference.evaluation import evaluate_axis
    from app.reference.service import load_run_eval_context

    ctx = load_run_eval_context(session, storage, run_id)
    if not request.episodes:
        raise InvalidSelection("No episodes selected")

    by_axis: dict = {}
    ambiguous: set[str] = set()
    for axis in ctx.axes:
        if axis.reference_axis is None:
            continue
        if axis.name in by_axis:
            ambiguous.add(axis.name)
        by_axis[axis.name] = axis
    known: dict[str, dict[int, EpisodeSpan]] = {}
    spans: list[EpisodeSpan] = []
    selected: set[tuple[str, int]] = set()
    for key in request.episodes:
        if key.axis in ambiguous:
            raise InvalidSelection(
                f"Axis name {key.axis!r} is ambiguous: several model axes share it"
            )
        axis = by_axis.get(key.axis)
        if axis is None:
            raise InvalidSelection(f"Unknown or unmatched axis {key.axis!r}")
        if key.axis not in known:
            ref_axis = ctx.reference.axes[axis.reference_axis]
            result = evaluate_axis(
                axis.frames, axis.intervals, axis.classes,
                [c.name for c in ref_axis.classes], 2000,
            )
            known[key.axis] = {
                ep.start_ms: EpisodeSpan(key.axis, ep.start_ms, ep.end_ms)
                for ep in result.episodes
            }
        span = known[key.axis].get(key.start_ms)
        if span is None:
            raise InvalidSelection(
                f"No error episode starts at {key.start_ms} ms on axis {key.axis!r}"
            )
        if (key.axis, key.start_ms) not in selected:
            selected.add((key.axis, key.start_ms))
            spans.append(span)

    # Sample per axis over that axis' own processed frames; union by frame index.
    picked: dict[int, ProcessedFrame] = {}
    for name in dict.fromkeys(span.axis for span in spans):
        axis = by_axis[name]
        processed = [
            ProcessedFrame(index, frame.ts_ms)
            for index, frame in zip(axis.frame_indices, axis.frames)
            if index is not None and index >= 0
        ]
        for frame in sample_frames(
            [s for s in spans if s.axis == name], processed, request.step_ms, request.margin_ms
        ):
            picked[frame.frame_index] = frame
    sampled = sorted(picked.values(), key=lambda f: (f.frame_index, f.ts_ms))

    # Abstract labels are never annotated: their intervals do not cover.
    label_rows = {
        label_id: (version, is_abstract)
        for label_id, version, is_abstract in session.execute(
            select(Label.id, Label.taxonomy_version, Label.is_abstract).where(
                Label.id.in_({iv.label_id for iv in ctx.reference_intervals})
            )
        )
    }
    usable = [
        iv for iv in ctx.reference_intervals
        if iv.label_id in label_rows and not label_rows[iv.label_id][1]
    ]
    kept: list[ProcessedFrame] = []
    covering: list[list[tuple[int, int]]] = []
    for frame in sampled:
        labels = labels_at(frame.ts_ms, usable)
        if labels:
            kept.append(frame)
            covering.append(labels)
    dropped = len(sampled) - len(kept)
    if not kept:
        raise InvalidSelection("No frame left: every sampled frame is outside the reference")
    if len(kept) > MAX_COMMIT_FRAMES:
        raise InvalidSelection(
            f"{len(kept)} frames selected, more than the limit of {MAX_COMMIT_FRAMES}"
        )

    counts: dict[str, int] = {}
    for labels in covering:
        for category_id, _ in labels:
            axis_name = ctx.reference_axis_names.get(category_id, str(category_id))
            counts[axis_name] = counts.get(axis_name, 0) + 1

    if request.dry_run:
        session.rollback()
        return CommitEpisodesRead(
            dry_run=True, episodes=len(spans), frames=len(kept), dropped_unlabeled=dropped,
            annotations_by_axis=counts, sequence_id=None, sequence_name=None,
        )

    versions = {label_id: version for label_id, (version, _) in label_rows.items()}
    video, run = ctx.video, ctx.run
    first_ms = min(f.ts_ms for f in kept)
    last_ms = max(f.ts_ms for f in kept)
    start_time = first_ms // 1000
    name = (request.name or "").strip() or (
        f"QC errors · {video.title} · run #{run.id} · {date.today().isoformat()}"
    )[:255]
    user_id = user.id

    def on_frame(position: int, frame) -> None:
        for _, label_id in covering[position]:
            session.add(
                Annotation(
                    frame_id=frame.id,
                    label_id=label_id,
                    taxonomy_version=versions[label_id],
                    annotation_type=AnnotationType.CLASSIFICATION,
                    payload={},
                    created_by_id=user_id,
                )
            )

    sequence = store_frames_as_sequence(
        session, storage, video=video, name=name, start_time=start_time,
        duration=max(1, math.ceil(last_ms / 1000) - start_time),
        origin_qc_run_id=run.id, frame_numbers=[f.frame_index for f in kept],
        on_frame=on_frame, crop=CropBox(**run.crop_box) if run.crop_box else None,
    )
    return CommitEpisodesRead(
        dry_run=False, episodes=len(spans), frames=len(kept), dropped_unlabeled=dropped,
        annotations_by_axis=counts, sequence_id=sequence.id, sequence_name=sequence.name,
    )
