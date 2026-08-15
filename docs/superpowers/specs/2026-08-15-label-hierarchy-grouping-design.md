# Label hierarchy and class grouping

Date: 2026-08-15
Status: approved

## Problem

Fine-grained annotation and trainable class balance pull in opposite
directions.

Annotators need detail. The colono taxonomy distinguishes eleven polyp
shapes (`pedunculated_polyp_0_Ip`, `sessile_polyp_0_Is`,
`flat_lesion_0_IIa/IIb/IIc/III`, `lst_g_homogeneous`,
`lst_g_nodular_mixed`, `lst_ng_flat_elevated`, `lst_ng_pseudodepressed`,
`subepitelial_lesion`) because the Paris classification distinguishes
them and the distinction is clinically real.

Training does not want eleven classes with a handful of masks each. A
single multi-class YOLO detector over findings + anatomy + artifacts
needs classes with enough examples to learn from; eleven near-empty
polyp classes are eleven ways to fail.

Today there is no mechanism to bridge the two. `LabelRelation` was
dropped from the schema by migration `fa9801ab5dbe`; the relations edges
in the source export survive only as import-time input to
`_resolve_category_key` in `backend/app/taxonomy/import_taxonomy.py`,
which walks them to find a tag's owning `Category` and then discards
them. The live hierarchy is `Label -> Category -> Procedure`, one level,
plus an orthogonal `EvaluationType.annotation_scope`. Nothing expresses
"`sessile_polyp_0_Is` is a kind of polyp."

Without that, grouping for export can only be a hand-maintained mapping
file — the outcome ROADMAP.md explicitly rejects, because such a file
drifts from the taxonomy silently and cannot feed a live class-balance
panel.

A second, smaller defect shares the same root. `bad_picture`,
`close_focus` and `dirty_optic` live under `Quality` / `geometric`, i.e.
region-scoped MASK/BBOX labels, inherited from the pre-taxonomy platform
which had no frame-level classification at all — "the picture is out of
focus" had to be expressed as a bounding box because nothing else
existed. Defocus, glare and a dirty lens describe the entire frame; they
are not spatially bounded the way `foam`, `feces` or `mucus` genuinely
are. They belong in `frame_classification` next to `low_quality`.

## Decision

Add a recursive parent edge to `Label`, and express dataset-specific
grouping as a delta on top of it.

The taxonomy stores the **default position of the knob**. A dataset
stores **deviations from that default**. Neither duplicates the other,
and a new dataset opens in a sensible state instead of at zero.

### Data model

`backend/app/taxonomy/models.py`:

```python
class Label(Base):
    ...
    parent_label_id: Mapped[int | None] = mapped_column(
        ForeignKey("labels.id"), nullable=True, default=None
    )
    is_abstract: Mapped[bool] = mapped_column(default=False)
```

`parent_label_id` is nullable by construction: most labels are roots, and
NULL is a complete answer ("this label is its own class"), not a missing
one. This is deliberately unlike `annotation_scope`, which is
non-nullable precisely because there an absent value would restore the
bug it fixed (a mode inferred rather than stated). Here there is nothing
to infer.

`is_abstract` is non-nullable, default `false`. Every existing label
stays annotatable; abstractness is opted into per label. An abstract
label is a grouping container that must not appear in annotation
pickers — `polyp` is the motivating case: annotating "polyp" when a
subtype was meant produces an orphan that no leaf-level export can
place.

The column is recursive, so arbitrary depth costs nothing in schema. The
first UI renders exactly one level (a group and its leaves, indented, no
expandable branches). Should a middle cut (`0-Ip` / `0-Is` /
`flat_lesion` / `LST` as four classes instead of one `polyp` or eleven
leaves) later prove worth training on, that is a UI and data change, not
a migration.

### Invariants

Enforced in the service layer, returning 422, not by schema constraints:

1. **Parent shares the child's procedure.** Reachable only through
   `Category.procedure_id` on both sides, so a composite foreign key
   would be more machinery than the check is worth. Quality is
   procedure-specific by decision (below), which makes this load-bearing
   rather than tidy.
2. **No cycles.** Walk up from the proposed parent; encountering the
   child means a cycle. Without this the export-time class resolution
   loops instead of failing at the point of error.
   `_resolve_category_key` already defends against cycles in the source
   data, for the same reason.
3. **Parent and child share `annotation_scope`.** Otherwise a MASK label
   can hang under a frame-classification parent and export produces a
   class mixing bounding boxes with whole-frame marks — exactly the
   category error `annotation_scope` was introduced to prevent, entered
   from the other side.

### `taxonomy_version` is not bumped when a parent changes

The repository rule pins `taxonomy_version` to what a label carried when
an annotation was created, so changing a label's version never silently
changes what an existing annotation is tagged with. Grouping is a way of
*reading* a label, not the label itself: the annotation still means
`sessile_polyp_0_Is` whether or not that label currently rolls up into
`polyp`. Bumping the version on a parent change would also contradict
the live-hierarchy decision below.

## Class resolution

One pure function, shared by dataset export and the live balance panel:

```python
def resolve_class(label_id: int, tree: LabelTree, rules: GroupingRules) -> int:
    """Return the label_id whose name this annotation's class collapses to."""
```

Walk up from the label via `parent_label_id`, remembering the
**highest** ancestor marked collapsed by the dataset's rules; return it,
or the label itself if no ancestor is collapsed. Highest rather than
first: under future multi-level trees, collapsing `polyp` must beat
collapsing `LST`, and a first-match rule would make the result depend on
traversal order.

Sharing this function between export and panel is a requirement, not an
implementation detail. A balance panel that reports classes the export
would not produce is worse than no panel — it invites decisions based on
numbers that never materialize.

The tree is loaded whole in one query and resolved in memory. A
recursive CTE is unwarranted at ~200 labels; at thousands it is still
hundreds of kilobytes.

`GroupingRules` is the delta described above. A node with children
defaults to collapsed — otherwise the taxonomy would remember nothing —
and the dataset's `collapse` / `expand` lists override that per node.
Abstractness does not affect this default: expanding an abstract `polyp`
is legitimate and yields its eleven subtypes as classes with no `polyp`
class at all. `is_abstract` governs who may *annotate* a label, never
how it resolves.

### Direct annotations on a concrete parent

A parent may carry annotations of its own. `low_quality` does: all 32
CLASSIFICATION rows in the database sit on it, and none sit on
`bad_picture` / `close_focus` / `dirty_optic`. This is normal, not
exceptional — "the frame is bad, the reason does not matter" is a
legitimate clinical judgement, and forcing an annotator to always name a
cause would slow annotation for data nobody needs.

So `low_quality` stays concrete (not abstract), and resolution must add
a parent's own direct annotations to its children's when collapsed. This
falls out of the formula without a special case: the parent resolves to
itself, the children resolve to the parent.

When a concrete parent is *expanded*, its direct annotations form their
own class alongside its children's. When an abstract parent is expanded,
it contributes nothing, having no direct annotations by definition. Both
work from the same formula.

## Grouping is live, with a fingerprint at export

Rebuilding a dataset picks up the current hierarchy; grouping is not
frozen into the dataset at creation.

The cost is accepted knowingly: two training runs over "the same
dataset", separated in time, can see different class sets, so a metric
difference is not attributable to the model alone. The benefit is that
fixing a hierarchy mistake repairs every dataset at once, with no
re-creation. For a training corpus that is still largely educational,
that is the right trade.

The reproducibility hole is closed without constraining anything:
**every export records the resolved class map** — class names and the
`label_id`s each was assembled from, plus `taxonomy_version` — into
`data.yaml` and into `balance_metrics`:

```yaml
# resolved class map, taxonomy_version 1
# polyp: [2124, 2197, 2236, 2237, 2238, 2239, 2240, 2243, 2245, 2246, 2247, 2248]
# low_quality: [2373, 2166, 2171]
```

The hierarchy stays live; any trained model still shows what it was
trained on.

### Under-representation warnings count resolved classes

The UI spec's warning callout must be computed over resolved classes,
not raw labels. Eleven polyp subtypes at 3-20 masks each are eleven
hopeless classes; collapsed, they are one class of a couple hundred and
perfectly trainable. Warning about labels that no longer exist as export
classes would train the user to ignore the warning.

## Quality migration

Runs as its own Alembic migration, after the two columns exist (step 4
needs somewhere to write). Everything is an `UPDATE` of existing rows —
`label_id`s are preserved, so annotations hanging off them are
untouched. This follows the stated principle: losing annotation data is
tolerable, losing taxonomy structure is not.

Quality is **procedure-specific**. Defocus is defocus in either organ,
but the image differs and such frames are plentiful, so keeping colono
and egds quality separate preserves a real training signal. The existing
rule that `Category` is unique per procedure therefore stands; no
procedure-neutral category is introduced.

1. **Create the missing `Quality` / `frame_classification` category.**
   One exists, for one procedure; the second procedure needs its own.
2. **Create a `low_quality` twin for the second procedure.** The
   existing row (id 2373) is untouched and keeps all 32 annotations. This
   is the only row the migration genuinely creates.
3. **Move the three labels.** `bad_picture` (2171), `close_focus`
   (2166), `dirty_optic` (2165 and 2222) change `evaluation_type_id` to
   `frame_classification` and `category_id` to `Quality` of their own
   procedure. Ids are preserved. `dirty_optic` exists twice, one per
   procedure, and each moves to its own; `bad_picture` and `close_focus`
   exist once each and stay single — creating empty twins "just in case"
   is speculative, and adding one later is a single row in the taxonomy
   UI.
4. **Set `parent_label_id`.** Each moved label gets the `low_quality` of
   its procedure as parent.

The other nine `Quality` / `geometric` labels — `foam`, `feces`,
`mucus`, `bilis`, `liquor`, `bad_preparation` — stay region-scoped and
are not touched. Foam and feces occupy a specific part of the frame and
should be outlined. Only the three that describe the whole frame move.

**Downgrade** restores the three labels to `geometric` / `Quality`,
clears `parent_label_id`, and deletes the created twin only if no
annotations reference it; otherwise it fails with an explicit error
rather than silently deleting annotated data.

## Scope

**This spec's implementation (`taxonomy`):** the two columns and their
three invariants, the quality migration, API to read and set a label's
parent, filtering abstract labels out of `CascadingLabelPicker` and the
sequence grid's category dropdown, and `resolve_class`.

`resolve_class` lands in `taxonomy`, not `datasets`: it concerns label
hierarchy and does not depend on `Dataset`: its rules arrive as an
argument. This lets it be fully tested before any dataset exists.

**Deferred to the Dataset screen (`datasets`, separate spec and plan):**
the `Dataset` / `DatasetItem` models, `Dataset.grouping_overrides`
(JSONB, `{"collapse": [label_id], "expand": [label_id]}`, empty meaning
"as in the taxonomy"), the balance panel with per-group collapse
toggles, and export with the class-map fingerprint. That screen carries
its own substantial scope — sequence selection, splits, YOLO export —
and mixing it into a taxonomy change serves neither.

The first portion stands on its own without the second: the quality
migration fixes a real defect (three labels that cannot correctly
express what they mean), and the hierarchy becomes editable and visible.

**On the Tags screen.** It shows a label's parent and allows setting it —
viewing and editing structure. It does **not** host the grouping
decision: choosing what to collapse belongs next to the live balance
panel on the Dataset screen, because the entire point is watching class
balance while choosing. Editing hierarchy blind on Tags is the thing
this design avoids.

## Testing

TDD per repository rule: a failing test precedes implementation for
every task.

- `resolve_class` over a fixture tree: a root leaf; a leaf under a
  collapsed parent; a direct annotation on a concrete parent; `expand`
  overriding the default; and a multi-level tree — the schema permits
  depth, so a test must pin its behaviour even while the UI renders one
  level.
- One test per invariant, each asserting 422: cross-procedure parent,
  cycle, mismatched `annotation_scope`.
- Migration against a real database: ids preserved, all 32 annotations
  still on id 2373, the three labels' scope now FRAME, parents set
  within procedure, and downgrade refusing to delete an annotated twin.
- A real browser pass. Frontend unit tests mock `apiClient` wholesale
  and cannot observe that an abstract label still renders in a picker;
  this repository has already paid for that lesson three times (see
  ROADMAP.md's Phase 1 deviation log).

## Known wrinkle, not fixed here

`test-polyp-label` exists in **fifteen** copies under `Findings` /
`geometric`, left by test runs against the dev database. They will
clutter any parent-picker list once `polyp` grouping is set up for real.
They are dev debris rather than taxonomy structure and cleaning them is
outside this task's scope — recorded here so that encountering them
later is recognition, not discovery. Deleting anything from the
`endoscopy` database requires the user's explicit go-ahead; real
taxonomy structures live there.
