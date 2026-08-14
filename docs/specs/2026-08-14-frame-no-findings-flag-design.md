# Frame "no findings" review flag

Date: 2026-08-14
Status: approved

## Problem

Polyp findings are annotated as `Annotation` rows of type `MASK`/`BBOX`,
scoped to individual frames within a sequence. A frame with no `Annotation`
row today is ambiguous: it might genuinely show no polyp, or it might
simply be a frame nobody has reviewed yet. Any future YOLOv11/12 detection
or segmentation training needs explicit background images (frames known to
contain no target object) to avoid learning "there's always a polyp
somewhere in this crop" — but treating every unannotated frame as a
background image would silently poison training with frames that were
never actually checked.

Frame-level `Annotation`s of type `CLASSIFICATION` (the mechanism added for
Tags/taxonomy work) are for anatomical landmarks, frame quality, and
instrument/artifact labels — not findings. Findings are annotated by
segmentation (mask → derived bbox), so "no findings on this frame" is not a
taxonomy label and does not belong in that system: an annotator reviewing a
sequence for background frames is asserting an absence, not classifying a
presence.

## Decision

Add an explicit, frame-level "reviewed, no findings" flag, set manually by
an annotator per frame (not per sequence — a sequence may contain both
finding and non-finding frames, and blanket-marking a whole sequence risks
false negatives from frames that were never actually looked at).

### Data model

`backend/app/media/models.py`, `Frame`:

```python
no_findings_reviewed: Mapped[bool] = mapped_column(Boolean, default=False)
no_findings_reviewed_by_id: Mapped[int | None] = mapped_column(ForeignKey("users.id"), nullable=True)
no_findings_reviewed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
```

New Alembic migration adding these three columns, default `false`/`NULL`
for existing rows.

### Conflict rule

A frame cannot simultaneously carry `no_findings_reviewed = true` and have
any `Annotation` row (`MASK`, `BBOX`, or `CLASSIFICATION` — all three are
positive assertions about frame content, so all reset the flag). Two
enforcement points, since two independent codebases write `Annotation`
rows against the same database:

1. **Setting the flag** (`bulk-mark-no-findings`, backend API): frames that
   already have at least one `Annotation` are skipped, not overridden.
   The response reports which frame IDs were actually marked vs. skipped so
   the UI can surface it.
2. **Creating an annotation on an already-flagged frame** (auto-clear):
   every code path that inserts an `Annotation` row must reset
   `no_findings_reviewed` to `false` (and clear the by/at columns) for that
   frame in the same transaction, silently — no error, since "annotator
   changed their mind and drew a mask" is the expected way this happens.
   This applies in both:
   - `backend/app/annotation/service.py` — `create_classification_annotation`
     and `bulk_classify_frames` (mask/bbox creation for manual annotation
     goes through this module's `AnnotationCreate` flow too — verify at
     implementation time whether mask/bbox creation shares
     `create_classification_annotation` or has its own function; reset
     must cover whichever function(s) actually insert `Annotation` rows).
   - `ml-worker/app/tasks.py` — four call sites construct `Annotation(...)`
     directly for SAM2/SAM3 job output (lines ~209, ~266, ~336, ~443 as of
     this writing). Each must reset the flag on its target frame the same
     way. Factor into a small shared helper if the four sites are
     structurally similar enough to avoid four copies of the same four-line
     update; otherwise four inline resets are acceptable — don't force an
     abstraction across a worker and the main API that don't share a
     module.

### API

`backend/app/annotation/router.py`, new endpoints alongside the existing
`bulk-classify` / `bulk-clear-classification` pair:

- `POST /annotation/frames/bulk-mark-no-findings`
  Request: `{frame_ids: list[int]}`.
  For each frame: if it has zero `Annotation` rows, set
  `no_findings_reviewed = true`, `no_findings_reviewed_by_id =
  current_user.id`, `no_findings_reviewed_at = now()`. Frames that already
  have annotations are left untouched.
  Response: `{marked_frame_ids: list[int], skipped_frame_ids: list[int]}`
  (skipped = had existing annotations).

- `POST /annotation/frames/bulk-clear-no-findings`
  Request: `{frame_ids: list[int]}`.
  Unconditionally sets `no_findings_reviewed = false` and clears the
  by/at columns for the given frames (manual undo, independent of the
  auto-clear-on-annotation path).
  Response: `{frame_ids: list[int]}`.

`backend/app/media/schemas.py` — extend whatever schema already returns
`Frame` rows to the sequence grid (`FrameRead` or equivalent) with
`no_findings_reviewed: bool`, so the grid can render the badge without an
extra round trip per frame.

### Frontend

`frontend/src/features/annotation/SequenceGridToolbar.tsx`: in select mode,
add a **"Mark no findings"** button next to the existing classification
controls, calling `bulk-mark-no-findings` on the current selection. When
every selected frame already has the flag set, show **"Unmark"** instead,
calling `bulk-clear-no-findings`. Mixed selections (some flagged, some not)
default to showing "Mark no findings" (marking is idempotent/skip-based, so
this is always safe to offer).

`frontend/src/features/annotation/FrameThumbnail.tsx` (or wherever the grid
renders each frame tile): small badge/checkmark overlay when
`frame.no_findings_reviewed` is true, so progress through a sequence is
visible without opening the frame editor.

If `bulk-mark-no-findings` reports skipped frames (had existing
annotations), surface that back to the user — a toast or inline count
("3 marked, 1 skipped (already annotated)") is sufficient; no need for a
modal or per-frame breakdown.

## Out of scope

- **YOLO dataset export** (reading `no_findings_reviewed` frames as
  Ultralytics "background images", classification-dataset folders, or any
  train/val split generation). Explicitly reserved for Phase 2 per
  CLAUDE.md ("ML worker... dataset export... reserved for Phase 2, not
  started"). This spec only produces the review signal in the database;
  nothing consumes it yet.
- **Hard-negative curation guidance** (deliberately seeking frames with
  glare/folds/bubbles that resemble a polyp, vs. arbitrary clean frames) is
  a data-collection workflow question for whoever curates training sets
  later, not a platform feature.
- **Sequence-level "fully reviewed" rollup** (e.g., a sequence-level badge
  summarizing what fraction of its frames have been reviewed one way or
  another) — not requested, not built here.
- **Frame editor (single-frame) UI** for toggling the flag — this spec only
  wires it into the sequence grid's existing Select-mode bulk-action
  pattern, matching how classification/quality/delete already work there.
  A single-frame toggle in the frame editor itself can be added later if it
  turns out to matter.
