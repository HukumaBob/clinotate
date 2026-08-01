# Timeline Panel Consolidation Design

## Problem

`VideoReviewPlayer.tsx`'s right-side panel currently renders one of three
separate form components depending on state: `RenameSequenceForm`,
`RecutSequenceForm`, and `SequenceFromMarksForm`. `RecutSequenceForm` and
`SequenceFromMarksForm` are nearly identical in fields (crop, fps, a range
display, a submit action) but ship as two separate components, together
taking up significant vertical space -- in tension with this screen's
established compactness goal
([2026-07-30 layout redesign spec](2026-07-30-video-review-player-layout-redesign-design.md)).

`SequenceTimeline.tsx` (extended with drag-to-adjust handles in
[2026-08-01](2026-08-01-timeline-drag-marks-design.md)) renders each
existing sequence as a colored segment with three inline icon buttons
(open/rename/re-cut) crammed into the segment itself -- cramped, and
duplicates actions that could instead live in the side panel.

## Goal

1. Merge the "edit" and "re-cut" panels into one form component. Widen the
   side panel slightly to accommodate it comfortably.
2. Remove the icon buttons from timeline segments. Replace them with three
   click targets on the timeline itself:
   - Clicking a segment's **name** (styled as a link) opens that sequence
     (today's "open" action).
   - Clicking the **rest of a segment's body** opens the combined form in
     edit mode for that sequence, with `markStart`/`markEnd` auto-set to
     the segment's current bounds (matching today's re-cut-icon behavior).
   - Clicking **empty timeline background** (a true click, not a drag)
     creates a new pending region auto-stretched to fill the gap between
     its neighbors, and opens the combined form in create mode.

This must not break or contradict the drag-to-adjust interaction shipped in
2026-08-01: dragging an edge, drawing a new region by dragging from empty
background, and snapping all keep working exactly as before. This design
only adds a *click* (no-drag) behavior on top of the existing mousedown/
mousemove/mouseup machinery.

## Design

### 1. `SequenceForm` replaces three components

A new `frontend/src/features/media/SequenceForm.tsx` replaces
`RecutSequenceForm.tsx`, `SequenceFromMarksForm.tsx`, and
`RenameSequenceForm.tsx`. Mode is determined by whether a `sequence` prop
is passed:

**`mode="create"` (no `sequence` prop):**
- Fields: name (pre-filled via the existing suggest-name query), procedure
  select, crop fields, fps.
- Crop defaults to the most-recently-created sequence's `crop_box`
  (existing `SequenceFromMarksForm` behavior, preserved).
- Submit button "Create sequence" calls the existing
  `useCreateSequenceFromVideo` mutation directly -- no confirmation step
  (nothing destructive happens on create).

**`mode="edit"` (a `sequence` prop is passed):**
- Same fields, pre-filled from `sequence`: name, `sequence.procedure_id`,
  `sequence.crop_box` (or zero crop), fps starts empty (matching today's
  `RecutSequenceForm`, which requires the user to explicitly pick an fps
  for re-extraction).
- The range display shows `markStart`/`markEnd` (driven by the timeline,
  identical wiring to today's `RecutSequenceForm`).
- Submit behavior branches on **what actually changed** from the
  sequence's original `name`/`procedure_id`/`crop_box`/range:
  - If only `name` and/or `procedure_id` changed (range and crop
    untouched): call `useUpdateSequence` directly, no confirmation, no
    frame re-extraction implied server-side change beyond the rename.
  - If range and/or crop changed: show the same confirm/cancel step
    `RecutSequenceForm` shows today ("This will delete N annotations..."
    when `sequence.annotation_count > 0`), then call `useUpdateSequence`
    with the full payload (start_time, duration, fps, crop) on confirm.
  - Determining "did the range/crop change" compares current `markStart`/
    `markEnd` against `sequence.start_time`/`sequence.start_time +
    sequence.duration`, and current crop state against
    `sequence.crop_box`.
- A "Close" button (matching today's `RecutSequenceForm`) exits via
  `onDone()` without saving, in both the editable and confirming states.

Both modes share the same `CropFields` sub-component and layout structure
(this was already true before; the merge is about the one containing
component making its own create-vs-edit decisions instead of the parent
choosing between two separate component types).

### 2. `VideoReviewPlayer.tsx` panel wiring

`VideoReviewPlayer.tsx` currently branches on
`renamingSequenceId`/`recuttingSequenceId`/mark presence to choose between
three components. This collapses to one state question: is there an
"active sequence" being edited, or not?

- `editingSequenceId: number | null` state replaces
  `renamingSequenceId`/`recuttingSequenceId` (both are gone; rename is now
  just an edit-mode field, not a separate mode).
- When `editingSequenceId !== null`: render `<SequenceForm sequence={target} markStart={markStart!} markEnd={markEnd!} onCropChange={setActiveCrop} onDone={handleEditDone} />` (mirrors today's `RecutSequenceForm` render guard: requires `markStart`/`markEnd` non-null, which the timeline always sets before opening edit mode -- see below).
- When `editingSequenceId === null` and `markStart !== null && markEnd !== null && markStart !== markEnd`: render `<SequenceForm videoId={videoId} markStart={markStart} markEnd={markEnd} procedureId={video.procedure_id ?? undefined} existingSequences={sequencesQuery.data ?? []} onCropChange={setActiveCrop} onCreated={handleCreated} />` (create mode -- same props `SequenceFromMarksForm` takes today).
- The existing "Mark start"/"Mark end" buttons and their timestamp
  displays are unchanged -- they remain a valid alternative way to set
  marks for create mode (per the 2026-08-01 spec's explicit requirement
  that both mechanisms coexist).

### 3. Timeline click handling

`SequenceTimeline.tsx` gains click-vs-drag discrimination and two new
click targets, on top of its existing drag machinery (unchanged).

**Click-vs-drag discrimination:** record `mouseDownClientX` when a drag
starts (root background or a handle). On `mouseup`, if
`Math.abs(event.clientX - mouseDownClientX) < CLICK_THRESHOLD_PIXELS` (3px),
treat it as a click and run click logic instead of leaving the drag's
live-updated (near-zero-movement) result in place. This only applies to
drags started from empty background -- handle drags (`edge: "start"`/
`"end"`) always behave as drags, since they can only start where a pending
region's handle already exists.

**Segment name click:** the segment's name span becomes a `<button>` (or
a link-styled span with its own `onClick`) with `stopPropagation()`, so
clicking it calls `onOpenSequence(sequence.id)` without triggering the
segment body's click behavior below.

**Segment body click (not the name):** `onMouseDown` on the segment
`<div>` (excluding the name) sets `dragState = { edge: "segment-click",
sequenceId: sequence.id }` (a new drag-state variant) instead of falling
through to the root's empty-background handler. Since a segment click
never actually drags visually (the user is clicking on an existing colored
block, not the pending overlay), `mousemove` is a no-op for this
drag-state variant -- it exists purely so `mouseup` can fire the
click behavior:
```
onSegmentClick(sequence.id, sequence.start_time, sequence.start_time + sequence.duration)
```
which the parent (`VideoReviewPlayer.tsx`) wires to: set `markStart`/
`markEnd` to the segment's bounds, set `editingSequenceId` to the
segment's id (opening `SequenceForm` in edit mode).

**Empty background click (new region):** the existing `handleRootMouseDown`
already starts an `"new"` edge drag on any empty-background mousedown. Add
the click-vs-drag check described above to its `mouseup` handling: if the
mouseup lands within `CLICK_THRESHOLD_PIXELS` of the mousedown, replace the
"drag with near-zero movement" result with a computed auto-stretch region
instead:
```
leftBound = max sequence end_time among sequences with start_time < clickSeconds, or 0 if none
rightBound = min sequence start_time among sequences with start_time >= clickSeconds, or durationSeconds if none
```
(`end_time` here means `start_time + duration`). Call
`onMarkStartChange(leftBound)` and `onMarkEndChange(rightBound)`, and a new
`onEmptyBackgroundClick()` callback the parent wires to
`setEditingSequenceId(null)` (ensuring create mode, not edit mode, renders).
The gap-adjacency computation assumes segments never touch with zero gap
(established as an accepted constraint during design review -- segments
fill less than the full timeline between each other in practice, so this
case is out of scope, not defended against).

After either click type opens its form, the existing drag machinery (edge
handles, snapping) works unchanged on the resulting `markStart`/`markEnd`
region -- clicks only change *how the initial region gets set*, not how
it's subsequently adjusted.

**New props on `SequenceTimeline`:**
```
onSegmentClick: (sequenceId: number, startTime: number, endTime: number) => void
onEmptyBackgroundClick: () => void
```
(`onOpenSequence`, `onMarkStartChange`, `onMarkEndChange`, `onScrub` are
unchanged from the existing signature; `onRenameSequence`/`onRecutSequence`
are removed since their icon buttons are gone.)

### Removed

- `RecutSequenceForm.tsx`, `SequenceFromMarksForm.tsx`,
  `RenameSequenceForm.tsx` and their test files -- superseded by
  `SequenceForm.tsx`.
- The three inline icon buttons (↗ ✎ ✂) on timeline segments.
- `SequenceTimeline`'s `onRenameSequence`/`onRecutSequence` props.

### Testing

- `SequenceForm.test.tsx` covers both modes: create-mode submission
  (matching today's `SequenceFromMarksForm` tests), edit-mode
  name-only-change (no confirm), edit-mode range-or-crop-change (confirm
  required, annotation-count warning), Close button in both modes, crop
  inheritance in create mode.
- `SequenceTimeline.test.tsx` covers: name-click calls `onOpenSequence`
  without triggering segment-body click; segment-body click calls
  `onSegmentClick` with correct bounds; empty-background click (no
  movement) computes correct auto-stretch bounds against neighbors on
  both sides, against one side only, and against neither side (whole
  video empty); empty-background click within 3px threshold still counts
  as a click; empty-background drag past the 3px threshold still behaves
  as today's drag-to-create.
- `VideoReviewPlayer.test.tsx` updated: existing re-cut/create-flow tests
  now go through the segment-click/empty-click paths instead of icon
  buttons; existing drag/scrub tests unchanged since drag machinery is
  untouched.

## Out of scope

- Any change to the drag-to-adjust edge/snap/scrub mechanics themselves
  (2026-08-01 spec) -- this design only adds click entry points on top.
- Zero-gap-between-segments handling (established as impossible given
  current segment rendering; not defended against).
- Widening the panel by a specific pixel/rem amount is left to the
  implementer's judgment during implementation -- "slightly wider" per
  the user's request, matching the panel's existing `flex-[2]` ratio
  convention from the 2026-07-30 layout spec, adjusted if the merged
  form's content genuinely needs more room.
