# Sequence editing — design

## Context

The video review player (`VideoReviewPlayer`, `SequenceTimeline`) lets a
user create a `Sequence` by marking a start/end range on a video and
extracting frames at a chosen fps. There is currently no way to edit a
`Sequence` after creation — no backend endpoint, no frontend UI. This gap
surfaced during manual testing of the player (2026-07-30).

`Sequence` does not store `fps` — it's a one-time parameter passed to
frame extraction at creation time (`extract_frames(video_bytes,
sample_fps=...)`). `Frame` rows don't carry a timestamp, only a
`frame_index` scoped to their `Sequence`. `Annotation.frame_id` is a
required (non-nullable) foreign key. This means editing `start_time`,
`duration`, or `fps` on an existing `Sequence` is not a plain field
update — it necessarily means deleting the sequence's current `Frame`
rows (cascading to their `Annotation` rows) and re-extracting frames from
the source video with the new parameters. Editing `name`/`procedure_id`
has no such consequence.

## Scope

Two distinct operations, both surfaced only from `SequenceTimeline`
inside `VideoReviewPlayer` (the only place with both the sequence list
and the video/mark-based interaction already present):

1. **Rename/re-tag** — change `name` and/or `procedure_id`. Safe, no
   frame/annotation impact.
2. **Re-cut** — change `start_time`, `duration`, and `fps` together.
   Destructive: deletes and re-extracts the sequence's frames. Requires
   explicit user confirmation naming the exact number of annotations
   that will be lost.

Standalone sequences (`video_id is None`, created from photo batches)
cannot be re-cut — there is no source video to re-extract from. Rename
still works for them via the same endpoint.

## Backend

### `PATCH /media/sequences/{sequence_id}`

New endpoint in `app/media/router.py`, backed by a new
`update_sequence` function in `app/media/service.py`.

Request body (`SequenceUpdate`, all fields optional):
```python
class SequenceUpdate(BaseModel):
    name: str | None = None
    procedure_id: int | None = None
    start_time: int | None = None
    duration: int | None = None
    fps: float | None = None
```

Dispatch logic:
- If none of `start_time`/`duration`/`fps` are present: plain
  `UPDATE` of `name`/`procedure_id` only. No frame/annotation impact.
- If any of `start_time`/`duration`/`fps` are present: all three are
  required together (`422` if only some are given — a partial re-cut
  would leave frame_index/timing inconsistent). This is a re-cut:
  1. Validate `duration > 0` and `start_time + duration <=
     video.duration_seconds` (same validation already used by
     `create_sequence`/`SequenceFromMarksForm`).
  2. `404` if `sequence.video_id is None` (standalone sequence) —
     re-cut requires a source video.
  3. Download the source video, run `extract_frames(video_bytes,
     sample_fps=fps, ...)`, upload each new frame to MinIO, and insert
     the new `Frame` rows — **before** touching the old ones, so a
     failure here (ffmpeg error, storage error) leaves the sequence's
     existing frames and annotations untouched and the user can just
     retry.
  4. Only after all new frames are successfully persisted: delete the
     old `Frame` rows (cascades to their `Annotation` rows), update
     `sequence.start_time`/`sequence.duration` on the same row (`id`
     unchanged — `/sequences/{id}` links and any external references
     stay valid).
  5. Commit.

Response: the updated `SequenceRead` (same shape as `create_sequence`'s
response).

### `SequenceRead` gains `annotation_count: int`

A count of `Annotation` rows across the sequence's frames (`SELECT
count(*) FROM annotations JOIN frames ON ... WHERE frames.sequence_id =
:id`). Used by the frontend to show an exact number in the re-cut
confirmation prompt without a separate request.

## Frontend

### `SequenceTimeline.tsx`

Each existing segment gains two actions alongside the existing "Open"
affordance: **Rename** and **Re-cut**. Same visibility pattern as
"Open" (implementer's call: hover or always-visible compact icons).

**Rename** opens a small inline form (name text input + procedure
select, matching the pattern already used elsewhere in this codebase for
inline edits). Submitting calls `PATCH /media/sequences/{id}` with only
`name`/`procedure_id`. No confirmation needed.

**Re-cut** puts the player into the same marking interaction used for
creating a new sequence:
- `markStart`/`markEnd` (lifted state already in `VideoReviewPlayer`)
  are pre-filled from the segment's current `start_time`/`start_time +
  duration`.
- The existing "Mark start"/"Mark end" buttons re-set these marks from
  `videoRef.currentTime`, exactly as during creation.
- A required numeric `fps` input appears (no default — re-cut is
  destructive, a default would hide that consequence).
- On submit: show a confirmation dialog stating the exact
  `annotation_count` for this sequence that will be deleted (skip the
  dialog if `annotation_count === 0`, nothing destructive happens).
- On confirm: `PATCH /media/sequences/{id}` with `start_time`,
  `duration`, `fps`. On success, reset marks and refetch the sequence
  list (same `sequencesQuery.refetch()` pattern `handleCreated` already
  uses).

## Error handling

- Unknown `sequence_id` → `404`.
- Re-cut on a standalone sequence → `404` (no source video).
- `duration <= 0` or out-of-bounds range → `422`, surfaced as a
  validation message in the re-cut form (same pattern as
  `SequenceFromMarksForm`'s existing start/end validation).
- Partial temporal fields (e.g. only `fps` without `start_time`/
  `duration`) → `422`.
- ffmpeg/storage failure during re-extraction → `500`, old frames and
  annotations remain intact (extraction happens before deletion), user
  can retry.

## Out of scope

- Bulk re-cut across multiple sequences.
- Undo for a completed re-cut (the deletion is real and immediate once
  the new frames are persisted).
- Editing `Sequence` fields from the standalone `Sequences` list screen
  — rename/re-cut only exist inside `SequenceTimeline`, in the video
  player context.
