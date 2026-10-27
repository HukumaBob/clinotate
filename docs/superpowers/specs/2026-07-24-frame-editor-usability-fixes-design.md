# Frame editor usability fixes

Status: approved, ready for implementation planning.

## Context

The frame editor shipped in Phase 2c (`docs/superpowers/specs/2026-07-24-frame-editor-design.md`)
passed real-browser verification against a real GPU and a genuine SAM 2.1
job, but that verification only proved the wiring worked end-to-end — it
never asked whether the result was usable. A first hands-on pass by the
user found it wasn't: gestures are invisible, there's no negative point,
no way to delete a bad mask, an unexplained extra click ("Add mask") on
every action, no way to see a box while dragging it, the frame image
doesn't scale sensibly, and there's no way to move between frames without
returning to the grid. This document is the fix for all of that —
functional and visual — in one pass, per the user's explicit direction
("do it together, not as a separate session").

## What's wrong, and why

Read directly from the current code
(`frontend/src/features/annotation/FrameCanvas.tsx`,
`frontend/src/features/annotation/ToolsPanel.tsx`), not inferred:

- **No visual feedback for prompts.** `handleMouseDown`/`handleMouseUp`
  push points and boxes straight into `pendingPrompts` — nothing is ever
  drawn on the canvas for them. A user clicking has no idea anything
  happened until they press "Add mask" and wait for a network round trip.
- **No negative point.** `label: true` is hardcoded on every point/box
  prompt (`FrameCanvas.tsx:173`). The backend contract
  (`PromptIn.label: bool`) already supports `false` — SAM 2.1's own
  `predict()`/`add_new_points_or_box()` take a `point_labels` array with
  0/1 per point — but nothing in the frontend ever sends it.
- **No delete.** There's no button, gesture, or endpoint for removing a
  mask. `Ctrl+click` is stubbed as a documented no-op
  (`FrameCanvas.tsx:136-141`, "no hit-testing wired to canvas clicks
  yet"), and there is no `DELETE` route anywhere under
  `backend/app/annotation/router.py`.
- **"Add mask" as a mandatory extra click** was originally justified by
  wanting to accumulate multiple points before running SAM once — but the
  user's real workflow is the opposite: run SAM after every completed
  gesture, see the result immediately, then correct by adding/removing a
  point if the mask is wrong. A confirm button is the wrong shape for
  that loop.
- **Box has no live feedback.** `onMouseMove` (`FrameCanvas.tsx:96`) only
  draws anything when `activeTool === "mask"`; a box drag produces zero
  visible feedback until `mouseup`, when it silently becomes a pending
  prompt.
- **Canvas doesn't respect the frame's aspect ratio.** The `<canvas>`
  element is styled `h-full w-full` (`FrameCanvas.tsx:184`) and then has
  its drawing-buffer `width`/`height` set to the frame's *natural* pixel
  dimensions (`frame.width`/`frame.height`, line 45-46) — the CSS box and
  the buffer disagree, so the browser stretches/distorts the image to
  fill whatever box it's in, with no aspect-ratio preservation and no
  bound against the viewport.
- **No frame-to-frame navigation inside the editor.** Confirmed against
  the UI/UX design spec (`docs/specs/2026-07-23-platform-ui-ux-design.md`)
  — it was never speced, not merely unimplemented. The only way to look
  at a different frame today is "✕ Back to grid" then click another
  thumbnail.
- **No visual design pass ever happened.** `ToolsPanel.tsx` is bare HTML
  `<select>` elements and a native `<input type="color">`, with no type
  scale, no visual grouping beyond bare Tailwind border/padding utility
  classes, and no distinction between structural and interactive text.

## Reference check: how the predecessor platform solved the transferable
## parts of this

Read directly from `segmentation` (Django,
domain-knowledge source only, never a code source):

- `segmentation/models.py`'s `Mask`/`Points`: every mask is its own row
  (`id`, `frame_sequence`, `tag`, `mask_file`) with its own child `Points`
  rows carrying a `+`/`-` sign per point. This is already how
  `Annotation` works in the new platform (own `id`, `label_id`,
  `frame_id`) — two different labels, or two instances of the same label,
  on one frame are already two independent `Annotation` rows. Nothing
  about the data model needs to change for that case.
- `segmentation/views.py`'s `delete_mask` (line 130): single-mask delete
  by id is the baseline case. Its `delete_all` flag
  (`Mask.objects.filter(tag=mask.tag, id__gte=mask.id)`) was investigated
  as a candidate for "delete a whole track run" but rejected — it's an
  `id >=` heuristic that assumes track runs of the same tag never
  interleave in creation order, which breaks in a real, concrete scenario
  (two separate polyps of the same tag, tracked in two separate sessions,
  with overlapping id ranges deleting each other's masks). No `job_id`
  concept existed in the reference to fall back on instead — this
  platform needs one that the reference didn't have.

## Design

### 1. Gesture model (replaces the current mouse-handling entirely)

- **Left click** → positive point. Drawn immediately as a small filled
  circle on the canvas (green/accent color) and submitted to
  `/jobs/sam2/predict` immediately — no "Add mask" button for this path.
- **Shift+Left click** → negative point. Drawn as a small circle in a
  visually distinct color (e.g. red/warning) with `label: false` in the
  submitted `PromptIn`. Submitted immediately, same as a positive point.
- **Left-drag** → box. Drawn live during the drag (a rectangle outline
  following the cursor, using the same canvas the frame/masks are drawn
  on — see the live-feedback layer below) and submitted on `mouseup`.
  Before submission, the drawn box gets a small **✕** in its top-left
  corner (a real clickable hit target, not just decoration) that removes
  that specific pending box without submitting it — the one piece of
  "undo before commit" the user asked for.
- **Ctrl+click** → remove. Hit-tests against the frame's *existing*
  annotations (not pending prompts) using each mask's actual alpha
  channel at the clicked pixel (decode each visible `mask_url` PNG's
  alpha once when annotations load, sample at the click's frame-space
  pixel coordinate) and, if a mask is hit, calls the single-annotation
  delete endpoint (see below) for the topmost hit mask. This replaces the
  masks-list-only removal path with the on-canvas gesture the original
  spec always intended, now that delete actually exists to wire it to.
- **Mask (brush) tool** stays button-gated (`Point`/`Box`/`Mask` row,
  unchanged) with an explicit submit action, since — as established when
  this was first built — a brush stroke's "I'm done drawing" moment isn't
  inferrable from mouse events the way point/box's `mouseup` already is.
  The submit action for this path is relabeled from "Add mask" to
  **"Generate from mask"** so its purpose (submit the drawn brush stroke
  as a mask prompt) isn't confused with the removed general-purpose "Add
  mask" button.

**Net effect on `ToolsPanel`**: the standalone "Add mask" button is
removed for the point/box path (submission is now automatic per-gesture);
it's kept, relabeled, and scoped to only the Mask tool.

### 2. Live prompt/box rendering on canvas

`FrameCanvas` gains a rendering layer for *in-progress* interaction state
that today doesn't exist at all:

- Every point in `pendingPrompts` (before it's cleared by a successful
  submission) is drawn as a small filled circle at its normalized
  coordinate, colored by its `label` (positive/negative).
- An in-progress box drag draws a live rectangle outline from
  `mousedown` to the current `mousemove` position, redrawn every move
  event (same technique already used for the mask-brush's live stroke
  preview — this is generalizing an existing pattern, not inventing a
  new one).
- Since point/box now submit *immediately* per gesture (design decision
  1), the practical lifetime of this pending-state rendering is short
  (until the SAM 2.1 response lands and the annotation refetch replaces
  it with a real mask overlay) — but it still needs to render for that
  window, both to give the user immediate feedback and to render the ✕
  delete affordance on an in-flight box before it's confirmed sent.

### 3. Delete endpoints (backend)

Two new endpoints in `backend/app/annotation/router.py`, plus one schema
addition:

- **`Annotation.job_id: int | None`** — new nullable FK to `jobs.id`,
  migration required. Set by the ml-worker's `run_sam2_predict`/
  `run_sam2_track` Celery tasks when they create an `Annotation` row (the
  job that's already running knows its own id at that point — this is a
  one-line addition to each task, not new plumbing). `None` for any
  annotation not created by a job (there currently are none via any
  existing path, but the field stays nullable since a future manual/
  classification-only annotation path shouldn't require a job).
- **`DELETE /annotation/annotations/{annotation_id}`** — deletes one
  annotation. Also deletes its `storage_key`'s object from MinIO via
  `StorageService.delete()` (the storage service already has this method,
  confirmed in `backend/app/storage.py`) if `storage_key` is set, so mask
  PNGs don't leak as orphaned objects.
- **`DELETE /jobs/{job_id}/annotations`** — deletes every `Annotation`
  row with that `job_id` (and their storage objects, same cleanup as
  above). This is the "delete this whole track run" action — precise,
  because `job_id` is an exact foreign key, not a heuristic — and it's
  the fix for the two-polyps-same-tag scenario the `id >=` heuristic
  would have gotten wrong: two separate track jobs on the same label
  never share a `job_id`, so deleting one never touches the other's
  masks regardless of how their row ids happen to interleave.

### 4. Masks list gets delete affordances

Per mask row in `MasksList`: a small **✕** (same visual language as the
box-cancel ✕ from design decision 1) for single-annotation delete. If
the row's annotation has a non-null `job_id`, a second, clearly-separated
**"Delete all from this run"** action appears alongside it, calling the
bulk endpoint. Both need a lightweight confirmation (not a full modal —
this is a frequent-enough corrective action that a modal would be
friction; a two-stage button, "✕" → "Confirm ✕" on the same click target
within a few seconds, matches the panel's existing low-ceremony
philosophy from the original design spec's color-picker section) since
deletion is destructive and — for the bulk case — can affect many rows
across many frames.

### 5. Canvas sizing (aspect-ratio-correct, viewport-bounded)

Replace the current `h-full w-full` canvas styling with an approach that:
- Preserves the frame's natural aspect ratio (`frame.width`/
  `frame.height`) — the canvas element's CSS box must match that ratio,
  not stretch to fill an arbitrary container shape.
- Fills as much of the available two-column layout's left region as
  possible without exceeding either the container's width or the
  viewport's height (i.e. `max-width: 100%; max-height: 100%` against a
  flex/grid parent sized to the remaining viewport space, with `object-fit`-
  equivalent letterboxing behavior reproduced via canvas CSS sizing rather
  than an `<img>`'s native `object-fit`, since this is a `<canvas>`).
- This directly fixes the "vylezaet za predely okna" (overflows the
  window) and "ne rastyagivaetsya na vsyu ramku" (doesn't fill the frame)
  complaints — both are one root cause: no aspect-ratio-aware sizing
  logic exists today.
- Point/box coordinate normalization (`toNormalized`) already divides by
  the canvas element's own `getBoundingClientRect()` — this keeps working
  unchanged once the box that rect describes is aspect-ratio-correct;
  no coordinate-math changes needed here, only CSS/layout.

### 6. Frame-to-frame navigation inside the editor

Not in the original UI/UX design spec — confirmed by re-reading it, this
is a genuine gap, not a missed requirement. Design, per user direction:

- `FrameEditor`'s header (next to "✕ Back to grid") gains **‹ Prev** /
  **Next ›** controls that move to the adjacent frame in the same
  sequence, ordered by `frame_index` — no return to the grid.
- Left/Right arrow keys are wired as the same action (a `keydown`
  listener scoped to the editor, ignoring keystrokes when a form control
  like the color `<input>` or a `<select>` has focus, so arrow-key
  navigation doesn't fight normal text/select field interaction).
- `SequenceGridPage` already calls `useFrames(sequenceId)` (confirmed —
  it needs the frame list for the grid itself) and already has that data
  available when it renders `FrameEditor`. `FrameEditor` gains a new prop
  for the ordered frame-id list and its current position, rather than
  re-fetching — no duplicate network request, no new hook.
- Since `FrameEditor`'s Zustand store is created via
  `useMemo(() => createFrameEditorStore(), [frameId])`, moving to a new
  frame automatically gets a fresh store (this dependency array already
  exists and already does the right thing) — no additional reset logic
  needed for pending prompts/selected annotation carrying over between
  frames.
- A small "Frame N of M" indicator sits between Prev/Next, giving
  positional context the way the old platform's page indicators did.

### 7. Visual design of the tools panel

Direction confirmed with the user: a disciplined, neutral clinical-tool
aesthetic (Figma/Linear/PACS-viewer register) — not a AI-generic
marketing-page look, not an experimental risk. The panel is an instrument
a clinician operates repeatedly, not a showcase; every visual decision
here optimizes for fast, unambiguous recognition of tool state, not for
personality.

- **Color**: the existing dark palette (`bg-gray-950`/`900`/`800`,
  `text-gray-100`/`300`/`400`) stays as the neutral base — it's already
  established platform-wide and correctly desaturated so it doesn't
  compete with the endoscopic image's own reds/pinks. One accent color
  (`blue-600`, already used for the active-tab/active-tool state) is kept
  as the *only* color that means "selected/active" — currently the panel
  also uses blue for the unrelated "Add mask"/"Track" action buttons,
  diluting that meaning; those become a visually distinct
  secondary/outline treatment so blue stays reserved for state, not
  generic action.
- **Point/mask colors get semantic, not decorative, meaning**: positive
  points and existing masks use the established green-leaning palette;
  negative points use a warning red — this is the one place a second
  accent color is introduced, and it's load-bearing (distinguishing +/-
  is the entire point of the affordance), not decoration.
- **Typography**: replace uppercase-tracked micro-labels
  (`text-xs font-semibold uppercase tracking-wide`, currently only on
  "MASKS") with a consistent small-caps-free label style used for every
  section header (Category/Classification/Tag, Track, Masks) — sentence
  case, consistent weight, consistent size — so the panel reads as one
  coherent hierarchy instead of one section randomly styled differently
  from its siblings.
- **Structure**: group the panel into visually distinct sections with
  real spacing and (where it clarifies grouping) a hairline divider —
  Model tabs / Tool row / Label picker / Color+Generate / Track / Masks —
  rather than the current flat stack of same-weight blocks separated only
  by `gap-4`.
- **Selects and color input**: replace the bare native `<select>`/
  `<input type="color">` styling with a consistent custom-styled control
  treatment (still real `<select>`/`<input>` elements for accessibility
  and mobile compatibility — styled via Tailwind, not reimplemented as
  custom dropdown components, which would be new complexity this panel
  doesn't need) that matches the panel's borders/radii/focus-ring
  language instead of the browser's unstyled defaults.
- **Signature element**: the ✕-to-delete affordance (shared visual
  language across pending-box-cancel, single-mask-delete, and
  bulk-delete-confirm) is the one deliberately recognizable interaction
  pattern introduced by this pass — consistent, small, always in the same
  relative position (top-left for on-canvas, trailing edge for list
  rows), so a user learns it once and it means the same thing everywhere
  after that.

## Testing

TDD throughout, per CLAUDE.md:
- Backend: failing test first for the migration, the two delete
  endpoints, and the `job_id` population in both Celery tasks.
- Frontend: Vitest + Testing Library for gesture handling (positive/
  negative point, box draw+cancel, ctrl-click hit-testing), the delete
  UI (single + bulk, including the two-stage confirm), and Prev/Next
  navigation (including keyboard).
- After implementation: real-browser verification again, per CLAUDE.md's
  "Testing philosophy" section and this session's own direct experience
  — the previous browser pass proved the pipes connect, this pass needs
  to re-verify with a human actually looking at what renders, since
  that's exactly the gap this whole fix round exists to close.

## Out of scope (explicitly, not overlooked)

- Reworking `CascadingLabelPicker`'s underlying select-cascade logic —
  only its visual styling is in scope here, not its behavior (already
  correct and tested).
- SAM-3 tab remains disabled (unchanged reason: GPU VRAM) — no part of
  this pass touches that.
- A full custom dropdown/combobox component library — native `<select>`
  elements, styled, are sufficient for this panel's needs.
