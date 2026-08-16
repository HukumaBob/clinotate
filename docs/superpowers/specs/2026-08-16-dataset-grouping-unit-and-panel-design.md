# Dataset grouping unit, class limits, and a fuller balance panel

Date: 2026-08-16
Status: approved

Extends [2026-08-15-dataset-screen-design.md](2026-08-15-dataset-screen-design.md),
which shipped dataset assembly, live class balance, grouping toggles and
exclusions. This document corrects one defect in that work and adds four
capabilities the older Django platform had and the new screen does not.

## Problem

Comparing the shipped screen against the reference platform surfaced two
distinct gaps.

**A correctness defect.** Splits are assigned per *sequence*, which was the
right instinct at the wrong level. A sequence is a slice of one video, so
several sequences cut from the same video share a patient, a scope, a bowel
prep and a session. Reproduced on real data: video 2113 owns sequences 2074
(`caecum01`, 29 annotated frames) and 2075 (`ileum`, 3), and the current
`assign_splits` put 2074 in train and 2075 in val. The same procedure sits on
both sides of the split, so validation measures memorisation of that
procedure rather than generalisation.

**Missing analysis surface.** `compute_balance` already returns nine metrics
(`min_count`, `max_count`, `mean_count`, `std_count`, `imbalance_ratio`,
`coefficient_of_variation`, `normalized_entropy`, `gini_index`, `severity`).
The panel renders two of them, in muted footer text. Saved datasets store a
complete `balance_metrics` snapshot that is returned by the API and displayed
nowhere. And the only way to rebalance is to exclude a class outright — there
is no way to cap an over-represented one.

## The grouping unit

One definition, used everywhere data independence matters:

```
grouping_key(sequence) = ("video", video_id)      when video_id is set
                       = ("sequence", sequence_id) otherwise
```

A video is the unit of independence because everything inside it is one
procedure. A photo batch has no video, so the sequence is its own unit.

Real data makes the difference concrete. Five annotated sequences today map
to **three** grouping units:

| unit | sequences | annotated frames |
|---|---|---|
| video 2178 | 2323, 2322 | 87 + 9 = 96 |
| video 2113 | 2074, 2075 | 29 + 3 = 32 |
| photo batch (seq 2094) | 2094 | 32 |

Treating sequences as independent would give five buckets, two-thirds of them
drawn from two procedures.

## Correction: splits are assigned per grouping unit

`assign_splits` keeps its largest-remainder apportionment unchanged — the
dealing strategy was correct and is well tested. Only the indivisible unit
changes: whole grouping units are dealt, and every sequence in a unit (and
therefore every frame) inherits that unit's split.

The guarantees carry over unchanged: at least one unit in train whenever any
exist, one in val when there are ≥2, one in test when there are ≥3;
deterministic ties broken by id; no unit lost or double-assigned.

**No versioning of the old behaviour.** There are zero saved datasets, so
there is nothing to migrate and no ambiguity to record. A `split_rule_version`
field would solve a problem that does not exist.

## Class limits

Excluding a class is all-or-nothing. A limit caps how many annotations of one
class enter the dataset — the reference platform's "take 88 of 110", which is
usually the right move for an over-represented class where exclusion is too
blunt.

`Dataset` gains `class_limits` (JSONB, `{label_id: max_instances}`, empty
meaning no caps), and `BalanceRequest` / `DatasetCreate` accept the same shape
so the panel can preview a cap before saving. Keys are **resolved class ids** —
the same id space the panel displays and `excluded_label_ids` already uses,
which is what made excluding a collapsed group work.

### Selection is proportional across grouping units, then deterministic

Given a cap of N for a class with M > N annotations:

1. Group the class's annotations by grouping unit.
2. Apportion N across units in proportion to each unit's share of M, using
   the same largest-remainder method as splits, so rounding cannot starve a
   unit that has annotations.
3. Within a unit, apportion its allocation across that unit's sequences the
   same way; within a sequence, take annotations in ascending id order.

Step 1 is the point. Taking "the first N by id" would draw from whichever
procedures were annotated first; taking N at random would need a stored seed
to stay reproducible, which conflicts with composition being frozen at save
time. Proportional-by-unit gives the model the class under different scopes,
preparations and patients, and is reproducible with no seed because every
tie is broken by id.

A frame keeps only the annotations that survive the cap. A frame whose
annotations are *all* dropped by capping leaves the dataset exactly as an
all-excluded frame does — it does **not** become a negative, for the same
reason: a cap is a bookkeeping decision, not a claim the frame is empty.

## Panel: show what is already computed

### Key metrics block

Render the metrics `compute_balance` already returns, as a labelled block
rather than footer text: total instances, total frames, class count,
`imbalance_ratio`, `gini_index`, `normalized_entropy`, and min/max/mean.

This does not change the established hierarchy: the under-threshold list
stays the headline, because collapsing a group *raises* `imbalance_ratio`
while being the correct call (measured: 16 → 35), so optimising severity
would push toward meaningless mega-classes. The metrics block sits below the
class bars as reference detail.

### No pie chart

The reference shows class distribution as a pie. Deliberately not adopted:
at 26 classes (a real reference screenshot) the sectors are indistinguishable,
the legend outgrows the chart, and comparing two small classes by angle is
impossible. The existing horizontal bars answer the same question, scale to
any class count, and support length comparison — which is exactly the
"which class is short" question the panel exists to answer. The bars stay;
nothing circular is added.

### Recommendations

Derive concrete next actions from the metrics, in the reference's spirit but
computed rather than canned:

- classes below threshold → name them, and say whether collapsing an
  available parent would lift them over it;
- `severity` at severe/extreme → suggest Focal Loss or weighted sampling;
- `imbalance_ratio` above ~10 → suggest capping the largest class, naming it
  and a concrete cap;
- a class whose instances are concentrated in one grouping unit → warn that
  the model may learn that procedure rather than the finding.

The last one has no counterpart in the reference and follows directly from
the grouping-unit concept.

### Metrics for saved datasets

`Dataset.balance_metrics` already stores a full snapshot (metrics, per-class
instance and frame counts, threshold, below-threshold list, negative count)
and `DatasetRead` already returns it. The datasets table's Metrics action
opens a dialog rendering that stored snapshot. **Frontend only** — no new
endpoint, no schema change, no recomputation. It shows the dataset as it was
when saved, which is the point: composition is frozen, so its balance is too.

### Richer sequence picker

The picker shows each sequence's frame count and labeled-frame count. Add
per-scope annotation counts (region-scoped vs frame-scoped) and the owning
video, so the user can see what a sequence contributes before selecting it,
and can see which sequences share a video — the grouping unit that now drives
splits.

`GET /media/sequences` already returns `frame_count`, `labeled_frame_count`
and `video_id`; per-scope counts are the one addition needed there.

## Testing

TDD per repository rule: a failing test precedes implementation.

- `grouping_key`: video-backed sequences share a key; a videoless sequence is
  its own key; two sequences of one video never separate.
- `assign_splits` over grouping units: the real-data case (video 2113's two
  sequences) lands in one split; the existing guarantees (non-empty splits,
  determinism, no unit lost) still hold.
- Class limits: a cap of N yields exactly N instances; the allocation is
  proportional across grouping units rather than drawn from one; the result is
  identical across two runs; a frame whose annotations are all capped away
  drops out and does not become a negative; a cap ≥ the class's total is a
  no-op.
- Recommendations: each rule fires on a fixture that triggers it and stays
  silent otherwise.
- Real-browser: the metrics block shows the same numbers as a direct API call;
  the Metrics dialog on a saved dataset matches its stored snapshot; a capped
  class shows the reduced count in the live panel.
