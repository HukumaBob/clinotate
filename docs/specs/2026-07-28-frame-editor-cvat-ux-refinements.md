# Frame editor: CVAT-informed UX refinements

Small, targeted refinements to the frame editor (`frontend/src/features/annotation/`)
identified by comparing it against CVAT's annotation workspace
(`svat/cvat` (a local CVAT checkout), `cvat-ui/src/components/annotation-page/`),
a mature production annotation tool solving a similar core problem
(point/box/mask prompts → model predict → accept/track). CVAT was read for UX
patterns only, never for code to port — the stack and domain are unrelated.

## Why this doc exists, and what it deliberately does not change

[2026-07-23-platform-ui-ux-design.md](2026-07-23-platform-ui-ux-design.md) already
fixed the frame editor's layout as a two-column design (canvas takes all
remaining space; a single fixed ~270px tools panel on the right) — an explicit,
discussed decision, not an oversight. CVAT uses a three-column layout (44px
controls sidebar + canvas + 320px objects sidebar), but that's driven by needing
one icon-button per shape type across ~10 shape types (rectangle, polygon,
polyline, points, cuboid, skeleton, mask, tag...); we have exactly 3 prompt modes
and point/box are already gesture-driven with no mode buttons. The existing
two-column layout stays as-is.

Also explicitly **not** adopted, and why:
- Z-order layers, drag-and-drop object reordering, group/merge/join/split,
  per-object lock — CVAT patterns for scenes with many overlapping shapes.
  Our frames carry a handful of masks at most; this machinery would add
  complexity with no corresponding problem to solve.
- Interactor/Detector/Tracker as separate model-selection tabs — our adapter
  pattern (SAM 2.1 / SAM-3 model tabs, already speced) covers this more simply
  for our fixed, small feature set.
- Video-player controls (play/pause, chapters, filtered search) — the frame
  editor navigates a frame grid, not a video timeline.

This doc covers four small, additive changes, each independently valuable and
scoped to existing components.

## 1. Hover highlight in MasksList

**Problem:** `MasksList.tsx` currently only highlights a mask on the canvas
(brighter alpha) when its row is *clicked* — matching a mask to its row by eye
first, especially with several similarly-colored masks, is more friction than
necessary.

**Change:** hovering a row in `MasksList` highlights the corresponding mask on
`FrameCanvas` (the same brighter-alpha treatment `selectedAnnotationId` already
gets), without changing selection state or triggering the label-field
auto-fill that click does. Mirrors CVAT's `object-item.tsx`
`onMouseEnter={activateState}`.

**Implementation shape:** `frameEditorStore` gains a `hoveredAnnotationId`
(separate from `selectedAnnotationId`, since hover is transient and must not
clobber the actual selection when the mouse leaves). `FrameCanvas`'s redraw
picks the brighter alpha for `id === selectedAnnotationId || id === hoveredAnnotationId`.
`MasksList` sets it `onMouseEnter`/clears it `onMouseLeave` per row.

## 2. Visually distinguish draft vs. committed masks on canvas

**Problem:** `frameEditorStore.draftAnnotationId` already tracks which mask is
the in-progress, still-being-refined object (see `FrameEditor.tsx`'s
`refinePredict`), but `FrameCanvas` renders it identically to every finished,
committed mask — same fill, same alpha rule. A user can't tell by looking
whether a mask is still an editable draft or a done annotation.

**Change:** the draft mask gets a distinct stroke — a dashed outline in the
same tint as its fill — drawn on top of the fill, so draft vs. committed is
visible at a glance without reading the tools panel. Committed masks keep
today's plain semi-transparent fill, no outline.

**Implementation shape:** in `FrameCanvas`'s mask-drawing effect, after
drawing an annotation's fill, if `annotation.id === draftAnnotationId`, stroke
its silhouette (reuse the existing per-annotation alpha-channel cache used for
hit-testing — trace where alpha > 0 is already the data needed, or more
simply: draw the mask image a second time with `ctx.setLineDash([4, 3])` and
an outline derived from the same offscreen canvas). Exact rendering technique
is an implementation decision for the plan, not fixed here — the requirement
is: draft looks visibly different from committed, using the existing
draft/committed distinction already tracked in state.

## 3. More visible job-progress indicator + error surfacing

**Problem:** `FrameEditor.tsx` shows job status as small gray text in the
toolbar (`Job #{id}: {status} ({progress}%)`) — easy to miss, and there is
currently no visible path for a *failed* job to reach the user at all (no
toast, no inline error state).

**Change:**
- A small inline spinner appears next to whichever action is in flight
  (the Track button while `trackMutation`/the tracked job is running; the
  point/box/mask gesture area while a predict job is running) — CVAT's
  pattern of a non-blocking, action-adjacent loading indicator
  (`message.loading` in `tools-control.tsx`), not a full-screen block.
- If a job's status resolves to `failed` (or whatever the job-status enum's
  failure value is — check `useJob`'s type), show a dismissible error
  notification with the job's error detail if the API exposes one, instead of
  silently doing nothing.

**Implementation shape:** likely a small toast/notification primitive (check
whether one already exists in `frontend/src/shared/` before adding a new one).
The existing `jobQuery.data?.status`/`progress` polling in `FrameEditor.tsx`
is the data source — this is a rendering change, not a new data flow.

## 4. Direct frame-number input in FrameEditor's toolbar

**Problem:** navigating a sequence with many frames currently only offers
Prev/Next (one frame at a time, plus arrow keys). Jumping to frame 80 of 120
means 80 clicks/keypresses.

**Change:** add a small numeric input next to the existing "Frame X of Y"
label, prefilled with the current frame's position. Entering a number and
pressing Enter (or blurring the field) calls `onFrameChange` with that
frame's id, clamped to `[1, orderedFrames.length]`. Mirrors CVAT's
`player-navigation.tsx` `InputNumber` (minus its keyboard-focus shortcut and
slider — out of scope here, this is a single input, not a scrubber).

**Implementation shape:** local component state in `FrameEditor.tsx` for the
input's text value (so typing doesn't fight the displayed current frame
before Enter is pressed), resolving to `orderedFrames[value - 1].id` on
commit. No store changes needed.

## Testing

Per CLAUDE.md's TDD requirement, each of the four changes needs a failing
test before implementation:
- Hover highlight: a `FrameCanvas`/`MasksList` interaction test asserting the
  hovered row's annotation gets the brighter-alpha treatment without changing
  `selectedAnnotationId`.
- Draft outline: a `FrameCanvas` test asserting the draft annotation's render
  path differs from a committed one (exact assertion depends on the chosen
  rendering technique from item 2).
- Progress/error: a `FrameEditor` test asserting a spinner renders while a
  job is in flight, and an error notification renders when `jobQuery.data.status`
  is a failure state.
- Frame input: a `FrameEditor` test asserting entering a frame number and
  pressing Enter calls `onFrameChange` with the correct frame id, and that
  out-of-range input is clamped.

## Out of scope

- Any change to the two-column layout, model tabs, or label picker — not
  discussed here, not touched.
- ROI (region of interest) input, confidence-threshold slider, "convert to
  polygons" — CVAT features with no corresponding need in our SAM2
  point/box/mask → single-mask-output flow.
- A slider-based frame scrubber — the direct numeric input (item 4) covers
  the actual problem (jumping far) without adding a scrubber widget.
