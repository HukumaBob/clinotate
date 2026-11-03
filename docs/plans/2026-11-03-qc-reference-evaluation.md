# QC Reference Evaluation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A classification run on a video with a reference is scored against that reference on the server (per model axis: accuracy, per-class precision/recall/F1, confusion matrix, error episodes, boundary versus interior errors, switching delay, switches versus transitions, confidence of errors) and shown on the run page with red hatching on the model lane.

**Architecture:** Pure scoring functions in `backend/app/reference/evaluation.py` (plain data in, plain data out); a service that loads the run, its video's reference and the stored predictions document, matches axes by class names and calls them; one read-only endpoint `GET /reference/runs/{run_id}/evaluation`. The frontend gets a hook, pure helpers, an `EvaluationPanel` in the run page sidebar, and an error overlay on the model lane.

**Tech Stack:** FastAPI + SQLAlchemy (no new tables, no migration), React + Vite + TanStack Query + openapi-typescript, Vitest.

**Spec:** [docs/specs/2026-11-03-qc-reference-evaluation-design.md](../specs/2026-11-03-qc-reference-evaluation-design.md). Depends on the reference labeling plan ([plan](2026-11-03-qc-reference-labeling.md), done) and the QC classification plan (done).

## Global Constraints

- English only in code, comments, docstrings and UI copy (CLAUDE.md). Dark theme only.
- Work directly on `master`; no branches or worktrees. End commit messages with `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`.
- Tests never write to the real `endoscopy` DB: `import app.db as db_module` + `db_module.SessionLocal()` or the repo's isolated fixtures; never `from app.db import SessionLocal`. Clean up anything created. Do not run alembic against the dev database (there is no migration in this plan).
- `apiClient` only (no hand-rolled `fetch()`); do not hand-edit `frontend/src/shared/api/generated/`. After backend schema/route changes: `cd backend && PYTHONPATH=. uv run python scripts/export_openapi.py` and check `git diff --stat openapi.json`.
- Frontend type check is `cd frontend && npx tsc --noEmit -p tsconfig.app.json 2>&1 | grep <folders you touched>`: plain `npx tsc --noEmit` checks nothing in this repo; `-p tsconfig.app.json` has many pre-existing errors (jest-dom matcher typings, `never` typing in older tests); add none of your own in non-test files.
- Check `df -h /mnt/work-disk` before large writes; if the disk is full stop and report, never delete anything.
- Evaluation is a pure read: nothing is stored.
- Scoring rules (from the spec, verbatim): a processed frame is *evaluated* when its timestamp `ts` lies in a reference interval of the matched axis, `start_ms <= ts < end_ms` (end exclusive); all other frames are *excluded* (gap frames, and every frame of an axis with no matching reference axis). Truth = the label name of the containing interval; prediction = the model's top-1 class name (`axes[i].classes[class_id]`). Class vocabulary = the model axis's classes in order, then reference classes not already present (in the reference axis's order). Per class: `tp, fp, fn, support` (support = truth frames of the class), `precision = tp/(tp+fp)`, `recall = tp/(tp+fn)`, `f1 = 2*tp/(2*tp+fp+fn)`; a zero denominator gives `null`. `accuracy` over evaluated frames (`null` when none); `macro_f1` = mean of `f1` over classes with `support > 0` (`null` when none).
- Episode: a maximal run of consecutive evaluated frames, adjacent in the sorted processed-frame list (so any excluded frame between them breaks it), with the same truth class and the same wrong predicted class; `start_ms`/`end_ms` are the timestamps of the first/last frame; `mean_confidence`/`max_confidence` over its frames. Boundary error frame: `min(ts - interval.start_ms, interval.end_ms - ts) <= boundary_ms` for the interval containing it; an episode is `boundary` iff all its frames are, else `interior`. Lag: for each pair of touching reference intervals of the axis with different labels (`A.end_ms == B.start_ms`), `lag_ms` = time of the first evaluated frame inside B whose prediction equals B's label minus `B.start_ms`, `null` when none or when B's label is not a model class. `model_switches` = adjacent evaluated frame pairs with different predictions; `reference_transitions` = number of touching different-label pairs; `excess_switches = model_switches - reference_transitions` (signed).
- Axis matching: the reference axis sharing the most class names with the model axis, ties to the lower category id (the frontend `matchAxes` breaks ties to the lower index, and axes arrive ordered by category id, so both agree); none when no name is shared. Orphaned intervals are ignored.

## Review Focus

- A frame exactly at an interval's `end_ms` is excluded; one exactly at `start_ms` is included.
- A truth class the model cannot output, and a model class absent from the truth, both appear in the vocabulary, the matrix and the table; zero denominators are `null`, never 0 or NaN/Infinity in the JSON.
- An excluded frame between two wrong frames breaks the episode; a switch of the wrong class (truth same, predicted changes) starts a new episode.
- `boundary_ms = 0` and `boundary_ms = 60000` behave; out of range is 422.
- A run on a video with no reference, a not-finished run, a detection run, an unknown run: the documented 404/409, not a 500.
- 50,000 processed frames with 300 intervals score in under a second (no per-frame scan of all intervals).
- Editing the reference refreshes the scores on the run page; no request is made while the video has no reference.

---

## File Structure

Backend
- `backend/app/reference/evaluation.py` (new): `EvalFrame`, `EvalInterval`, `evaluate_axis`, helpers.
- `backend/app/reference/schemas.py`: evaluation response models.
- `backend/app/reference/service.py`: `match_axes`, `evaluate_run`.
- `backend/app/reference/router.py`: the route.
- Tests: `backend/tests/test_reference_evaluation_core.py`, `test_reference_evaluation_episodes.py`, `test_reference_evaluation_api.py`.

Frontend
- `frontend/src/entities/useEvaluation.ts` (+ invalidation hook-ups in `useReference.ts`).
- `frontend/src/features/qc/classification/evaluationLogic.ts` (pure helpers), `EvaluationPanel.tsx`, `ConfusionMatrix` inside the panel folder if the panel grows, tests next to each.
- Modify `AxisLanes.tsx`, `ClassificationRunPage.tsx` (and `useRunReference.tsx` if needed for the reference status).

Docs: `ROADMAP.md`, `CHANGELOG.md`.

## Worked scenario (the numbers the backend tests must reproduce)

Axis "Anatomy"; model classes `["caecum", "colon_left", "rectum"]`; reference intervals A = `[0, 3000) caecum`, B = `[3000, 6000) colon_left`, C = `[8000, 10000) colon_left` (a gap `[6000, 8000)` and nothing after 10000). Processed frames every 1000 ms from 0 to 11000 (12 frames) with predictions and top-1 confidences:

| ts | 0 | 1000 | 2000 | 3000 | 4000 | 5000 | 6000 | 7000 | 8000 | 9000 | 10000 | 11000 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| pred | caecum | caecum | colon_left | caecum | colon_left | colon_left | rectum | rectum | colon_left | rectum | colon_left | colon_left |
| conf | .95 | .95 | .90 | .60 | .95 | .95 | .95 | .95 | .95 | .80 | .95 | .95 |

Expected: `frames_total 12`, `frames_evaluated 8` (ts 0-5000 and 8000, 9000), `frames_excluded 4`; `accuracy 0.625`; vocabulary `["caecum", "colon_left", "rectum"]`; confusion rows (truth) x columns (predicted): caecum `[2,1,0]`, colon_left `[1,3,1]`, rectum `[0,0,0]`; class rows: caecum `tp 2, fp 1, fn 1, support 3`, precision 2/3, recall 2/3, f1 2/3; colon_left `tp 3, fp 1, fn 2, support 5`, precision 0.75, recall 0.6, f1 2/3; rectum `tp 0, fp 1, fn 0, support 0`, precision 0.0, recall `null`, f1 0.0; `macro_f1 = 2/3` (rectum has no support). With `boundary_ms=2000`: three one-frame episodes in time order: `(2000, caecum -> colon_left, conf .90)`, `(3000, colon_left -> caecum, conf .60)`, `(9000, colon_left -> rectum, conf .80)`, all `boundary`; boundary frames 3, interior 0. With `boundary_ms=500`: the 2000 and 9000 episodes are `interior`, the 3000 one `boundary`. Transitions: `reference 1` (A to B at 3000; C does not touch B), lag at 3000 is 1000 (first colon_left inside B is ts 4000), `median_lag_ms 1000`, `never_switched 0`; `model_switches 4` (0to1000 no, then 1000to2000, 2000to3000, 3000to4000 and 8000to9000; the pair 5000 to 8000 is not adjacent because 6000 and 7000 lie between), `excess_switches 3`.

---

### Task 1: Scoring core: frames, confusion and per-class numbers

**Files:**
- Create: `backend/app/reference/evaluation.py`
- Test: `backend/tests/test_reference_evaluation_core.py`

**Interfaces:**
- Produces: dataclasses `EvalFrame(ts_ms: int, predicted: str, confidence: float)`, `EvalInterval(start_ms: int, end_ms: int, label: str)`, `ClassScore(name, support, tp, fp, fn, precision, recall, f1)` (ratios `float | None`), `AxisCore(frames_total, frames_evaluated, frames_excluded, accuracy, macro_f1, classes: list[ClassScore], labels: list[str], matrix: list[list[int]])`; `score_frames(frames: list[EvalFrame], intervals: list[EvalInterval], model_classes: list[str], reference_classes: list[str]) -> AxisCore`. `frames` need not be sorted (sort by `ts_ms` inside); `intervals` of one axis, non-overlapping; the containing interval is found with `bisect` over sorted starts.

- [ ] **Step 1: Write the failing tests** with the worked scenario (every number above), plus: a frame at exactly `end_ms` excluded and at exactly `start_ms` included; a truth class the model cannot output (row in the matrix, recall 0.0 when it has support, precision `null`); a model class never in the truth; an empty frames list and an empty intervals list (`accuracy None`, `macro_f1 None`, no exception); unsorted input gives the same result.
- [ ] **Step 2: Run** `cd backend && uv run pytest tests/test_reference_evaluation_core.py -v`. Expected: FAIL (module missing).
- [ ] **Step 3: Implement** `score_frames` per the Global Constraints (vocabulary order, `null` on zero denominators, `macro_f1` over classes with support greater than 0).
- [ ] **Step 4: Run** the file. Expected: PASS.
- [ ] **Step 5: Commit** `feat(reference): score frames against reference intervals`.

### Task 2: Episodes, boundary split, lags and switches

**Files:**
- Modify: `backend/app/reference/evaluation.py`
- Test: `backend/tests/test_reference_evaluation_episodes.py`

**Interfaces:**
- Consumes: `EvalFrame`, `EvalInterval`, `AxisCore`, `score_frames` (Task 1).
- Produces: dataclasses `Episode(start_ms, end_ms, frames, truth, predicted, kind: Literal["boundary","interior"], mean_confidence, max_confidence)`, `Lag(at_ms, from_label, to_label, lag_ms: int | None)`, `Transitions(reference, model_switches, excess_switches, median_lag_ms: float | None, never_switched, lags: list[Lag])`, `ErrorCounts(boundary_frames, interior_frames)`, `AxisEvaluation` (all of `AxisCore` plus `episodes`, `errors`, `transitions`); `evaluate_axis(frames, intervals, model_classes, reference_classes, boundary_ms: int) -> AxisEvaluation` (calls `score_frames`, then adds the rest). Episodes are returned in time order; `median_lag_ms` is the median of the non-null lags (mean of the two middle values for an even count), `None` when there are none.

- [ ] **Step 1: Write the failing tests** with the worked scenario at `boundary_ms=2000` and `500` (episodes, kinds, counts, confidences, transitions, lag, switches, excess); an excluded frame between two wrong frames of the same truth/pred splits them into two episodes; a change of the wrong predicted class inside one stretch starts a new episode; a long error run whose middle is more than `boundary_ms` from both edges is `interior` while its edge frames count as boundary frames; `boundary_ms=0` classifies only frames exactly on the interval start as boundary (the end is exclusive, so `end - ts >= 1`); a lag that is `None` (the model never switched, and a target label that is not a model class) and counted in `never_switched`; non-touching intervals produce no transition; an even number of lags gives the mean of the middle two.
- [ ] **Step 2: Run** `uv run pytest tests/test_reference_evaluation_episodes.py -v`. Expected: FAIL.
- [ ] **Step 3: Implement** `evaluate_axis` in a single pass over the sorted evaluated frames (keep the containing interval index per frame from Task 1 to avoid a second lookup).
- [ ] **Step 4: Run** both evaluation test files. Expected: PASS.
- [ ] **Step 5: Commit** `feat(reference): error episodes, boundary split, lag and switch counts`.

### Task 3: Service, matching and the endpoint

**Files:**
- Modify: `backend/app/reference/schemas.py`, `backend/app/reference/service.py`, `backend/app/reference/router.py`
- Test: `backend/tests/test_reference_evaluation_api.py`

**Interfaces:**
- Consumes: `evaluate_axis` (Task 2); `get_reference` (existing, returns `ReferenceRead` with `axes`, `intervals` incl. `orphaned`, `status`); the run model `InferenceRun` (`axes` JSON set for classification runs, `predictions_key`, `status`, `video_id`); `StorageService.download` (as `compare_runs` uses it); the predictions document shape `{"axes": [{"name", "classes"}], "frames": {idx: {"timestamp_ms", "axes": [{"class_id", "confidence", "probs"}]}}}`.
- Produces schemas: `EvalClassRead`, `EvalConfusionRead(labels, matrix)`, `EvalErrorsRead`, `EvalLagRead(at_ms, from_, to, lag_ms)` (serialise `from_` as `"from"` via an alias), `EvalTransitionsRead`, `EvalEpisodeRead`, `AxisEvaluationRead(name, matched, reference_category_id, reference_axis_name, frames_total, frames_evaluated, frames_excluded, accuracy, macro_f1, classes, confusion, errors, transitions, episodes)` (an unmatched axis has `matched=False`, the reference fields null, `frames_excluded = frames_total`, empty lists and null ratios), `EvaluationRead(run_id, video_id, reference_status, boundary_ms, axes)`, field names exactly as in the spec's response shape.
- Produces service: `match_axes(model_axes: list[dict], reference_axes: list[ReferenceAxisRead]) -> list[int | None]` (the reference axis sharing the most class names; ties to the lower category id; `None` when none shared); `evaluate_run(session, storage, run_id: int, boundary_ms: int) -> EvaluationRead`; exceptions `RunNotEvaluable(message)` (maps to 409: run not succeeded, not a classification run, or the video has no reference intervals), unknown run 404.
- Produces route: `GET /reference/runs/{run_id}/evaluation?boundary_ms=2000` (`ge=0, le=60000`, default 2000; 422 outside).

- [ ] **Step 1: Write the failing tests** (TestClient, isolated rows, a fake or in-memory storage object returning a predictions JSON, as the compare tests do): the worked scenario end to end through the API (every number); a model axis whose classes match no reference axis returns `matched: false`; two reference axes (Anatomy, Quality) and a model with only Anatomy classes pick Anatomy; ties go to the lower category id; orphaned intervals are ignored; `reference_status` is passed through (`clean` and `compromised`); 404 unknown run; 409 for a pending run, a detection run, and a video with no intervals; 422 for `boundary_ms=-1` and `60001`; no NaN/Infinity in the JSON (zero-support classes give null); a performance test with 50,000 frames and 300 intervals completes in under one second (time only `evaluate_axis` through the service with the document already in memory).
- [ ] **Step 2: Run** `uv run pytest tests/test_reference_evaluation_api.py -v`. Expected: FAIL.
- [ ] **Step 3: Implement** the schemas, `match_axes`, `evaluate_run` (convert document frames to `EvalFrame` with `classes[class_id]` and `confidence`; reference intervals of the matched axis to `EvalInterval` with the label name taken from `axes[].classes`) and the route (map `RunNotEvaluable` to 409, unknown run to 404).
- [ ] **Step 4: Run** the three evaluation test files plus `tests/test_reference_read.py`. Expected: PASS.
- [ ] **Step 5: Re-export OpenAPI**, confirm `git diff --stat openapi.json` changed.
- [ ] **Step 6: Commit** `feat(reference): evaluation endpoint` (include `openapi.json`).

### Task 4: Frontend hook, helpers and invalidation

**Files:**
- Create: `frontend/src/entities/useEvaluation.ts`, `frontend/src/features/qc/classification/evaluationLogic.ts`
- Modify: `frontend/src/entities/useReference.ts` (invalidate `["evaluation"]` wherever `["reference", videoId]` is invalidated on settle, so editing the reference refreshes the scores)
- Test: `useEvaluation.test.tsx`, `evaluationLogic.test.ts`, extend `useReference.test.tsx`

**Interfaces:**
- Consumes: regenerated `schema.d.ts` (run `npm run generate-api` after Task 3).
- Produces: `useEvaluation(runId: number | null, boundaryMs: number, enabled: boolean)` (query key `["evaluation", runId, boundaryMs]`, `apiClient.GET("/reference/runs/{run_id}/evaluation", ...)`, returns `EvaluationRead`; `enabled && runId !== null`); `evaluationLogic.ts`: `sortEpisodes(episodes, mode: "longest" | "confident"): Episode[]` (longest: frames desc then start asc; confident: mean_confidence desc then frames desc; stable, does not mutate), `formatRatio(value: number | null): string` (`"—"` for null, otherwise a percentage with one decimal), `episodeSpans(episodes, stepMs: number): { startMs: number; endMs: number }[]` (end = `end_ms + stepMs`, where `stepMs` is the run's processed-frame step; used for the red hatching), `processedStepMs(timestamps: number[]): number` (the median gap between consecutive processed timestamps, 0 for fewer than two).

- [ ] **Step 1: Write the failing tests**: both sort modes with ties; `formatRatio(null)` and `formatRatio(0.6666)`; `episodeSpans`; `processedStepMs` for even and uneven steps and short lists; the hook builds the right request and respects `enabled`; settling a reference mutation invalidates `["evaluation"]` (spy on `invalidateQueries`).
- [ ] **Step 2: Run** `cd frontend && npx vitest run src/entities src/features/qc/classification/evaluationLogic.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** the hook, the helpers and the invalidation (inside the existing shared `settle` helper of `useReference.ts` and in `useRestoreClean`'s settle).
- [ ] **Step 4: Run** the same command and the type check. Expected: PASS.
- [ ] **Step 5: Commit** `feat(reference): evaluation hook and helpers`.

### Task 5: The evaluation panel

**Files:**
- Create: `frontend/src/features/qc/classification/EvaluationPanel.tsx`
- Test: `EvaluationPanel.test.tsx`

**Interfaces:**
- Consumes: `useEvaluation`, `sortEpisodes`, `formatRatio` (Task 4); `formatClock` from `features/qc/analysis/strip`.
- Produces: `EvaluationPanel({ runId, hasReference, onSeek, onBoundaryChange?, boundaryMs, setBoundaryMs })` (or an equivalent props shape; the implementer decides, keeping the panel self-contained): an axis selector (the evaluation's axes), the summary (accuracy, macro F1, evaluated and excluded frame counts, boundary/interior error counts, `model_switches` vs `reference_transitions` and `excess_switches`, `median_lag_ms` and `never_switched`), the per-class table (support, precision, recall, F1, `—` for null), the confusion matrix (rows truth, columns predicted, class labels, cells shaded by count), the boundary tolerance number input (0 to 60 seconds shown in seconds, sent in ms), notes ("These scores are optimistic: frames of this video were used for training" when `reference_status` is `compromised`; "This axis has no matching reference axis" when unmatched), the episode list (time `m:ss`, truth to predicted, frames, mean confidence, kind) with two sort buttons ("Longest first", "Most confident first") and a cap of 200 visible rows with a "Show more" button; clicking an episode calls `onSeek(start_ms)` after pausing is handled by the caller. No request and a message "Label this video's reference to score the model" with a link to `/qc/reference/{video_id}` when `hasReference` is false; loading and error states.

- [ ] **Step 1: Write the failing tests** (mock `useEvaluation`): every section renders with the worked scenario's numbers; both sort buttons reorder the episodes; clicking an episode seeks to its start; the compromised note, the unmatched note and the no-reference message with the link; null ratios show `—`; the tolerance input changes the value passed to the hook (seconds to ms); more than 200 episodes show a "Show more" button that reveals the rest; the confusion matrix has the right cells and labels.
- [ ] **Step 2: Run** `npx vitest run src/features/qc/classification/EvaluationPanel.test.tsx`. Expected: FAIL.
- [ ] **Step 3: Implement** the panel (Tailwind dark classes; split the confusion matrix into its own small component in the same folder if the file grows past about 250 lines).
- [ ] **Step 4: Run** the test and the type check. Expected: PASS.
- [ ] **Step 5: Commit** `feat(reference): evaluation panel`.

### Task 6: Wire the panel and the red hatching into the run page

**Files:**
- Modify: `frontend/src/features/qc/classification/AxisLanes.tsx`, `ClassificationRunPage.tsx` (and `useRunReference.tsx` only if the reference status/has-reference flag is easier to expose from there)
- Test: extend `AxisLanes.test.tsx`, `ClassificationRunPage.test.tsx`

**Interfaces:**
- Consumes: `EvaluationPanel` (Task 5), `useEvaluation`, `episodeSpans`, `processedStepMs` (Task 4).
- Produces: `AxisLanes` gains an optional `errorSpans?: { startMs: number; endMs: number }[][]` (one list per model axis, index-aligned with `axes`): a red hatched overlay on the model lane at those spans, memoised together with the lane segments so a playhead tick does not recompute it, drawn under the playhead and blip ticks; `ClassificationRunPage` renders `EvaluationPanel` in the right sidebar under the blip window, owns the boundary tolerance state (default 2000 ms), seeks and pauses the video when an episode is clicked, passes `hasReference` (the video's reference has at least one interval) and builds `errorSpans` from the evaluation response (axes matched by name/index order; unmatched axes get `[]`).

- [ ] **Step 1: Write the failing tests**: with a mocked evaluation response the lane of the matching model axis shows the hatched overlay at the right left/width and an unmatched axis shows none; the overlay is not recomputed on a playhead tick (the existing memoisation test style); clicking an episode in the panel pauses and seeks the video; no evaluation request is made and the "Label this video's reference" message shows when the video has no reference; the panel appears only on classification runs; `[`/`]` blip navigation still works.
- [ ] **Step 2: Run** `npx vitest run src/features/qc`. Expected: FAIL.
- [ ] **Step 3: Implement** the overlay and the wiring.
- [ ] **Step 4: Run** `npx vitest run src/features/qc src/features/reference src/entities` and the type check. Expected: PASS.
- [ ] **Step 5: Commit** `feat(reference): evaluation panel and error hatching on the run page`.

### Task 7: Live check and docs

**Files:**
- Modify: `ROADMAP.md`, `CHANGELOG.md`, `docs/specs/2026-11-03-qc-reference-evaluation-design.md` (status line)

- [ ] **Step 1: Prepare data.** No migration is needed. The backend (`uvicorn --reload`) picks up the code; ask before touching any container or dev server. In the real browser label a short real video (for example `polyposis`, 28 s) with keys, run the classification model on it through the QC page.
- [ ] **Step 2: Hand-count.** Open the run page, read every number on the panel and verify a few against a hand count from the two lanes (frames evaluated, a class's tp/fp/fn, one episode's span, one lag); check that editing the reference (drag an edge, relabel) refreshes the scores, that the red hatching sits where the lanes differ, that the tolerance input changes boundary/interior counts, and that a video without a reference shows the message. Note every failure honestly.
- [ ] **Step 3: Sweep.** Delete every interval, `video_references` row, run and object created for the check (back up to the scratchpad first; delete by precise predicate).
- [ ] **Step 4: Docs.** ROADMAP entry (what was built, deviations, what was and was not verified live), CHANGELOG entry, spec status line.
- [ ] **Step 5: Commit** `docs: QC reference evaluation status, changelog and roadmap`.
