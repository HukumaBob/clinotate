# Class-aware dataset split and split visibility

Date: 2026-11-07. Status: draft, awaiting approval.

## Why

Dataset `anatomy-001` (8 classes, 5 source videos) trained a classifier that
scored 35 % top-1 on validation and called 93 % of frames of a real video
"rectum". Two things made that invisible until training:

1. **The split is class-blind.** `assign_splits` (`backend/app/datasets/service.py`)
   deals whole *grouping units* (a video, or a sequence that has no video) to
   train/val/test by frame count only. With 5 units the result was 3/1/1 and each
   class landed wherever its units happened to fall: `colon_right` has no
   validation frames, `colon_left` has no test frames.
2. **Nothing shows it.** The balance panel and the metrics dialog show per-class
   totals ("balanced"), never how a class is spread over the three parts or how
   many independent sources it has. The only hint was a terse Ultralytics
   console warning during training.

## Goals

1. Creating a dataset assigns grouping units so that every class reaches as many
   of train/val/test as its number of units allows.
2. Wherever that is not fully possible, or is poor, the platform says so in plain
   words: before the dataset is created, on the finished dataset, and when it is
   chosen for training.
3. The split is reproducible: the same selection and settings always give the
   same assignment.

## Non-goals and anti-goals

- **A unit is never divided.** No cutting a video's sequences across parts, even
  when it would let a class reach another part. That leaks one procedure into
  both sides and makes validation optimistic. (Decided with the user.)
- Existing datasets are not re-split and get no "rebuild" button. They only gain
  the report. (Decided with the user.)
- Warnings are advisory. Nothing is blocked, same as the existing QC-origin
  warning.
- No change to export, training adapters or the YOLO/DINOv3 trainers.
- Anti-goal: a split that looks tidy (70/20/10) but leaves a class out of a
  part. Class coverage beats exact proportions.

## Constraints

- Unit definition stays as is: `grouping_key(video_id, sequence_id)` (a video, else
  the sequence). Collapse/expand overrides and class limits keep their meaning.
- A class resolves through the taxonomy's shared `resolve_class`, the same as in
  `compute_balance`, so the report and the export cannot disagree about classes.
- `taxonomy_version` rules are untouched (no label data is created).
- API is REST + OpenAPI; regenerate `openapi.json` and use `apiClient` on the
  frontend. English only. Dark theme only.
- TDD: a failing test before each piece of logic.

## Behaviour

### Coverage rule (what "every class reaches every part" means)

For a class with `n` units that contain it:

| units of the class | parts it can reach | which parts |
|---|---|---|
| 3 or more | train, val, test | all |
| 2 | train, val | test is left out |
| 1 | train | val and test are left out |

(Left-out choice for 2 units is **our call**: validation drives model selection
and early stopping, so it is kept over test.)

A class "reaches" a part when at least one unit placed in that part contains at
least one frame of it.

### Assignment

Replaces the frame-count dealing in `assign_splits`; the function keeps its
signature plus the per-unit class frame counts. In priority order:

1. Maximise the number of (class, part) pairs covered, up to the table above.
2. Among those, keep each part's share of all frames close to `split_config`
   (train/val given, test the remainder).
3. Deterministic tie-breaking by unit key.

The existing guarantees remain: train gets at least one unit, val once there are
two units, test once there are three (relevant when no class data exists, e.g.
only negative frames).

Unit counts are small (tens, rarely hundreds), so the search method is the
builder's choice (greedy plus local search is expected to be enough), provided it
is deterministic and runs in well under a second for 200 units.

### Split report

One structure, three consumers:

- per class: for each of train/val/test the frame count and the number of units;
  total units; resolved class name and label id;
- per part: total frames and units, and its share against the target;
- warnings, each with a plain-language message (and `label_id` / `split` when it
  concerns one):
  - `missing_in_split`: a class has no frames in a part (error-level colour);
  - `few_units`: a class comes from fewer than 3 units, so it cannot reach all
    parts; the message says how many units and which parts are left out;
  - `thin_cell`: a class has fewer than 5 frames in val or test (**our call**:
    the constant is 5);
  - `split_share`: a part's real share differs from its target by more than 15
    percentage points (**our call**: 15).

### Where it appears

1. **Create form** (`BalancePanel`, next to the live balance): `POST
   /datasets/balance` gains optional `split_config`; the response gains
   `split_report`, computed with the very function that will assign the split, so
   what is shown is what will be created. Updates as sequences are selected.
2. **Finished dataset** (`DatasetMetricsDialog`, the window in the screenshot that
   prompted this): a new `GET /datasets/{id}/split-report`, computed from the
   stored `dataset_items` (so it works for every existing dataset, no migration).
   Class resolution uses the dataset's stored `grouping_overrides` and
   `excluded_label_ids`.
3. **Train workspace** (`DatasetSummary`): the same report's warnings, shown when
   a dataset is selected, so a bad split is seen before a run starts.

Sketch of the table (frames / units per cell; problem cells highlighted). The numbers
are today's `anatomy-001`, i.e. what the report would reveal about the old split:

```
class         train      val        test       units
caecum        169 / 2    13 / 1     38 / 1       4
colon_left    111 / 1    82 / 1      -  / 0      2   few sources: no test
colon_right   184 / 2     -  / 0    36 / 1       3   missing in val
```

## Left to the builder

- The search algorithm and data layout of the per-unit class counts.
- Exact wording of warning messages (plain language, English), component
  structure, and how the table is coloured within the dark theme.
- Whether the report logic lives in `service.py` or a new module.

## Verification

- Unit tests for the assignment: a class with 3+ units reaches all parts; 2 units
  gives train+val; 1 unit gives train; a unit is never split; the result is
  deterministic; proportions are secondary to coverage.
- A regression test shaped like `anatomy-001` (5 units, 8 classes, the unit counts
  per class from the real data: 4, 4, 2, 3, 3, 4, 4, 4): `colon_right` and `ileum`
  must reach all parts when feasible, `colon_left` must not be placed in test.
- Report tests for each warning kind, and for an old dataset built before this
  change.
- Frontend tests for the table and the warnings in the three places.
- Live check in the browser against the real database, then recreate a dataset
  from the same sequences as `anatomy-001` and compare.

## Out of scope, noted

- Re-splitting existing datasets; splitting inside a video with a leak warning.
- The wider issue that 5 videos cannot teach anatomy at all: the report will
  show it, but only more labelled videos fix it.
- The Ultralytics "7 classes, requires 8" console warning stays as it is.
