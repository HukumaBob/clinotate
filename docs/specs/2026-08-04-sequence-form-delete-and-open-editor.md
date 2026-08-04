# SequenceForm: delete sequence + move "open in editor" off the timeline

Date: 2026-08-04
Status: approved

## Problem

`SequenceForm` (`frontend/src/features/media/SequenceForm.tsx`) in edit mode
lets a user change crop/fps/name/procedure for an existing sequence, but has
no way to delete the sequence or jump into the frame editor for it.

The only current path into the frame editor is a small underlined sequence
name inside each timeline segment (`SequenceTimeline.tsx`, `onOpenSequence`).
When a sequence is short (e.g. spans 10 frames), its segment is a few pixels
wide and the link is nearly impossible to click without triggering a drag or
the segment's own click handler (which opens `SequenceForm` in edit mode).

## Decisions

1. **"Edit" means opening the frame editor**, reached via a new button inside
   `SequenceForm`'s edit mode, not a new/duplicate concept. `SequenceForm`
   itself is already the metadata-editing UI (Save persists crop/fps/name/
   procedure changes).
2. **The timeline's `onOpenSequence` link is removed**, not duplicated. The
   only way to jump to the frame editor becomes the new button in
   `SequenceForm`. Clicking a segment continues to only open `SequenceForm`.
3. **Delete uses the same inline two-step confirmation pattern** already used
   in `MediaLibraryTable.tsx` (button reads "Delete", click turns it into
   "Confirm" / "Cancel"), for consistency across the app.
4. **Backend gap closed as part of this work:** `DELETE /media/sequences/{id}`
   currently 404s for any sequence with a non-null `video_id` (i.e. every
   sequence cut from a video — exactly the ones editable in `SequenceForm`).
   This was a deliberate but incomplete guard from the commit that first
   added delete endpoints (`92b99f3`), which only implemented deletion for
   standalone photo sequences and explicitly 404'd the video-linked case
   (there's a dedicated regression test for that 404). There is no technical
   reason a video-linked sequence must be exempt from deletion — the endpoint
   is extended to allow it now that a UI path exists.

## Backend changes

`backend/app/media/router.py`, `delete_sequence`:

- Remove the `sequence.video_id is not None` condition from the 404 guard.
  Only `sequence is None` should 404 now.
- Keep the existing annotation guard unchanged: if any `Frame` under the
  sequence has annotations, return 409 with the existing message.
- Frame cleanup (`session.query(Frame).filter(...).delete()`) is unchanged
  and already correct for either kind of sequence.

`backend/tests/test_media.py`:

- Update `test_delete_video_derived_sequence_via_media_endpoint_returns_404`
  to `test_delete_video_derived_sequence_via_media_endpoint_succeeds` (or
  similar), asserting `204` instead of `404`, and that the sequence's frames
  are gone afterward.
- Add a case confirming a video-linked sequence with annotated frames still
  returns 409 (mirroring the existing photo-sequence annotation test).

No change to `useDeleteSequence` (`frontend/src/entities/useMediaLibrary.ts`)
— it already deletes by id regardless of sequence kind.

## Frontend changes

### `SequenceForm.tsx` (edit branch only)

Add two things to the button row, alongside the existing Save/Close (and
Confirm/Cancel for re-cut):

- **"Open in editor" button** — placed with Save/Close in the primary
  left-hand button group. Calls a new `onOpenEditor: () => void` prop (parent
  wires it to the existing `navigate(/sequences/{id})` logic that
  `onOpenSequence` used to trigger from the timeline). Always enabled in edit
  mode; no confirmation needed since it's non-destructive.
- **"Delete" button** — placed separately on the right of the button row,
  visually set apart as a destructive action (matches `MediaLibraryTable`'s
  right-aligned Delete column). Uses its own `confirmingDelete` boolean state
  (independent from the existing `confirming` re-cut state):
  - First click: button reads "Delete" (neutral/outlined style, matching
    `MediaLibraryTable`'s idle Delete button).
  - Click again: swaps to "Confirm" (red, matching the existing red
    Confirm button style already used for re-cut) plus a "Cancel" button that
    resets `confirmingDelete` to false.
  - Confirm calls `useDeleteSequence().mutate(sequence.id, ...)`.
  - On success: call `onDone()` (same as Save/Close — closes the form; the
    parent's `sequencesQuery.refetch()` already runs in `handleEditDone`).
  - On error (409 from annotations, or any other failure): show the error
    detail as inline text, same visual treatment as the existing
    `isError` message for Save failures.

No changes to the create-mode branch of `SequenceForm`.

### `SequenceTimeline.tsx`

- Remove the `onOpenSequence` prop entirely, and the underlined `<button>`
  showing the sequence name inside each segment. The segment `<div>` keeps
  its `title={sequence.name}` tooltip and its `onSegmentClick` handler as the
  only interaction — clicking anywhere on a segment opens `SequenceForm` in
  edit mode (existing behavior, unchanged).
- Update `SequenceTimeline.test.tsx` to remove tests specific to
  `onOpenSequence` / the segment-name link.

### `VideoReviewPlayer.tsx`

- Stop passing `onOpenSequence` down to `SequenceTimeline`.
- Instead pass it (renamed `onOpenEditor` at the `SequenceForm` call site, or
  kept as `onOpenSequence` — implementer's choice, but consistent) into the
  edit-mode `SequenceForm` instance only (the create-mode `SequenceForm`
  instance has no `sequence` to open, so it doesn't need this prop).
- The `onOpenSequence: (sequenceId: number) => void` prop on
  `VideoReviewPlayer` itself is unchanged — `MediaPage.tsx`'s `goToSequence`
  wiring stays as is.

### Tests (TDD, per CLAUDE.md)

- `SequenceForm.test.tsx`: add failing tests first for delete
  (idle → confirm → confirm-click → success calls `onDone`; error path shows
  message; cancel resets state) and for the open-in-editor button (click
  calls the new prop with the sequence id) before implementing.
- `SequenceTimeline.test.tsx`: remove/replace the now-invalid
  `onOpenSequence` tests; add/keep a test that clicking anywhere in a segment
  (not just the name) triggers `onSegmentClick`.
- `VideoReviewPlayer.test.tsx`: update prop wiring assertions accordingly.
- Backend: update/add the two test cases described above in
  `test_media.py`, written failing first against the current 404 guard.

## Out of scope

- No change to `delete_video`'s guard (still refuses to delete a video with
  linked sequences).
- No change to how standalone photo sequences are deleted from
  `MediaLibraryTable`.
- No modal-based confirmation anywhere — inline two-step stays the only
  delete-confirmation pattern in this codebase.
