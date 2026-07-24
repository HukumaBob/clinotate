# Frame editor: backend gaps + frontend design

Status: approved, ready for implementation planning.

## Context

The platform has no real frame editor yet — only `SegmentButton.tsx`, a
Phase 2a placeholder (one button, one SAM-3 point prompt, no box/mask
prompts, no track, no label picker, no mask list). Backend for both
segmentation adapters is complete and tested: `/jobs/sam3/predict`,
`/jobs/sam3/track`, `/jobs/sam2/predict`, `/jobs/sam2/track` (Phase 2a,
Phase 2a.2). The UI/UX has already been designed and approved across
several iterations:
[docs/specs/2026-07-23-platform-ui-ux-design.md](../../specs/2026-07-23-platform-ui-ux-design.md),
"Frame editor" section. This document does not re-derive that layout — it
translates it into a concrete backend contract and frontend architecture,
and resolves three backend gaps discovered while doing so.

## Backend gaps found during design (not present in the approved UI spec)

Investigating what the frontend can actually call surfaced three points
where the current backend can't yet serve what the UI spec assumes. All
three are small, targeted additions to existing modules/tables — not new
domains, not a redesign.

### 1. Video-less sequences

The sibling Django project (`/mnt/work-disk/Documents/Dev/segmentation`)
modeled `Sequences.video` as `null=True, blank=True`, with `Procedure` as
the grouping root for sequences built from standalone frame sets (e.g. a
downloaded set of polyp images with no source video) — a real, previously
solved case, not a hypothetical. The current schema has
`Sequence.video_id` as a required FK, so this case cannot exist today.

**Decision:** `Sequence.video_id` becomes nullable; `Sequence` gains its
own nullable `procedure_id` FK to `Procedure` — independent from
`Label.procedure_id` (that field means "which procedure this tag applies
to"; `Sequence.procedure_id` means "which procedure these frames were
captured during" — same `procedures` table, two distinct relationships,
named consistently on purpose).

New surface:
- `POST /media/sequences` — video-less create, takes `procedure_id`
  (required — the whole point of this path is having a grouping root
  when there's no video), mirroring the existing
  `SequenceCreate(start_time, duration)` shape otherwise (both default to
  `0` when there's no source video to derive them from).
- `POST /media/sequences/{id}/frames/upload` — attach standalone frame
  images directly (no ffmpeg extraction path — direct image upload,
  reusing `StorageService`).
- `GET /media/procedures/{id}/sequences` — entry point into video-less
  sequences.

This is scoped as a data-model correction landing in this session, not a
deferred Phase 2b item — the Sequences list screen and Dataset screen in
the UI spec will need this eventually, but this session only needs the
model + minimal endpoints to unblock the grid entry point below; a
dedicated upload UI for standalone frame sets is not in this session's
scope.

### 2. Sequences-by-video listing

`GET /media/videos/{video_id}/sequences` doesn't exist (only
`POST .../sequences` to create one). Symmetric with the existing
`list_frames_media_sequences__sequence_id__frames_get` pattern.

### 3. Cascading label tree

The UI spec's Category → Classification → Tag picker needs "all root
labels, each with its children" cheaply. Today only
`GET /taxonomy/labels` (flat) and `GET /taxonomy/labels/{id}/descendants`
(one parent at a time) exist — building the tree client-side would mean
fetching the flat list then N descendant calls.

**Decision:** add `GET /taxonomy/labels/tree` →
`{category: LabelRead, children: LabelRead[]}[]`, built server-side in one
query (root = labels with no incoming `LabelRelation.child_id`).

### 4. Mask visibility on annotations

`AnnotationRead` doesn't expose `storage_key` — the frame editor cannot
overlay existing masks on the canvas or show mask previews in the masks
list without it. Following the existing `FrameRead.image_url` pattern
(computed presigned URL, not a raw key), `AnnotationRead` gains
`mask_url: str | None`, resolved via `StorageService.url_for` in the
router the same way `_frame_read` does today.

All four are TDD, following this codebase's existing test patterns for
each module (`backend/tests/test_media.py`, `test_taxonomy.py`,
`test_annotation.py`).

## Frame editor frontend

### Scope for this session

- Sequence grid screen (minimal — thumbnail grid + in-place swap to the
  editor). **No Select mode / bulk cleanup** (find-similar, rank-quality,
  bulk delete) — out of scope, per the UI spec's own "Select mode" being a
  separable sub-feature.
- Frame editor itself, full UI spec fidelity: model tabs, gesture-driven
  point/box/mask prompts, cascading label picker, color picker, track
  controls, masks list with highlight-on-click.
- No Sequences list screen, no Tags screen, no Select mode — those stay
  unbuilt; the grid route is reached directly (`/videos/:videoId/sequences/:sequenceId`)
  rather than through a catalog screen that doesn't exist yet.

### Sequence grid screen

`SequenceGridPage.tsx` — full-viewport frame grid per the UI spec.
Thumbnails render the raw frame image with a lightweight client-side
label strip (colored dot + tag name per annotation on that frame, from
`useAnnotations(frameId)`) — full baked-in mask-overlay thumbnails are a
possible future optimization, not required for this session since the
editor itself (not the grid) is where masks need to be pixel-accurate.

Clicking a thumbnail swaps the grid for `FrameEditor` **in place**: a
local `selectedFrameId` state toggle inside the page component, not a
route change — matching the spec's explicit rejection of both a modal and
a separate route. A `✕ Back to grid` control clears the selection.

### Frame editor architecture

```
features/annotation/
  FrameEditor.tsx          — two-column layout (image fills remaining
                              space, tools panel fixed ~270px); owns the
                              Zustand store instance for this editor session
  frameEditorStore.ts       — Zustand store: activeModel ('sam2'|'sam3',
                              default 'sam2'), activeTool ('point'|'box'|
                              'mask'), pendingPrompts, selectedAnnotationId,
                              labelCategory/labelClassification/labelTag,
                              color, backward/forward
  FrameCanvas.tsx            — <canvas>, hand-rolled (no library): draws
                              the frame image, then each existing mask as a
                              semi-transparent fill from mask_url, then live
                              prompt overlay (points/box/freehand mask
                              brush). Mouse handling: left-click = point,
                              left-drag = box, Ctrl+left-click = remove a
                              shape, freehand brush only active when
                              activeTool === 'mask'. Brush strokes rasterize
                              to a PNG (canvas.toDataURL) for mask_png.
  ToolsPanel.tsx              — SAM-3/SAM 2.1 tabs, Point/Box/Mask row
                              (Mask only, since point/box are gesture-only),
                              CascadingLabelPicker, color picker + "Add
                              mask" button, TrackControls, MasksList — one
                              shared markup block per the spec, not
                              duplicated per model tab
  CascadingLabelPicker.tsx    — Category → Classification → Tag, backed by
                              GET /taxonomy/labels/tree. Replaces the flat
                              LabelPicker for this use; the existing
                              LabelPicker.tsx stays as-is (still used
                              elsewhere / reusable for a future Tags screen)
  MasksList.tsx                — scrollable list of the current frame's
                              annotations; click sets selectedAnnotationId
                              (drives canvas highlight) and fills the label
                              picker + color fields from that annotation
  TrackControls.tsx            — Backward/Forward numeric inputs (small
                              nonzero defaults, never blank), single
                              "Track" button
```

Job submission reuses the existing `useJob` polling hook unchanged;
`activeModel` selects `/jobs/sam2/*` vs `/jobs/sam3/*` at the call site.
`Sam2TrackRequest`'s extra fields (`anchor_frame_id`, `backward`,
`forward`) come from the store's Backward/Forward inputs and the
currently open frame.

### State management

Zustand, per the design spec's own Client/UI-state table ("current frame,
active tool, unsaved SAM points" — explicitly named there, not yet
introduced anywhere in the codebase). The store is scoped to one
`FrameEditor` mount (created/torn down with it), not a global singleton —
justified by store shape spanning ~4-5 nested components (canvas, tools
panel, cascading picker, masks list, track controls) that all need to
read or write the same in-progress prompt/label state; prop-drilling that
depth was judged worse than the Zustand dependency the design spec already
anticipated.

### Canvas rendering

Hand-rolled HTML5 `<canvas>`, no drawing library. Draw order: frame image
→ each existing mask (semi-transparent fill, brighter outline if
`selectedAnnotationId` matches) → live prompt gesture feedback. The same
canvas handles both point/box gesture capture and freehand mask-brush
drawing (mode-gated on `activeTool`), and rasterizes brush strokes via
`canvas.toDataURL()` for the `mask_png` prompt field — avoids running two
separate coordinate systems (SVG overlay + canvas export) for what is
fundamentally one drawing surface.

## Testing

TDD throughout, per CLAUDE.md:
- Backend: failing test first for each of the 4 gaps, in the relevant
  module's existing test file.
- Frontend: Vitest + Testing Library, following `FrameAnnotationPage.test.tsx`'s
  existing style of mocking `apiClient`.
- After implementation: real-browser verification (`npm run dev`, actually
  click through grid → editor → point/box/mask prompts → track → masks
  list), per CLAUDE.md's "Testing philosophy" section — this project has
  found three real bugs that only a real browser catches.

## Sequencing

1. Backend gaps (1)-(4), TDD, each independently testable/committable.
2. Regenerate `openapi.json` (`backend/scripts/export_openapi.py`) once
   all four land, so `npm run generate-api` picks up `/jobs/sam2/*`,
   `/media/videos/{id}/sequences`, `/media/sequences` (video-less),
   `/media/procedures/{id}/sequences`, `/taxonomy/labels/tree`, and
   `AnnotationRead.mask_url` — none of these currently appear in the
   committed `openapi.json`, so the frontend can't be typed against them
   until this regeneration happens.
3. Sequence grid screen.
4. Frame editor (store, canvas, tools panel, cascading picker, masks
   list, track controls) — the largest single piece.
5. Real-browser verification pass.

## Out of scope (explicitly, not overlooked)

- Sequences list screen, Tags screen, Select mode/bulk cleanup — separate
  UI-spec sections, not touched this session.
- A dedicated upload UI for standalone (video-less) frame sets — the
  backend model/endpoints from gap (1) land, but no frontend screen
  consumes `POST /media/sequences` / `.../frames/upload` yet.
- Baked-in mask-overlay thumbnails in the grid (server-side composited
  preview images) — the grid uses a client-side label-strip instead.
