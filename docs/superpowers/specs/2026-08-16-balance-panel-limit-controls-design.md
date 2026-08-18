# Balance panel: visible exclusions and honest limit controls

Date: 2026-08-16
Status: approved

Extends [2026-08-16-dataset-grouping-unit-and-panel-design.md](2026-08-16-dataset-grouping-unit-and-panel-design.md).
Driven entirely by using the shipped panel against real data — every problem
below was found by a user trying to balance an actual dataset, not by review.

## Problems

**1. A limit applies on every keystroke.** The limit input calls its change
handler per character, so typing `10` first submits `1`. The class collapses
to a single instance before the second digit is typed, and the user is then
editing on top of a corrupted state. Verified against the backend: `cap=1`
correctly yields `1/1` and `cap=10` yields `10/10` — the computation is
right, the UI submits an intermediate value.

**2. "45 / 43" is unexplained.** The two numbers are instances and frames.
The distinction is real and load-bearing — `sessile_polyp_0_Is` has 18
annotations across 17 frames because one frame carries two objects, and YOLO
trains on objects — but nothing on screen says so. A user cannot tell why a
limit of 18 is possible when the frame column reads 17.

**3. Excluding a class discards its size.** An excluded class vanishes from
the report entirely (verified: excluding `foam` removes it from `classes`
and drops `total_frames` from 72 to 71). The excluded list therefore shows
names only. Deciding whether to re-include a class, or to merge two rare
ones, requires knowing how many instances each had — exactly the information
the panel throws away at the moment the decision arises.

## Decisions

### Exclusion and a zero limit are one state, expressed two ways

A limit of `0` means the class is excluded. Unchecking the include checkbox
means the same thing. The two controls stay synchronized: typing `0` clears
the checkbox, and clearing the checkbox puts `0` in the limit field.

This deliberately revisits an earlier fix. A previous review found a Critical
defect where `0` silently excluded a class while its checkbox still showed it
as included — two controls disagreeing about the same class. That fix made
`0` clear the cap instead. The problem was never the meaning of `0`; it was
that only one control knew. Synchronizing them keeps the intuitive meaning
and removes the disagreement, rather than trading one for the other.

### Excluded classes stay on the chart, greyed

An excluded class keeps its row and its bar, rendered grey, with its counts
still shown. It is visibly *in the picture but out of the dataset*. This
replaces the separate "Excluded classes" list, which said what was excluded
but not how much was lost.

Greying rather than hiding is what makes merging decisions possible: seeing
`lst_g_homogeneous (2/2)` and `lst_ng_flat_elevated (1/1)` side by side is
what tells a user those two are worth collapsing into a parent.

### The limit field starts at the class's maximum

Each limit input is pre-filled with that class's uncapped instance count,
and cannot be set above it. A cap above the available count is a no-op, so
offering it is misleading.

This also answers problem 2 without relying on a caption: seeing `18` in the
field of a class whose row reads `18 / 17` makes it evident which number the
limit governs. The column still gets an `instances / frames` heading, but the
pre-filled maximum is what makes it obvious.

### Limits apply on debounce, not per keystroke

The limit input applies its value after the user stops typing, using the same
debounce the panel already applies to selection changes. A cap of `1` remains
legal — it is simply no longer produced by accident while typing `10`.

## What the backend must provide

The panel cannot render a grey bar for a class the report omits, and cannot
pre-fill a maximum it does not know. Both need the uncapped, unexcluded
figures alongside the effective ones.

`ClassCountRead` gains two fields:

```
label_id, name, instances, frames,       # effective (after exclusions and limits)
max_instances, max_frames                # uncapped, unexcluded
```

and `compute_balance` returns a row for **every** class in the selection,
including excluded ones, with `instances = 0` and `frames = 0` when excluded
while `max_instances`/`max_frames` carry the real size.

The effective figures keep driving everything that already depends on them —
`below_threshold`, the metrics, the recommendations, and dataset composition.
An excluded class contributes nothing to any of those, exactly as today. The
`max_*` fields are presentation-only.

**Excluded rows must be filtered out before the metrics are computed, not
merely ignored.** `compute_imbalance_metrics` divides by the smallest class,
so feeding it a zero-instance row makes `min_count` zero and
`imbalance_ratio` literally `inf` — verified by calling it with
`{"polyp": 45, "foam": 0}`. That value would render straight into the panel.
The metrics, `below_threshold` and the recommendations must all be derived
from the classes with `instances > 0`, while the returned `classes` list
carries every class including the excluded ones. Two different collections,
one computed from the other — not the same list used twice.

**Composition is unaffected.** `collect_frames` continues to drop excluded
and capped-away annotations; nothing about which frames enter a dataset
changes. This spec changes what the panel is *told*, not what a dataset
*contains*.

## Testing

TDD per repository rule: a failing test precedes implementation.

- `compute_balance` returns a row for an excluded class with `instances == 0`
  and `max_instances` equal to its real count; the class is absent from
  `below_threshold` and contributes nothing to the metrics.
- A capped class reports `instances == cap` and `max_instances` equal to its
  uncapped count.
- `total_frames` and `negative_frames` still reflect the effective
  composition, not the uncapped one.
- **`imbalance_ratio` stays finite when a class is excluded** — the specific
  regression the zero-instance rows invite. Excluding every class but one
  must not produce `inf`, and the metrics must match what the same selection
  yields with those classes simply not selected.
- Frontend: an excluded row renders greyed with its counts; typing `0`
  clears its checkbox; clearing the checkbox sets the field to `0`; the field
  is pre-filled with the maximum and rejects a larger value; the limit
  applies after the debounce rather than per keystroke.
- Real-browser: typing `10` into a limit field yields a cap of 10, not 1.
