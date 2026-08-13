# Sequence grid: frame-level classification labeling

## Problem

The platform has two annotation flavors today: geometric (bbox/mask, for
polyp detection) and morphological (finer structures, NICE-style
classification) — both region-tied. There's no way to tag a whole frame
with a single class for training a YOLO *classification* model: anatomical
landmarks (antrum, GE junction, larynx), procedure artifacts (mouthpiece,
transparent cap, scope out-of-body), or exam quality (good/low), each
independently.

The sequence grid (`SequenceGridPage.tsx`/`SequenceGridToolbar.tsx`,
shipped 2026-08-06, extended with Rank Quality/Find Similar 2026-08-12)
already has a Select mode with per-frame checkboxes and a toolbar that
performs bulk actions against the current selection. This spec adds a
third bulk action to that toolbar: assign or clear a frame-level
classification label across the selected frames.

Dataset export (a YOLO-cls-format download, or any other export) is
explicitly **out of scope** — the user's stated plan is a future unified
"Dataset" screen that builds balanced datasets for classification,
detection, and segmentation together, and export for all three will be
designed there, not bolted onto this feature ad hoc. This spec produces
only the labeled data that a future export would read from.

## Goals

1. Let an annotator select frames in the sequence grid (reusing the
   existing checkbox Select mode) and assign a classification label to
   all of them in one action, without opening the frame editor.
2. Support multiple independent classification axes per frame (e.g. a
   frame can be both "antrum" and "low quality" at once), while each axis
   individually holds at most one label per frame (a frame cannot be both
   "antrum" and "GE junction").
3. Let an annotator clear a classification axis from selected frames.
4. Show existing classification labels as badges on each frame's
   thumbnail in the grid.
5. Taxonomy management (creating the classes) reuses the existing admin
   Tags screen — no new admin UI.

## Non-goals

- Dataset/YOLO export in any format — future "Dataset" screen, separate
  spec.
- Multi-label *within* one axis (e.g. two landmarks on one frame) — out
  of scope per the single-label-per-axis decision below.
- Per-frame single-thumbnail label editing UI (a dropdown on each
  thumbnail) — the toolbar bulk-action flow is the only entry point for
  v1; the frame editor's existing Label picker is unaffected by this spec
  and remains a secondary way to set the same label on one frame at a
  time.
- Changing how Rank Quality/Find Similar/Delete work — reused unmodified.

## Taxonomy shape

The existing taxonomy tree is `Category -> EvaluationType -> [Label]`
(`taxonomy/service.py:get_taxonomy_tree`) — `Category` and
`EvaluationType` are independent axes on `Label`, joined only through it;
`EvaluationType` is not nested inside `Category` or vice versa in the
schema, but the tree endpoint groups by `Category` first, then
`EvaluationType`, for display.

This spec adds one new `EvaluationType` row, **"Frame classification"**,
created once via the admin Tags screen (no code change — same mechanism
as `geometric`/`morphological`). Each independent classification axis
(landmark, artifact, quality, ...) is a separate `Category` (e.g.
"Landmark", "Artifact", "Quality"), each holding the `Label`s for that
axis, all tagged with the "Frame classification" `EvaluationType`. No new
tables, no new columns, no Alembic migration — this is pure taxonomy data
entry through the screen that already exists.

**Single-label-per-axis invariant:** for a given frame, among
`Annotation` rows whose label has `evaluation_type = "Frame
classification"`, at most one may exist per distinct `category_id`. This
is enforced in the service layer (see below), not a DB constraint —
consistent with how `taxonomy_version` copying and other annotation
invariants in this codebase are already service-layer, not
constraint-layer.

## Backend

Two new endpoints in `annotation/router.py`, backed by two new service
functions in `annotation/service.py`. Both operate on `Annotation` rows
already scoped to `annotation_type = CLASSIFICATION` — no new
`AnnotationType` member needed (`CLASSIFICATION` already exists and is
already used by `create_classification_annotation`, just not from a bulk
entry point yet).

```
POST /annotation/frames/bulk-classify
body: { frame_ids: number[], label_id: number }
```

For each `frame_id`: resolve the label's `category_id`; delete any
existing `Annotation` on that frame with `annotation_type=CLASSIFICATION`
whose label belongs to the same `category_id`; insert a new `Annotation`
with the new `label_id` and the label's current `taxonomy_version`. All
frames processed in one transaction. Returns the updated frame IDs.

```
POST /annotation/frames/bulk-clear-classification
body: { frame_ids: number[], category_id: number }
```

For each `frame_id`: delete any existing `Annotation` with
`annotation_type=CLASSIFICATION` whose label belongs to `category_id`.
Same transaction/response shape.

Both are synchronous (no `Job`/Celery involved) — this is a plain
multi-row DB write, not an ML computation; even for hundreds of frames
it's a millisecond-scale operation, unlike Rank Quality/Find Similar
which require GPU inference and therefore the async `Job` pattern.

## Frontend

**Toolbar** (`SequenceGridToolbar.tsx`): a new control group in the
existing Select-mode toolbar, alongside Rank Quality/Find Similar:

- A `Category` select, populated from `useTaxonomyTree` filtered to
  categories that have at least one label under the "Frame
  classification" evaluation type.
- A `Label` select, populated from the labels of the chosen Category
  under that evaluation type.
- An **Assign** button — enabled when a Label is chosen and
  `selectedFrameIds.size > 0`; calls the bulk-classify mutation with the
  current selection.
- A **Clear** button — enabled when a Category is chosen (Label
  optional) and `selectedFrameIds.size > 0`; calls the
  bulk-clear-classification mutation.

Both mutations follow the existing `useDeleteFrames` pattern
(`useFrames.ts`): a synchronous `useMutation`, invalidating the affected
frames'/sequence's annotation queries on success — no job polling, unlike
`useRankQuality`/`useFindSimilar`.

**Thumbnail** (`FrameThumbnail.tsx`): already renders a badge per
annotation regardless of mask presence (existing behavior, unchanged
code path). This spec relies on that: once a bulk-classify call creates a
`CLASSIFICATION` annotation, it shows up as a badge automatically. The
only addition is using `label.color` for the badge background (currently
those badges are undifferentiated) so different axes are visually
distinguishable at a glance — one badge per Category the frame has a
label in.

**Selection mechanics**: fully reused — `selectedFrameIds`,
`isSelectMode`, the existing checkbox rendering. No changes to
`autoCheckedFrameIds`/`frameMarkReasons` (those stay specific to Rank
Quality/Find Similar's auto-check-with-reason UX; manual classification
assignment doesn't auto-check anything, it acts on whatever's already
checked).

## Data flow / error handling

- Assign/Clear apply to exactly the frames currently in
  `selectedFrameIds` at click time — no confirmation dialog (unlike
  Delete's two-click arm/confirm pattern), since both are non-destructive
  of geometry/mask annotations and reversible by re-assigning or
  re-clearing.
- If the bulk mutation fails partway (e.g. a `frame_id` no longer
  exists), the whole transaction rolls back — no partial-apply state to
  reconcile in the UI.
- Selection is not cleared after Assign/Clear, so an annotator can apply
  a second axis (e.g. Quality) to the same selection immediately after
  applying the first (e.g. Landmark) without re-selecting frames.

## Testing

Backend: TDD per `CLAUDE.md` — failing tests first for
`bulk_classify_frames`/`bulk_clear_classification` service functions
(replace-within-category behavior, cross-category independence,
transaction rollback on partial failure) and their router endpoints.

Frontend: unit tests for the new toolbar controls (Category/Label
cascading select, button enablement) with `apiClient` mocked, per
existing `SequenceGridToolbar` test conventions.

Manual verification: per `CLAUDE.md`'s testing philosophy, exercise the
full flow against the real running stack — create the "Frame
classification" evaluation type and a couple of categories/labels via
the Tags screen, select frames in a real sequence, assign labels across
two different categories to the same frames, confirm both badges render,
clear one, confirm only that badge disappears.
