# Media library: "Last edited" column

Date: 2026-08-05
Status: approved

## Problem

`MediaLibraryTable.tsx` shows `Filename / Type / Procedure / Uploaded / Size
/ Sequences`, but nothing indicates when a video or photo-sequence was last
worked on. `Uploaded` only reflects the original upload time
(`Video.created_at` / `Sequence.created_at`) — it never changes even after
new sequences are cut from a video, or new annotations are added to its
frames. An annotator scanning the library has no way to tell which items
have seen recent activity.

## Decisions

1. **"Last edited" = the max `created_at` across everything nested under the
   row**, not a separately-tracked timestamp:
   - Video row: `MAX(Video.created_at, Sequence.created_at for all its
     sequences, Annotation.created_at for all annotations on frames in
     those sequences)`.
   - Photo row (standalone sequence, `video_id IS NULL`): same formula,
     scoped to that one sequence — `MAX(Sequence.created_at,
     Annotation.created_at for annotations on its frames)`.
2. **Computed live in SQL on every `GET /media/library` call** — no new
   `updated_at` column, no migration, no risk of a cache/column going stale
   because some code path forgot to touch it. Traded off against a small
   amount of extra query cost (a `GROUP BY` with two more joins), acceptable
   at this app's current data volume.
3. **Scope of "edit" for now: creation and deletion of `Sequence` and
   `Annotation` rows only**, via their `created_at` timestamps (deletion
   is captured implicitly — a deleted annotation stops contributing to the
   `MAX` at all, which is correct: the row's last-edited time reverts to
   whatever remains).  Annotation *status* changes (`PATCH
   /annotations/{id}/status`, e.g. draft → reviewed) do **not** move
   "Last edited", because `Annotation` has no `updated_at` of its own yet —
   only `created_at`. Adding one is explicitly out of scope for this change
   (see below).
4. **Display format matches the existing `Uploaded` column**:
   `new Date(item.last_edited_at).toLocaleDateString()` — date only, no
   time-of-day, no relative ("2 hours ago") phrasing.

## Backend changes

`backend/app/media/schemas.py`, `MediaLibraryItem` (currently at line 101):
- Add `last_edited_at: datetime` (not nullable — every row has at least a
  `created_at` to fall back to, since a `Sequence`/`Video` always exists
  before this endpoint can return it).

`backend/app/media/router.py`, `get_media_library` (currently at line 131):
- Video branch: compute `last_edited_at` as the greatest of
  `video.created_at` and, across every `Sequence` with `video_id ==
  video.id`, that sequence's `created_at` and the `created_at` of every
  `Annotation` whose `Frame.sequence_id` points to it. Implement via a
  query that joins `Sequence` → `Frame` → `Annotation` filtered to this
  video's sequences and takes `func.max(...)` over the unioned timestamp
  columns (Python-side `max()` over the handful of query results is
  acceptable too, given per-video sequence counts are small — pick
  whichever keeps the endpoint's existing per-item-loop structure simplest
  to read, this doesn't need to be a single mega-query).
- Photo branch: same formula, scoped to the one `Sequence` being iterated —
  greatest of `sequence.created_at` and `Annotation.created_at` for
  annotations on that sequence's frames.

## Frontend changes

`frontend/src/features/media/MediaLibraryTable.tsx`:
- Add a `Last edited` column header, positioned after `Uploaded`.
- Render `new Date(item.last_edited_at).toLocaleDateString()` in the new
  column's cell, mirroring the existing `Uploaded` cell's implementation
  exactly.

## Testing

- Backend: extend `test_media_library_lists_videos_and_photo_sequences` (or
  add a new test) in `backend/tests/test_media.py` — create a video with a
  sequence, assert `last_edited_at` starts equal to the video's
  `created_at`-derived value; then add an annotation to one of that
  sequence's frames and assert `last_edited_at` on a fresh `GET
  /media/library` call has moved forward to (at least) the annotation's
  `created_at`. Cover the photo-row case the same way with a standalone
  photo sequence.
- Frontend: `MediaLibraryTable.test.tsx` — add a test asserting the `Last
  edited` column renders the formatted date from `item.last_edited_at`,
  following this file's existing date-formatting test pattern for
  `Uploaded` if one exists, or mirroring the `Uploaded` cell's own test
  coverage style.

## Out of scope

- No `Annotation.updated_at` column — annotation status changes don't move
  "Last edited" yet. A future change can add this if it turns out to
  matter in practice.
- No relative/human-friendly time formatting ("3 days ago") — matches the
  plain-date style already used by `Uploaded`.
- No change to how `Uploaded` itself behaves — it continues to show pure
  upload/creation time, unrelated to this new column.
