# EvaluationType annotation scope

Date: 2026-08-15
Status: approved

## Problem

`SequenceGridToolbar.tsx` filters the taxonomy tree for frame-level
classification categories by comparing `evaluation_type.name ===
"Frame classification"` (a hardcoded string constant, default value of the
`frameClassificationEvaluationTypeName` prop). The real evaluation type
name imported into the dev database is `frame_classification`
(lowercase, underscore) — the comparison never matches, so the
sequence grid's Select-mode "Category…" dropdown is always empty and the
whole-frame classification feature (used for e.g. no-findings marking,
Task 2026-08-14) is unusable through that UI.

The deeper problem: which "mode" an `EvaluationType` axis belongs to —
whole-frame classification (`Landmark`, `Quality` in the current
taxonomy) versus part-of-frame mask/bbox annotation (`Anatomy`,
`Artifacts`, `Findings`) — is not stored as data anywhere. It exists only
as an informal convention in the taxonomy author's head, expressed
(inconsistently) through naming. `CascadingLabelPicker.tsx` (the frame
editor's SAM2/SAM3 mask-annotation label picker) has the same latent
issue in the other direction: it shows every evaluation type with no
filtering at all, so a whole-frame axis like `frame_classification` can
currently be selected there, and an annotator could attempt to draw a
mask against it — a category error the UI does nothing to prevent.

## Decision

Add an explicit `annotation_scope` field on `EvaluationType`, so the
mode is queryable data rather than an implicit naming convention.

### Data model

`backend/app/taxonomy/models.py`:

```python
class AnnotationScope(str, enum.Enum):
    FRAME = "frame"      # whole-frame classification
    REGION = "region"    # mask/bbox on part of the frame

class EvaluationType(Base):
    __tablename__ = "evaluation_types"

    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String(100), unique=True)
    annotation_scope: Mapped[AnnotationScope] = mapped_column(Enum(AnnotationScope))
```

Non-nullable — every evaluation type must declare its scope explicitly at
creation time; no default that could quietly reintroduce this bug's root
cause (a mode inferred rather than stated).

New Alembic migration: add the column, backfill existing rows by known
name (`geometric` → `region`, `morphological` → `region`,
`frame_classification` → `frame` — the three evaluation types present in
the dev database at design time), then set `nullable=False`.

### Taxonomy JSON export format

`backend/app/taxonomy/data/imported_taxonomy.json` currently has no
`evaluation_types` concept as a top-level entity — each `labels` entry
carries a `label_type` string, and `import_taxonomy.py` creates an
`EvaluationType` row on first encountering a new `label_type` value, with
no record of what scope it should have.

Add a new top-level array:

```json
"evaluation_types": [
  {"name": "geometric", "scope": "region"},
  {"name": "morphological", "scope": "region"},
  {"name": "frame_classification", "scope": "frame"}
]
```

This becomes the single source of truth for scope; `label_type` strings on
individual `labels` entries continue to work exactly as before as the
means of assigning a label to an evaluation type by name.

### Import behavior

`backend/app/taxonomy/import_taxonomy.py`, `import_taxonomy()`: build a
`scope_by_evaluation_type_name` dict from the new `evaluation_types` array
before processing `labels`. When creating an `EvaluationType` row on
first encountering its name (current logic: `if evaluation_type_name not
in evaluation_type_by_name: ... EvaluationType(name=evaluation_type_name)
...`), look up its scope in that dict and pass it to the constructor. If
a `label_type` name appears in `labels` with no corresponding entry in
the new `evaluation_types` array, raise a clear error (e.g. `ValueError(f"label_type
'{evaluation_type_name}' has no corresponding entry in evaluation_types
— add its scope before importing")`) rather than defaulting or skipping
silently — an unscoped evaluation type is exactly the bug this change
fixes, so the importer must not be able to reintroduce it.

### Backend API

`backend/app/taxonomy/schemas.py`: `EvaluationTypeCreate` gains a
required `annotation_scope: AnnotationScope` field. `EvaluationTypeRead`
(or wherever `EvaluationType` rows are serialized, including within
`taxonomy/tree`'s response) includes it too, so frontend consumers can
filter on it.

`backend/app/taxonomy/router.py`: `POST /taxonomy/evaluation-types`
requires `annotation_scope` in the request body (enforced by the
now-required schema field — no handler-level change needed beyond
whatever construction call passes the field through to the model).

### Frontend — Tags UI

`frontend/src/features/tags/ClassificationsPanel.tsx`: the "create new
evaluation type" form currently takes only a name (`createEvaluationType.mutateAsync({
name: newName.trim() })`). Add a required Frame/Region choice (e.g. two
radio buttons or a `<select>`) alongside the name input, and include it
in the create call's payload.

### Frontend — consumers

`frontend/src/features/annotation/SequenceGridToolbar.tsx`:
`classificationCategories` (the `useMemo` that currently does
`node.evaluation_types.find((candidate) => candidate.evaluation_type.name
=== frameClassificationEvaluationTypeName)`) changes the predicate to
`candidate.evaluation_type.annotation_scope === "frame"`. Remove the
`frameClassificationEvaluationTypeName` prop entirely (from the props
interface, the destructured parameters with its default, and the one
call site in `SequenceGridPage.tsx` that currently passes
`frameClassificationEvaluationTypeName="Frame classification"`) — it is
fully superseded by the data-driven filter and keeping it around as dead
config would just reintroduce the same class of drift risk.

`frontend/src/features/annotation/CascadingLabelPicker.tsx`:
`evaluationTypeOptions` (currently `selectedCategory?.evaluation_types ??
[]`, unfiltered) changes to filter for `annotation_scope === "region"`
before rendering the picker's evaluation-type options — a whole-frame
axis can no longer be selected as a target for mask/bbox annotation.

## Testing

- Backend: `import_taxonomy()` test asserting a `label_type` with no
  matching `evaluation_types` entry raises the clear error described
  above, and a test asserting a successful import correctly sets
  `annotation_scope` on the created `EvaluationType` rows. A
  `POST /taxonomy/evaluation-types` test asserting the endpoint 422s
  when `annotation_scope` is omitted, and a test asserting `GET
  /taxonomy/tree` includes `annotation_scope` in its evaluation-type
  payload.
- Frontend: `SequenceGridToolbar.test.tsx` — update/add a test asserting
  the category dropdown includes only categories whose evaluation type
  has `annotation_scope: "frame"`, using realistic fixture data (mixed
  `frame`/`region` scopes, non-"Frame classification"-shaped names) so a
  future refactor can't silently reintroduce a name-based comparison.
  `CascadingLabelPicker.test.tsx` — same idea, asserting `region`-scoped
  evaluation types are offered and `frame`-scoped ones are not.
  `ClassificationsPanel.test.tsx` — assert the create form requires a
  scope choice and includes it in the mutation payload.

## Out of scope

- No retroactive scope-correction UI for evaluation types created before
  this change ships beyond the migration's own backfill — the backfill
  covers every row that exists in the dev database at design time (all
  three real evaluation types currently in use).
- No change to `AnnotationType` (`CLASSIFICATION`/`MASK`/`BBOX` on
  `Annotation` rows) — that enum already correctly distinguishes what kind
  of annotation payload a row holds; `annotation_scope` is a taxonomy-side
  concept (what an axis is *for*), not an annotation-side one (what shape
  of data was recorded). The two are related but not merged: a `frame`-scope
  evaluation type's labels are always used with `AnnotationType.CLASSIFICATION`,
  and a `region`-scope evaluation type's labels are always used with
  `AnnotationType.MASK`/`BBOX` — this relationship is enforced by the two
  UI filters added here, not by a new database constraint.
