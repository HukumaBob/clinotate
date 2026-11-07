# Class-aware dataset split and split visibility Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** New datasets get a split in which every class reaches as many of train/val/test as its number of source units allows, and a class-by-part report with plain-language warnings is shown in the create form, the finished-dataset dialog and the Train workspace.

**Architecture:** `assign_splits` (`backend/app/datasets/service.py`) gains an optional per-sequence class-frame map and, when it is given, chooses the unit-to-part assignment by an explicit objective instead of dealing by frame count. A new pure module `split_report.py` builds the report (cells, totals, warnings) from per-frame placements; one `plan_splits` function feeds both dataset creation and the `/datasets/balance` preview, so the preview is what gets created. A stored dataset's report is rebuilt from its `dataset_items`. The frontend adds one table component and a hook, placed in three screens.

**Tech Stack:** FastAPI, SQLAlchemy, pytest (`uv run pytest`); React, TanStack Query, vitest, `openapi-typescript`.

**Spec:** `docs/superpowers/specs/2026-11-07-class-aware-dataset-split-design.md`

## Global Constraints

- A grouping unit is never divided: `grouping_key(video_id, sequence_id)` stays the unit (a video, else the sequence).
- Class coverage rule: a class in 3+ units reaches train, val and test; in 2 units train and val (test left out); in 1 unit train only. Coverage beats the `split_config` proportions.
- Warning constants: a val/test cell is "thin" under **5** frames; a part's share is off when more than **15** percentage points from its target.
- Warnings are advisory: nothing is blocked. Existing datasets are never re-split.
- Classes resolve through `resolve_class` with the dataset's grouping rules, as in `compute_balance`.
- English only; dark theme only (no light-background classes); frontend calls go through `apiClient` (never a hand-rolled `fetch`); regenerate `openapi.json` after schema changes: `cd backend && PYTHONPATH=. uv run python scripts/export_openapi.py`, then check `git diff --stat openapi.json`.
- Tests that open DB sessions use `import app.db as db_module` + `db_module.SessionLocal()`, roll back and leave no rows in the real database.
- After every commit run `sync` (a reboot once left empty git objects behind).

## Review Focus

1. A selection with no annotated classes (only negative frames): assignment falls back to the old dealing, the report has no classes, nothing crashes. (Task 1, 2)
2. A class that is both missing from a part and under the thin limit is reported once, as `missing_in_split`. (Task 2)
3. Photo sets (sequences without a video) are their own units through the same code path as videos. (Task 1)
4. An old dataset whose annotations or labels were later deleted: the report skips what vanished and returns 200, never a 500. (Task 4)
5. Capped (`class_limits`) and excluded classes: the report reflects the capped frames and omits excluded classes, because it is built from the same composition. (Task 3)

---

### Task 1: Class-aware `assign_splits`

**Files:**
- Modify: `backend/app/datasets/service.py` (`assign_splits`, line ~531)
- Test: `backend/tests/test_dataset_splits_class_aware.py` (create); `backend/tests/test_dataset_splits_by_unit.py` must stay green unchanged

**Interfaces:**
- Produces: `assign_splits(sequence_ids, split_config, frame_counts_by_sequence=None, grouping_keys=None, class_frames_by_sequence: dict[int, dict[int, int]] | None = None) -> dict[int, SplitName]` where the new map is `sequence_id -> {class_id: frames of that class}`. `required_parts(unit_count: int) -> tuple[SplitName, ...]` (first `min(unit_count, 3)` of train, val, test).
- Behaviour: `class_frames_by_sequence` absent or holding no classes -> exactly the current dealing.

- [ ] **Step 1: Write the failing tests** in `test_dataset_splits_class_aware.py`. Build the `anatomy-001`-shaped fixture: five video units V1..V5 (one sequence each, sequence id = unit number, every cell 10 frames) with these classes: V1 {anus, caecum, colon_left, colon_right, outside, rectum, retro}, V2 all eight (ileum included), V3 {anus, caecum, colon_right, ileum, outside, rectum, retro}, V4 {anus, caecum, ileum, rectum, retro}, V5 {outside}. Helper `reached(assignment, class_frames, keys) -> dict[class, set[part]]`. Tests:
  - `test_every_required_pair_is_covered_when_feasible` (the fixture above is feasible: `reached[c] ⊇ required_parts(units_of_c)` for all classes; assert `colon_right` and `ileum` reach all three, `colon_left` reaches train and val and is absent from test).
  - `test_a_unit_is_never_split` (reuse the pattern of `test_sequences_of_one_video_never_separate`, with two sequences per video).
  - `test_two_unit_class_gets_train_and_val_not_test` and `test_one_unit_class_gets_train_only` (small hand-built cases).
  - `test_coverage_beats_proportions` (a case where exact 70/20/10 frame shares would leave a class out of val; assert the class is in val).
  - `test_deterministic_under_input_order` (shuffled `sequence_ids`, same assignment).
  - `test_no_class_data_matches_the_old_dealing` (`class_frames_by_sequence={}` and `None` equal the result of the call without the argument).
  - `test_photo_set_sequences_are_their_own_units` (keys `("sequence", n)`).
  - `test_minimum_unit_guarantees_hold` (train>=1 always; val>=1 with 2+ units; test>=1 with 3+).
  - `test_runs_fast_for_200_units` (200 units, 8 classes, finishes in under 1 s).

- [ ] **Step 2: Run** `cd backend && uv run pytest tests/test_dataset_splits_class_aware.py -q`. Expected: FAIL (unexpected keyword argument).

- [ ] **Step 3: Implement.** Objective, compared lexicographically, smaller is better: (a) number of required (class, part) pairs not covered, where "covered" means some unit placed in the part contains a frame of the class and `required_parts` uses the number of units that contain the class; (b) sum over parts of the absolute difference between the part's realised frame share and its target share; (c) the assignment tuple in sorted unit-key order, for determinism. Assignments that break the minimum-unit guarantees are inadmissible. Search: exhaustive over `3**units` when there are at most 10 units; otherwise start from the existing largest-first dealing and hill-climb (single-unit moves, then pair swaps, in fixed unit-key order) until no move improves the objective. Keep the old code path for the no-class case.

- [ ] **Step 4: Run** the new file and `tests/test_dataset_splits_by_unit.py tests/test_dataset_splits.py`. Expected: all pass.

- [ ] **Step 5: Commit** `feat(datasets): assign split units with class coverage in mind`, then `sync`.

---

### Task 2: Pure split-report builder

**Files:**
- Create: `backend/app/datasets/split_report.py`
- Test: `backend/tests/test_dataset_split_report.py`

**Interfaces:**
- Produces (dataclasses and function):
  - `FrameRow(unit: GroupingKey, split: SplitName, class_ids: frozenset[int])` — one per frame; no classes means a negative frame.
  - `SplitCell(frames: int, units: int)`; `ClassSplit(label_id: int, name: str, units: int, cells: dict[SplitName, SplitCell])`; `SplitTotal(frames: int, units: int, share: float, target: float)`; `SplitWarning(kind: str, message: str, label_id: int | None, split: SplitName | None)`; `SplitReport(classes: list[ClassSplit], totals: dict[SplitName, SplitTotal], warnings: list[SplitWarning])`.
  - `build_split_report(rows: list[FrameRow], class_names: dict[int, str], split_config: dict) -> SplitReport`.
  - `THIN_CELL_FRAMES = 5`, `SHARE_TOLERANCE_PCT = 15`.
- Warning kinds: `missing_in_split` (a part has 0 frames of the class), `few_units` (class in fewer than 3 units; message names the units count and the parts left out), `thin_cell` (val/test cell with 1..4 frames), `split_share` (see constants). A missing cell is never also reported as thin. Messages are plain English naming the class and part.

- [ ] **Step 1: Write the failing tests**: one per warning kind with its exact trigger and a non-trigger; `test_missing_cell_is_not_also_thin`; `test_cells_count_a_multi_class_frame_once_per_class_and_once_in_totals`; `test_negative_frames_count_only_in_totals`; `test_empty_rows_give_an_empty_report`; `test_classes_sorted_by_name`; `test_share_target_uses_split_config_with_test_as_remainder`.
- [ ] **Step 2: Run** `uv run pytest tests/test_dataset_split_report.py -q`. Expected: FAIL (module missing).
- [ ] **Step 3: Implement** the module as specified (pure, no DB).
- [ ] **Step 4: Run** the file. Expected: pass.
- [ ] **Step 5: Commit** `feat(datasets): split report with plain-language warnings`, then `sync`.

---

### Task 3: `plan_splits` shared by creation and preview

**Files:**
- Modify: `backend/app/datasets/service.py` (`create_dataset` at ~line 625; new `plan_splits`)
- Test: `backend/tests/test_dataset_split_plan.py`

**Interfaces:**
- Consumes: Task 1 `assign_splits`; Task 2 `build_split_report`, `FrameRow`.
- Produces: `SplitPlan(assignment: dict[int, SplitName], rows: list[FrameRow], class_names: dict[int, str])` and `plan_splits(session, sequence_ids, task_type, rules, excluded_label_ids, class_limits, split_config, tree=None, composition=None, grouping_keys=None) -> SplitPlan`. It builds the per-sequence class-frame map from `composition` (class of an annotation = `resolve_class(label_id, tree, rules)`), calls `assign_splits`, and returns one `FrameRow` per composed frame. `create_dataset` uses it, so stored splits equal planned splits.

- [ ] **Step 1: Write the failing tests** (DB, rolled back, rows prefixed `splan-`): `test_create_dataset_uses_the_class_aware_assignment` (three videos, one class present in all: after `create_dataset` the class has items in train, val and test); `test_preview_plan_equals_stored_split` (`plan_splits` assignment equals the splits stored by `create_dataset` for the same inputs); `test_class_limits_are_reflected` (a capped class has the capped frames in `rows`); `test_excluded_class_is_absent`; `test_only_negative_frames_still_assigns` (Review Focus 1, 5).
- [ ] **Step 2: Run** the file. Expected: FAIL (`plan_splits` missing).
- [ ] **Step 3: Implement** `plan_splits` and switch `create_dataset` to it; keep the frame-count map and `grouping_keys` it already computes.
- [ ] **Step 4: Run** the file plus `tests/test_datasets_api.py tests/test_dataset_composition.py tests/test_dataset_balance.py`. Expected: pass (the 2 failures in `test_training_models.py` are pre-existing and unrelated).
- [ ] **Step 5: Commit** `feat(datasets): create datasets with the class-aware split`, then `sync`.

---

### Task 4: API — preview and stored report

**Files:**
- Modify: `backend/app/datasets/schemas.py`, `backend/app/datasets/router.py` (`/balance` at ~line 105; new `GET /{dataset_id}/split-report`), `backend/app/datasets/service.py` (`split_report_for_dataset`)
- Modify: `openapi.json` (regenerated)
- Test: `backend/tests/test_dataset_split_api.py`

**Interfaces:**
- Produces schemas: `SplitCellRead(frames, units)`, `SplitClassRead(label_id, name, units, train, val, test: SplitCellRead)`, `SplitTotalRead(frames, units, share, target)`, `SplitWarningRead(kind: Literal["missing_in_split","few_units","thin_cell","split_share"], message: str, label_id: int | None, split: Literal["train","val","test"] | None)`, `SplitReportRead(classes, train, val, test: SplitTotalRead, warnings)`. `BalanceRequest` gains `split_config: dict | None = None`; `BalanceReportRead` gains `split_report: SplitReportRead | None` (None when `split_config` is absent).
- Produces: `split_report_for_dataset(session, dataset_id: int) -> SplitReport` rebuilt from `dataset_items` (unit via frame -> sequence -> video; class via annotation label resolved with the dataset's `grouping_overrides`); a missing dataset gives 404.

- [ ] **Step 1: Write the failing tests** with `TestClient`: `test_balance_returns_split_report_when_split_config_given` and `..._none_when_absent`; `test_split_report_endpoint_matches_the_preview` (create a dataset, `GET /datasets/{id}/split-report` classes/cells equal the preview's for the same selection); `test_split_report_for_unknown_dataset_is_404`; `test_split_report_survives_deleted_annotations` (delete an annotation after creation: 200, that item skipped; Review Focus 4); `test_split_report_for_dataset_made_before_this_change` (items inserted directly with arbitrary splits).
- [ ] **Step 2: Run** the file. Expected: FAIL.
- [ ] **Step 3: Implement** schemas, both routes and `split_report_for_dataset`; regenerate `openapi.json`.
- [ ] **Step 4: Run** the file plus `tests/test_datasets_api.py` and confirm `git diff --stat openapi.json` shows a change. Expected: pass.
- [ ] **Step 5: Commit** `feat(datasets): split report endpoints`, then `sync`.

---

### Task 5: `SplitReportTable` and the data hook

**Files:**
- Create: `frontend/src/features/datasets/SplitReportTable.tsx`, `frontend/src/features/datasets/SplitReportTable.test.tsx`
- Modify: `frontend/src/entities/useDatasets.ts` (add `useDatasetSplitReport(datasetId: number | null)` calling `apiClient.GET("/datasets/{dataset_id}/split-report", ...)`)

**Interfaces:**
- Produces: `SplitReportTable({ report }: { report: SplitReportRead })` (type from `components["schemas"]["SplitReportRead"]`) rendering the totals line (frames, units, share vs target per part), one row per class with `frames / units` per part, problem cells highlighted (missing = red text, thin = amber, using dark-theme classes only), and the warnings as a list below. Cells that are missing show "—". An empty `classes` list renders nothing.

- [ ] **Step 1: Write the failing tests**: renders a row per class with `frames / units`; a missing cell shows "—" and carries the missing-cell marker (`data-problem="missing"`); a thin cell `data-problem="thin"`; warnings are listed by message; an empty report renders nothing; 40 classes do not break layout (scroll container present).
- [ ] **Step 2: Run** `cd frontend && npx vitest run src/features/datasets/SplitReportTable.test.tsx`. Expected: FAIL.
- [ ] **Step 3: Implement** the component and the hook (follow `useDatasetBalance` for the query style).
- [ ] **Step 4: Run** the file and `npx tsc --noEmit -p tsconfig.app.json` (filter the known jest-dom noise). Expected: pass.
- [ ] **Step 5: Commit** `feat(datasets): split report table`, then `sync`.

---

### Task 6: Place the report in the three screens

**Files:**
- Modify: `frontend/src/features/datasets/DatasetsPage.tsx` (debounced request around line 160: add `split_config: { train, val, test }` from `trainPercent`/`valPercent`/`testPercent`), `frontend/src/features/datasets/BalancePanel.tsx` (render the table from `report.split_report` when present), `frontend/src/features/datasets/DatasetMetricsDialog.tsx` (uses `useDatasetSplitReport(dataset.id)`; it must still never call `/datasets/balance`)
- Create: `frontend/src/features/training/SplitWarnings.tsx` (+ test), used in `TrainToolbar.tsx` next to `DatasetSummary`
- Test: extend `BalancePanel.test.tsx`, `DatasetMetricsDialog.test.tsx`, `DatasetsPage.test.tsx`, `TrainToolbar.test.tsx`

**Interfaces:**
- Consumes: Task 4 schemas, Task 5 `SplitReportTable`, `useDatasetSplitReport`.
- Produces: `SplitWarnings({ datasetId }: { datasetId: number })` showing only the warning messages (a one-line count with the list in a `details`), nothing while loading or when there are none.

- [ ] **Step 1: Write the failing tests** following the mocking pattern of the neighbouring tests (`apiClient` mocked): the create page sends `split_config` in the balance request and `BalancePanel` shows the table when `split_report` is present and not when it is null; the dialog shows the table for a stored dataset and does not call `/datasets/balance`; `SplitWarnings` lists the messages for a dataset with warnings and renders nothing without them; `TrainToolbar` shows it for the selected dataset.
- [ ] **Step 2: Run** `npx vitest run src/features/datasets src/features/training/TrainToolbar.test.tsx src/features/training/SplitWarnings.test.tsx`. Expected: FAIL.
- [ ] **Step 3: Implement** the placements. The request's `split_config` comes from the form's percentages; no new state.
- [ ] **Step 4: Run** the same command, then `npm run test` (the `pretest` hook regenerates the schema) and the real tsc check from the previous task. Expected: pass.
- [ ] **Step 5: Commit** `feat(datasets): show the split report in the create form, dialog and Train workspace`, then `sync`.

---

### Task 7: Live check and records

**Files:**
- Modify: `ROADMAP.md`, `CHANGELOG.md` (Unreleased: Added/Changed)

- [ ] **Step 1: Live check in a real browser** against the running stack (do not touch dev ports of other projects; ask before restarting a server): open the dataset page, select the same sequences as `anatomy-001`, confirm the table and warnings update live, create a new dataset, confirm the dialog and the Train workspace show the same report, and that `colon_left` has no test frames while classes with 3+ videos reach all parts. Delete the dataset you created afterwards (precise predicate, its name).
- [ ] **Step 2: Write the records.** ROADMAP section "Class-aware dataset split (2026-11-07)" with what was built, what the live check showed and what stayed open; link the spec and plan; CHANGELOG entries. Record the new project memory entry.
- [ ] **Step 3: Commit** `docs: record the class-aware split in the roadmap and changelog`, then `sync`. Do not push without being asked.
