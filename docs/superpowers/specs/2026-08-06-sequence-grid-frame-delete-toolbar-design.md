# Sequence grid: sticky toolbar with select-and-delete frames

## Problem

On `/sequences/:id` (`SequenceGridPage.tsx`), the page header is a bare
`<h1>Sequence #{sequenceId}</h1>` — the sequence's numeric id, not its
name — and there is no way to delete individual frames from the grid. The
only existing frame-deletion path is deleting the entire sequence
(`DELETE /media/sequences/{sequence_id}`), which is blocked outright if any
frame has annotations (409). There is no way to remove a handful of bad
frames (blurry, out-of-view, duplicates) without either keeping them
forever or wiping the whole sequence.

This implements the "Select mode — bulk frame cleanup" section already
described in
[docs/specs/2026-07-23-platform-ui-ux-design.md](../../specs/2026-07-23-platform-ui-ux-design.md#select-mode--bulk-frame-cleanup),
narrowed to just the checkbox-select-and-delete mechanics. The same section
also describes a "Find similar" / "Rank quality" auto-suggestion toolbar
for candidate frames — that is explicitly out of scope here; this feature
only adds the base select/delete interaction the richer toolbar would
later sit on top of.

## Goals

1. Replace the `Sequence #{id}` header with the sequence's actual `name`.
2. Add a toolbar, sticky to the top of the viewport on scroll, that toggles
   a "Select" mode.
3. In Select mode, every frame thumbnail grows a checkbox; clicking a
   thumbnail toggles its checkbox instead of opening the frame editor.
4. A "Delete selected" (trash icon) action in the toolbar, active only when
   at least one frame is checked, batch-deletes the checked frames
   (including their annotations) after a confirmation.
5. A "Cancel" action exits Select mode and clears any selection without
   deleting anything.

## Non-goals

- "Find similar" / "Rank quality" auto-suggestion (a later iteration on top
  of this one, per the UI/UX spec's own framing of Select mode).
- Any change to whole-sequence deletion (`DELETE /media/sequences/{id}`)
  or its existing "blocked if annotated" behavior — that endpoint is
  untouched.
- Undo/trash-can-recovery for deleted frames — deletion is immediate and
  permanent once confirmed, consistent with every other delete action in
  this codebase (annotations, sequences, videos).

## Backend

### New endpoint: `DELETE /media/sequences/{sequence_id}/frames`

Request body: `{"frame_ids": [1, 2, 3]}` (new schema `FrameBulkDelete` in
`backend/app/media/schemas.py`, `frame_ids: list[int]`).

Response: `{"deleted_ids": [1, 2, 3]}` — same shape as the existing
`delete_job_annotations` endpoint in `backend/app/annotation/router.py`.

Behavior, in `backend/app/media/router.py`, one new function alongside the
existing `delete_sequence`/`delete_video`:

- Query only frames matching both `Frame.id.in_(frame_ids)` AND
  `Frame.sequence_id == sequence_id` — an id belonging to a different
  sequence, or a nonexistent id, is silently skipped (not a 404), matching
  this batch-endpoint style already established by
  `delete_job_annotations` (which does not 404 on a job with zero
  annotations).
- For each matched frame: query its `Annotation` rows
  (`Annotation.frame_id == frame.id`); for each annotation with a
  `storage_key`, call `storage.delete(annotation.storage_key)` (mirrors
  `delete_annotation`'s existing cleanup exactly), then delete the
  `Annotation` row. This is a deliberate cascade — the UI/UX spec's
  sequence-level protection ("blocked if annotated") does not apply here
  because deleting one frame is an explicit, targeted user action on that
  frame, not an implicit side effect of deleting its whole container.
- Then call `storage.delete(frame.storage_key)` for the frame's own image,
  and delete the `Frame` row.
- One `session.commit()` after the whole batch (not per-frame), so a
  mid-batch failure leaves nothing partially deleted.
- Returns `{"deleted_ids": [...]}` listing only the ids actually found and
  deleted (so the frontend can tell if some requested ids were skipped).

No change to `SequenceRead`, `FrameRead`, or any other existing schema —
`SequenceRead.name` (already present) is all the frontend needs for the
toolbar title.

## Frontend

### `SequenceGridPage.tsx`

New local state:
- `isSelectMode: boolean` (default `false`)
- `selectedFrameIds: Set<number>` (default empty)

New hook: `useDeleteFrames(sequenceId)` in
`frontend/src/entities/useFrames.ts`, a `useMutation` calling
`DELETE /media/sequences/{sequence_id}/frames` with `{frame_ids}`, matching
the existing `useDeleteJobAnnotations` shape in `useAnnotations.ts`. On
success, invalidates the `["frames", sequenceId]` query key (whatever
`useFrames` already uses) so the grid re-fetches without the deleted
frames.

**Toolbar** (new component `SequenceGridToolbar.tsx` in
`frontend/src/features/annotation/`, kept separate from `SequenceGridPage`
since it has its own non-trivial internal state transitions — confirm
dialog, disabled-state logic — worth isolating and testing on its own):

- Rendered at the top of `SequenceGridPage`'s returned JSX, wrapped in a
  `sticky top-0 z-10 bg-gray-950` div so it stays pinned to the viewport
  top as the grid scrolls past it underneath (the app's scroll container
  is `<main class="flex-1 overflow-auto">` in `AppLayout.tsx`, so a plain
  CSS `sticky` positioned relative to that ancestor is sufficient — no JS
  scroll-listener needed).
- Always shows: the sequence's **name** (`sequenceQuery.data?.name`,
  falling back to `Sequence #{sequenceId}` only while the query is still
  loading and `name` isn't available yet) and a **"Select"** toggle button.
- When `isSelectMode` is `true`, additionally shows: a count of selected
  frames (`{selectedFrameIds.size} selected`), a **trash icon button**
  (disabled when `selectedFrameIds.size === 0`), and a **"✕ Cancel"**
  button.
- Clicking the trash icon opens a confirmation (reuse this codebase's
  existing inline "click once to arm, click again to confirm" pattern
  already used in `MasksList.tsx`'s delete buttons — no new modal
  component) before calling the delete mutation. On success, clears
  `selectedFrameIds` (stays in Select mode, so the user can keep pruning).
- Clicking "✕ Cancel" sets `isSelectMode` to `false` and clears
  `selectedFrameIds`.

**`FrameThumbnail.tsx` changes:**

New props: `selectable: boolean`, `selected: boolean`,
`onToggleSelect: () => void`. When `selectable` is `true`:
- A checkbox renders in the top-left corner of the card (absolutely
  positioned, similar treatment to the existing mask-overlay/caption
  layering already on this component).
- The card's `onClick` calls `onToggleSelect` instead of the existing
  `onClick` prop (which opens the frame editor) — Select mode fully
  replaces the click behavior, it doesn't add a second target to hit.
- The checkbox's own `checked` state mirrors the `selected` prop; clicking
  the checkbox itself also calls `onToggleSelect` (not a second, separate
  handler) — a checkbox is not a separate hit target from the rest of the
  card in this design, both trigger the same toggle.

`SequenceGridPage` passes `selectable={isSelectMode}`,
`selected={selectedFrameIds.has(frame.id)}`, and an `onToggleSelect` that
adds/removes `frame.id` from `selectedFrameIds` (a new `Set` each time,
per React's immutability expectations for state).

## Testing (TDD)

**Backend** (`backend/tests/test_media.py` or wherever frame/sequence
tests already live):
- Deletes a frame with one mask annotation (storage_key set): asserts the
  `Frame` row, the `Annotation` row, and both storage objects
  (`storage.delete` called with both keys) are gone; response contains the
  frame's id in `deleted_ids`.
- Deletes a batch of 2 frames where one id doesn't exist: the real frame is
  deleted, the fake id is silently absent from `deleted_ids`, no error.
- Deletes a frame belonging to a *different* sequence than the one in the
  URL: that frame is NOT deleted (not returned in `deleted_ids`), proving
  the `sequence_id` filter is enforced, not just the frame id.
- Deletes a frame with zero annotations: succeeds with no annotation-table
  interaction errors (frame has no mask cleanup to do).

**Frontend:**
- `SequenceGridToolbar.test.tsx`: renders the sequence's `name` (not
  `Sequence #id`); clicking "Select" reveals the trash/cancel controls;
  trash button is disabled at zero selected, enabled otherwise; clicking
  trash once arms confirmation without calling the mutation, clicking
  again calls it with the exact selected ids; clicking "Cancel" hides the
  extra controls again.
- `FrameThumbnail.test.tsx`: adds cases for `selectable=true` — clicking
  the card calls `onToggleSelect` and does NOT call the editor-opening
  `onClick`; checkbox reflects the `selected` prop.
- `SequenceGridPage.test.tsx`: toggling Select mode flows `selectable`/
  `selected` down to `FrameThumbnail` correctly; selecting two frames and
  confirming delete calls the mutation with both ids; after a successful
  delete, `selectedFrameIds` is cleared (verify no frames remain
  "selected"-styled) while Select mode itself stays on.

## Files touched

- `backend/app/media/schemas.py` (new `FrameBulkDelete` schema)
- `backend/app/media/router.py` (new bulk-delete route)
- `backend/tests/test_media.py` (or existing frame/sequence test file)
- `frontend/src/entities/useFrames.ts` (new `useDeleteFrames` hook)
- `frontend/src/features/annotation/SequenceGridToolbar.tsx` (new)
- `frontend/src/features/annotation/SequenceGridToolbar.test.tsx` (new)
- `frontend/src/features/annotation/SequenceGridPage.tsx` (select state,
  renders toolbar, passes select props to `FrameThumbnail`)
- `frontend/src/features/annotation/SequenceGridPage.test.tsx`
- `frontend/src/features/annotation/FrameThumbnail.tsx` (selectable/
  selected/onToggleSelect props, checkbox rendering)
- `frontend/src/features/annotation/FrameThumbnail.test.tsx`
- `openapi.json` (regenerated after the backend route is added, per
  CLAUDE.md's `export_openapi.py` step)
