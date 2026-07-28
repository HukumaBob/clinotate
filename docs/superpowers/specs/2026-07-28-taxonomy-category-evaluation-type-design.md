# Taxonomy schema redesign: Category + EvaluationType as first-class entities

## Why this doc exists

Yesterday's taxonomy import (149 labels, 160 relations, sourced from the
`segmentation` reference project's live `db.sqlite3`) surfaced a real
schema gap: the current `Label`/`LabelRelation` model has no place for
"category" (anatomy/findings/artifacts/quality/mode) as its own concept —
`get_label_tree` treats *any* root label (one with no parent in
`LabelRelation`) as a category, so category and tag live in the same
table with no structural distinction. The import worked around this by
synthesizing root `Label` rows per category, but this just reproduced the
same problem the user was already fighting: `jobs-test-label`, `Landmark`,
`GI Tract` (backend test fixtures, created by hitting the real dev DB
directly per CLAUDE.md's testing-philosophy note) sit in the exact same
list as the real `Anatomy`/`Findings` category nodes, with nothing in the
data model saying which is which.

The user's actual mental model, stated directly: for a given `Procedure`
(e.g. colonoscopy), there is a fixed 4-level hierarchy —

```
Procedure → Category (anatomy | findings | artifacts | quality | mode)
          → EvaluationType (morphological | geometric)
          → Tag (flat list, no further nesting)
```

Both `Category` and `EvaluationType` must be fully editable through the
API/DB — not hardcoded enums — because the taxonomy itself is expected to
change over time without a deploy.

## Data model

```
Procedure(id, name unique)                                    -- unchanged

Category(id, name, procedure_id FK -> Procedure)
  unique(name, procedure_id)                                  -- no duplicate category per procedure

EvaluationType(id, name unique)                                -- global, not per-procedure

Label(id, name, color, category_id FK -> Category,
      evaluation_type_id FK -> EvaluationType,
      taxonomy_version, created_at)
```

`LabelRelation` (parent_id/child_id/confidence) is removed entirely — the
user confirmed tags never nest inside a branch (flat list under each
Category+EvaluationType pair, always, no exceptions). The existing
`taxonomy_version` invariant (CLAUDE.md: copy at `Annotation` creation
time, never re-derive later) is unchanged — it still lives on `Label` and
gets snapshotted into `Annotation.taxonomy_version` exactly as today.

`Category` is per-procedure (confirmed: colono has no `mode` category in
the imported reference data, and that's expected — a procedure simply
doesn't show a category it has no tags under, not an error).
`EvaluationType` ("morphological", "geometric") is a small global
vocabulary shared across all procedures.

## API contract (backend)

New/changed REST resources under `/taxonomy`, full CRUD on each level:

```
POST   /taxonomy/procedures                    (unchanged)
GET    /taxonomy/procedures                    (unchanged)

POST   /taxonomy/categories        {name, procedure_id}
GET    /taxonomy/categories?procedure_id=...
PATCH  /taxonomy/categories/{id}   {name?}
DELETE /taxonomy/categories/{id}               -- 409 if any Label references it

POST   /taxonomy/evaluation-types  {name}
GET    /taxonomy/evaluation-types
PATCH  /taxonomy/evaluation-types/{id} {name?}
DELETE /taxonomy/evaluation-types/{id}         -- 409 if any Label references it

POST   /taxonomy/labels    {name, color, category_id, evaluation_type_id}
GET    /taxonomy/labels?category_id=...&evaluation_type_id=...
PATCH  /taxonomy/labels/{id}
DELETE /taxonomy/labels/{id}
```

Removed: `POST /taxonomy/labels/relations`, `GET
/taxonomy/labels/{id}/descendants` — both `LabelRelation`-specific,
meaningless once tags don't nest.

Replaced: `GET /taxonomy/labels/tree` becomes `GET
/taxonomy/tree?procedure_id=...`, returning the full hierarchy for one
procedure in one call (the cascading picker needs every category up
front to populate its first `<select>`, not one category at a time):

```json
[
  {
    "category": {"id": 1, "name": "Anatomy"},
    "evaluation_types": [
      {
        "evaluation_type": {"id": 1, "name": "geometric"},
        "labels": [{"id": 10, "name": "pharynx", "color": "#2E81DA"}, ...]
      },
      ...
    ]
  },
  ...
]
```

## Migration and data plan

Current dev DB state (as of 2026-07-28): all `labels`/`label_relations`/
`annotations` rows are today's test/import churn — the user explicitly
chose to wipe them rather than migrate, since none of it is real
production data yet. `procedures` rows (`egds`, `colono`, plus assorted
backend-test procedures) are kept as-is.

Alembic migration steps:
1. Create `categories`, `evaluation_types` tables.
2. Add `Label.category_id` (FK, NOT NULL), `Label.evaluation_type_id`
   (FK, NOT NULL) — safe to add as NOT NULL directly since `labels` will
   be empty at migration time (wiped first), no backfill needed.
3. Drop `Label.label_type` column and the Postgres `labeltype` enum type.
4. Drop the `label_relations` table.

Re-import: `backend/app/taxonomy/import_taxonomy.py` is rewritten against
the new schema. It reads the same `backend/app/taxonomy/data/
imported_taxonomy.json` from yesterday (each entry already carries
`category` and `label_type` fields from the sqlite export) but now
creates/finds `Category` (per procedure) and `EvaluationType` instead of
synthesizing root `Label` rows and `LabelRelation` edges. Yesterday's
synthetic category-root `Label` entries (`"Anatomy"`, `"Findings"`, etc.)
are dropped from the import — category is a real entity now, not a
`Label`.

## Frontend changes

- `frontend/src/entities/useLabelTree.ts` → replaced by
  `frontend/src/entities/useTaxonomyTree.ts`, a hook hitting `GET
  /taxonomy/tree?procedure_id=...`.
- Getting `procedure_id` to `CascadingLabelPicker`: today's `FrameEditor`
  only has `frameQuery.data.sequence_id` (a `FrameRead` field), not a
  `procedure_id` directly — `SequenceRead` has `procedure_id`, but no
  `useSequence(sequenceId)` hook exists yet to fetch it. `FrameEditor`
  gains one (new, thin — mirrors the shape of the existing `useFrame`/
  `useAnnotations` hooks in `frontend/src/entities/`), and passes the
  resulting `procedure_id` down through `ToolsPanel` into
  `CascadingLabelPicker` as a new required prop. If a frame's sequence
  has `procedure_id: null` (nullable per `SequenceRead`), the picker
  renders its existing "no options" empty state rather than fetching —
  same as today's behavior when the label tree query has no data yet.
- `frontend/src/features/annotation/CascadingLabelPicker.tsx` — already
  structured as a 3-level cascade (category → classification filter →
  tag), so the UI shape doesn't change. Only the data it reads changes:
  today it derives "classification options" by deduplicating
  `child.label_type` strings from a flat children array; with the new
  schema it reads `node.evaluation_types[].evaluation_type` directly (an
  explicit list, not a derived set), and the tag `<select>` reads
  `selectedEvaluationType.labels` instead of filtering `children` by
  `label_type`.
- `frontend/src/features/annotation/frameEditorStore.ts` — the store's
  `labelCategoryId`/`labelClassification`/`labelTagId` fields keep their
  names and roles; `labelClassification` changes meaning from "a
  `LabelType` enum string" to "an `EvaluationType` id" (a number, like
  the other two fields already are).

No new frontend screen for managing Category/EvaluationType/Label in
this pass — that CRUD is backend-API-only for v1 (Swagger/scripts), per
explicit scope decision. The existing frame-editor label picker is the
only frontend surface touched.

## Testing

Per CLAUDE.md's TDD requirement: every backend task gets a failing test
before implementation. Existing taxonomy tests that assume
`LabelRelation`/tree-via-recursive-parent (`test_label_descendants_via_
recursive_relation`, `test_label_tree_groups_children_under_root_labels`
in `backend/tests/test_taxonomy.py`) are obsolete under the new schema
and get replaced, not kept alongside the new ones — there is no
"descendants" or "root label" concept left to test.

## Out of scope

- Any frontend UI for creating/editing Category/EvaluationType/Label
  (admin surface) — backend API only, per explicit scope decision.
- Migrating/preserving the 28 existing test `Annotation` rows — wiped
  along with the rest of today's test taxonomy data, per explicit
  decision (none of it is real annotation work).
- Re-uploading the two segmentation-reference sequences (1239, 1240)
  lost in yesterday's accidental dev-DB truncate — separate task if
  still wanted after this schema change lands.
