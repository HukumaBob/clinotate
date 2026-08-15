# Dataset screen and the `datasets` module

Date: 2026-08-15
Status: approved

## Problem

The taxonomy can now express that fine-grained labels roll up into coarser
training classes ([2026-08-15-label-hierarchy-grouping-design.md](2026-08-15-label-hierarchy-grouping-design.md)
shipped `Label.parent_label_id`, `Label.is_abstract` and `resolve_class`).
Nothing yet consumes it. There is no way to assemble a dataset, no way to
see what classes a selection of sequences would actually produce, and no
way to choose a grouping while watching its effect — which was the entire
point of putting the grouping decision next to a balance panel rather than
on the Tags screen.

The real data shows why this matters. Every annotated polyp subtype today:

| label | frames |
|---|---|
| `pedunculated_polyp_0_Ip` | 16 |
| `sessile_polyp_0_Is` | 13 |
| `flat_lesion_0_IIa` | 3 |
| `lst_g_nodular_mixed` | 1 |
| `lst_ng_flat_elevated` | 1 |

Five classes, three of them untrainable on their own. Collapsed into
`polyp`: 34 frames — not much, but a class a detector can actually learn.
Choosing between those two shapes is the decision this screen exists to
support.

## Scope

This spec covers dataset **assembly and analysis**, not export. A dataset
is a saved record of which frames, which splits, which grouping and which
exclusions. Writing YOLO files, `data.yaml`, the class-map fingerprint and
a downloadable archive are deliberately a separate, later piece of work.

The reasoning: export is the only part that genuinely needs a lot of data.
With 75 annotated frames and zero negatives, a downloaded archive can be
checked for directory structure and nothing more. The balance panel is
useful *immediately* — it says which classes need more annotation, which
is what should drive the next hours of labelling work. Splitting here also
separates two distinct risks: "are we counting classes correctly" and "are
we writing the YOLO format correctly". Debugging both at once is worse
than debugging each.

Also out of scope: the Train screen, and auto-applied balance
recommendations (the UI spec's "Auto-apply balance recommendations"
checkbox). The Django reference has
`_generate_filtering_recommendations`, but trusting a heuristic blindly at
75 frames is premature. Manual exclusion covers the same need honestly.

## Data model

```
Dataset(id, name, task_type, taxonomy_version, split_config JSONB,
        grouping_overrides JSONB, excluded_label_ids JSONB,
        balance_metrics JSONB, created_by_id, created_at)

DatasetItem(dataset_id, frame_id, annotation_ids JSONB, split[train|val|test])
```

Three differences from the design spec's draft, each following from a
decision made here:

- `grouping_overrides` — the per-dataset delta over the taxonomy's default
  grouping, `{"collapse": [label_id], "expand": [label_id]}`, empty meaning
  "as the taxonomy says". Shape fixed by the hierarchy spec.
- `excluded_label_ids` — labels dropped from this dataset entirely.
- `task_type` — an enum, `detection | segmentation | classification`,
  borrowed verbatim from the Django reference's `DatasetBalanceAnalyzer`
  rather than inventing a third vocabulary for the same three ideas.

### `task_type` filters composition, it does not merely annotate it

`task_type` determines which `annotation_scope` the dataset accepts:
`classification` takes FRAME annotations only, `detection` and
`segmentation` take REGION only. Classification and detection datasets are
therefore always separate datasets.

This is not a policy choice but a format one: a frame-classification label
carries no coordinates, so a single YOLO detector cannot train on it
alongside bounding boxes. `annotation_scope`, added in the previous phase,
is exactly the field that distinguishes them.

The filter applies **per annotation, not per frame**. Today no frame mixes
the two scopes (verified: zero frames carry both), but nothing prevents it
— marking an already-annotated frame `low_quality` is legitimate — so the
filter must not assume frames are homogeneous.

### `taxonomy_version` is pinned at creation

Following the repository's binding rule, as `Annotation` does. This does
not contradict the hierarchy spec's "grouping stays live": the version
records which taxonomy the dataset belongs to (provenance), while a
rebuild still picks up current grouping (behaviour). Two different
questions.

### `DatasetItem` is materialized, not computed on demand

The balance panel is live and reflects current data. A *saved* dataset
must remember its own frame list. Otherwise tomorrow's annotation silently
changes yesterday's dataset, and the train/val/test split shifts with it —
which would quietly invalidate any comparison between two training runs.

So: balance is live, composition is frozen at save time.

### Splits are assigned per sequence, never per frame

`split_config` holds the requested train/val percentages (test is the
remainder). At save time, whole **sequences** are assigned to a split, and
every frame inherits its sequence's assignment.

Splitting frames randomly would leak: consecutive frames of one video are
near-duplicates, so a frame in train and its neighbour in val is
effectively the same image on both sides of the split, inflating validation
metrics into meaninglessness. Sequence-level assignment is the only correct
unit here.

The consequence, which the UI must not hide: with few sequences the
realized percentages cannot match the requested ones. Seven annotated
sequences at 70/20/10 cannot land on those fractions — assignment fills
train first, then val, then test, and the panel reports the **realized**
frame counts per split alongside the requested percentages, so the gap is
visible rather than assumed away.

## Composition rules

A frame from the selected sequences enters the dataset when either:

1. it has at least one annotation compatible with `task_type` (by
   `annotation_scope`) and not excluded via `excluded_label_ids`; or
2. `no_findings_reviewed` is set on it — a negative example, exported later
   with an empty label file.

Everything else is silently omitted. On current data that yields 75
positive frames and 0 negatives out of 1805: correct output, not a bug —
the flag has never been set on any frame. This is the feature that finally
consumes `no_findings_reviewed`
([docs/specs/2026-08-14-frame-no-findings-flag-design.md](../../specs/2026-08-14-frame-no-findings-flag-design.md)).

### An all-excluded frame drops out; it does not become a negative

If every annotation on a frame is excluded by rule 1, the frame leaves the
dataset entirely — unless rule 2 independently applies to it.

"We chose not to train the `ileum` class" does not mean "this frame
contains nothing". Turning such frames into negatives would teach the model
that ileum does not exist, manufacturing false negatives out of a
bookkeeping decision.

## Balance computation

One pure function, no writes:

```python
def compute_balance(session, sequence_ids, task_type, rules, excluded) -> BalanceReport
```

Classes are resolved through `resolve_class` from the hierarchy phase — the
shared function whose entire purpose is that the panel and any future
export agree by construction rather than by convention.

Per class the report carries **both** an instance count and a frame count.
Both are needed and they genuinely differ: frame 5672 carries two
`colon_adenoma` annotations (two objects in one image — two training
instances, one image), and frame 14084 carries three different classes.
Instances count annotation rows; frames count `DISTINCT frame_id`. Using
`DISTINCT` for both would undercount instances.

Per dataset it carries `imbalance_ratio`, Gini index, normalized entropy
and a five-level `severity`, with the thresholds taken from the Django
reference's `_assess_imbalance_severity` (`balanced` / `mild` / `moderate`
/ `severe` / `extreme`).

### The primary signal is an absolute threshold, not severity

Verified against the real distribution above:

| grouping | imbalance_ratio | Gini | severity |
|---|---|---|---|
| leaves (today) | 16.0 | 0.573 | severe |
| `polyp` collapsed | 35.0 | 0.690 | severe |
| collapsed to 3 classes | 7.0 | 0.408 | moderate |

Collapsing polyps makes the formal metric *worse* — imbalance is measured
against the smallest class, and grouping grew the largest one while the
tail of singletons (`ileum`, `transparent_cap`, `valvula_ileocaecalis`, one
example each) stayed put.

So severity must not be the headline number: optimizing it would push the
user toward three meaningless mega-classes. What actually matters is that a
class with one example is untrainable while a class with 34 is trainable —
a different question from whether the dataset is balanced.

The panel therefore leads with **"N classes below the threshold"** and their
names (threshold configurable, default 10 — the same floor the reference's
own `severity` uses via `min_count < 10`). Gini, ratio and severity appear
below, as reference figures.

## API

```
POST   /datasets/balance   -> BalanceReport    (live recompute; writes nothing)
POST   /datasets           -> DatasetRead      (create + materialize items)
GET    /datasets           -> list[DatasetRead]
GET    /datasets/{id}      -> DatasetRead incl. stored balance_metrics
DELETE /datasets/{id}
```

`/datasets/balance` is POST rather than GET because its body carries the
sequence list, grouping rules and exclusions, which do not fit sensibly in
a query string. Writing nothing is part of its contract.

## Screen

Two columns, per the UI spec — no new structural concept is introduced.

**Left:** sequence selection (checkbox list, filter by procedure, text
search, running totals) and dataset config (Name, Task type, Train/Val
percentages with Test as the computed remainder).

**Right:** the live panel.
- Top: "N classes below threshold", with the list. This is the headline,
  per the reasoning above.
- Middle: horizontal bars per resolved class, each showing both counts
  (instances / frames). A parent class carries a collapse/expand toggle; any
  class carries an "exclude" checkbox. Both recompute immediately.
- Bottom: severity, imbalance ratio and Gini as reference figures.

**Below:** the table of saved datasets — name, type, created date, frame
count; actions Metrics (show stored `balance_metrics`) and Delete. **There
is no Download button**, and its absence is deliberate, not an unfinished
edge.

The grouping toggle lives here rather than on Tags. That was the original
requirement behind this whole line of work: choose a grouping while
watching the resulting balance, instead of editing hierarchy blind.

**Debounce.** Every sequence click posts a recompute. At 17 sequences that
is invisible; at hundreds it is not. Debounce ~300 ms and cancel the
in-flight request, so a late response cannot overwrite a newer one.

## Seeding the default grouping

No polyp subtype currently has `parent_label_id` set — the mechanism
exists, the default was never populated. A panel cannot collapse a group
that does not exist, so the first run would show exactly today's picture
with nothing to toggle.

A small, separate task therefore creates `polyp` as an abstract label and
parents the five subtypes (`pedunculated_polyp_0_Ip`, `sessile_polyp_0_Is`,
`flat_lesion_0_IIa`, `lst_g_nodular_mixed`, `lst_ng_flat_elevated`) under
it, respecting the hierarchy invariants: same procedure (colono), same
`annotation_scope` (REGION).

## Risk accepted knowingly

This screen ships against data that barely exists: 75 annotated frames,
zero negatives, and half the classes at a single example. The panel will
honestly report `severe_imbalance` and a long under-threshold list — that
is correct behaviour, not something to fix.

The consequence for acceptance: this data can verify the *counting logic*
but not the usefulness of the guidance. Tests therefore run against
synthetic fixtures with known answers, while verification against the real
database checks that the numbers match direct SQL.

## Testing

TDD per repository rule: a failing test precedes implementation.

- `compute_balance` on a synthetic tree: grouping changes the resolved
  classes; exclusion removes a class; a frame whose annotations are all
  excluded drops out rather than becoming a negative; `task_type` filters
  by `annotation_scope`.
- Metrics against hand-computed numbers, plus the degenerate cases: a
  single class, an empty dataset, a class with zero instances.
- Instance-vs-frame counting specifically: a frame with two annotations of
  one class must count as 2 instances / 1 frame (frame 5672 is a real
  example).
- Materialization: a saved `DatasetItem` set does not change after new
  annotation lands.
- Real-browser: the panel recomputes on click, the grouping toggle
  collapses the polyp subtypes, and a frame flagged `no_findings_reviewed`
  actually appears in the composition. Frontend unit tests mock `apiClient`
  wholesale and cannot observe any of this.
