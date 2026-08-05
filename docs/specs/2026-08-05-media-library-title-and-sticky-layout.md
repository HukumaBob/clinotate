# Media library: show video titles, keep the upload/player zone in view while scrolling

Date: 2026-08-05
Status: approved

## Problem

Two usability issues in the Media screen (`frontend/src/features/media/MediaPage.tsx`,
`MediaLibraryTable.tsx`):

1. **Video rows show the raw filename, not the title.** `POST /media/videos`
   requires a user-supplied `title` (`backend/app/media/router.py:46`), stored
   on `Video.title`, but `GET /media/library`'s `MediaLibraryItem` schema
   (`backend/app/media/schemas.py:101-106`) only carries `filename`, and the
   endpoint populates it from `video.filename`
   (`backend/app/media/router.py:142`), never `video.title`. When several
   uploads share a filename (e.g. every test fixture is `tiny.mp4`), every row
   looks identical and the title the user actually typed is invisible.
   Photo-sequence rows are unaffected — their `filename` field is already
   populated from `sequence.name` (`backend/app/media/router.py:160`), which
   is the meaningful name.

2. **The whole page scrolls as one unit.** `MediaPage.tsx`'s outer `<div>`
   (`min-h-screen ... p-8`) has no scroll boundary of its own, so scrolling
   down through a long `MediaLibraryTable` carries the upload forms (or the
   `VideoReviewPlayer`, once a video is selected) off the top of the
   viewport. Those elements are the primary working area; the table is a
   secondary reference/selection list and should be the only thing that
   scrolls.

## Decisions

1. **Add `title` to `MediaLibraryItem`, video rows only.** Photo rows don't
   have a separate title field (`Sequence` has no `title` column, only
   `name`, already shown), so `title` is `None` for `kind: "photo"` items.
2. **Two-line cell for video rows:** the row's primary text is the title
   (`text-gray-100`, normal weight, matching today's cell styling); a second
   line directly below shows the filename in smaller, dimmer text
   (`text-xs text-gray-500`), mirroring how file managers show a name with a
   secondary technical detail. Photo rows keep their current single-line
   `filename` display unchanged — there's nothing to layer under it.
3. **Sticky-header layout replaces the scrolling page.** `MediaPage.tsx`'s
   root becomes a fixed-viewport flex column (`h-screen` instead of
   `min-h-screen`, `overflow-hidden`) with two stacked regions:
   - a non-scrolling top region holding the upload forms /
     `VideoReviewPlayer` (whichever is active), sized to its content;
   - a `flex-1 overflow-y-auto` region below it holding only
     `MediaLibraryTable`, which scrolls independently once its content
     exceeds the remaining vertical space.
   This is a layout change in `MediaPage.tsx` only — `MediaLibraryTable`'s
   own markup (the `<table>`) is unaffected; it just now lives inside a
   scrollable container instead of the page body.

## Backend changes

`backend/app/media/schemas.py`, `MediaLibraryItem`:
- Add `title: str | None` field.

`backend/app/media/router.py`, `get_media_library`:
- Video branch: pass `title=video.title`.
- Photo branch: pass `title=None` (no such concept for a photo sequence).

## Frontend changes

`frontend/src/features/media/MediaLibraryTable.tsx`:
- Filename column cell: for `kind === "video"` items, render the title as
  the primary line and the filename as a secondary line beneath it, inside
  the same `<td>`. For `kind === "photo"` items, render `item.filename` as
  today (single line, no change). The existing click-to-open behavior (only
  on video rows) stays attached to the same cell.

`frontend/src/features/media/MediaPage.tsx`:
- Restructure the root `<div>` from `min-h-screen ... p-8` (page-scrolls)
  to a `h-screen overflow-hidden flex flex-col` layout: a top, non-scrolling
  section (padding `px-8 pt-8`) containing the existing upload-forms /
  `VideoReviewPlayer` conditional block, and a `flex-1 overflow-y-auto px-8
  pb-8` section containing `MediaLibraryTable`.

## Testing

- Backend: extend the existing `test_media_library_lists_videos_and_photo_sequences`
  test in `backend/tests/test_media.py` (or add a new one) asserting a video
  item's `title` matches the uploaded title and a photo item's `title` is
  `None`.
- Frontend: `MediaLibraryTable.test.tsx` — add a test asserting a video row
  renders both the title and the filename as separate visible text, and that
  a photo row still renders only its single filename text (no secondary
  line, no `None`/`undefined` artifact).
- No test needed for the sticky-layout CSS change itself (no behavioral
  logic to unit test) — verify manually in the browser per this codebase's
  standing testing philosophy (CLAUDE.md): confirm that with a long
  `MediaLibraryTable` list, scrolling the table does not move the upload
  forms or an open `VideoReviewPlayer` out of view.

## Out of scope

- No change to `MediaLibraryTable`'s columns, sorting, or delete behavior
  beyond the filename-cell rendering described above.
- No change to how `VideoReviewPlayer` itself scrolls internally (e.g. its
  own timeline or `SequenceForm`) — only the page-level scroll boundary
  around it.
- No title field added to standalone photo sequences — out of scope for this
  request, which is specifically about video rows showing raw filenames.
