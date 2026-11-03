# QC Classification Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** QC can run one or more frame classifiers (one per axis) on a video, store labels and probabilities per frame, and show them with per-axis lanes, badges and blip (abrupt change) navigation.

**Architecture:** A classification run is an ordinary `InferenceRun` with a new nullable JSON column `axes` (a snapshot, non-null means classification). The same `inference_run` Celery task handles it through a second adapter that decodes the video once and feeds every frame to every axis model. The run view for classification is a separate page component so the detection page is untouched.

**Tech Stack:** FastAPI + SQLAlchemy + Alembic, Celery in `ml-worker` (Ultralytics YOLO11-cls), React + Vite + TanStack Query + openapi-typescript, Vitest.

**Spec:** [docs/specs/2026-11-03-qc-classification-design.md](../specs/2026-11-03-qc-classification-design.md)

## Global Constraints

- English only in code, comments, docstrings and UI copy (CLAUDE.md).
- Work directly on `master`; no branches or worktrees. End commit messages with `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`.
- Tests never write to the real `endoscopy` DB: `import app.db as db_module` + `db_module.SessionLocal()`, never `from app.db import SessionLocal`. Clean up any rows created in the real DB.
- Never write a hand-rolled `fetch()` to the API; use `apiClient`. The one existing exception is the presigned predictions download in `usePredictions`.
- After any backend schema or route change: `cd backend && PYTHONPATH=. uv run python scripts/export_openapi.py` and check `git diff --stat openapi.json`. Do not hand-edit `frontend/src/shared/api/generated/`.
- Dark theme only; no light-background classes.
- Models that can run: `task_type` classification and `adapter == "ultralytics_yolo"`. DINOv3 versions are refused (422) and not listed.
- Axes per run: 1 to 6; axis names unique within a run.
- Probabilities rounded to 3 decimals; confidence is the top-1 probability.
- Blip: a stretch of one label of at most `flickerN` processed frames whose two neighbours carry the same other label; stretches touching the video start or end are never blips; consecutive blips each count.
- Do not touch dev servers or ports (:5173/:5174, uvicorn) without asking.
- The ml-worker tests do not ship in the image: use the documented `docker cp` + `docker compose exec ml-worker` workflow.

## Review Focus

- A video where every processed frame has the same label: one segment, zero blips, no crash.
- `frame_stride` > 1 with a blip window that spans seconds: the coarse-window warning must show, as for detection.
- A blip at the very start or end of the video, and two blips in a row (A B A C A): edge is not a blip, both inner ones are.
- A classification model with no recorded `class_names`, or whose class names match no taxonomy label and no `name` given: 422, not a 500.
- Opening `/qc/:runId` for a classification run must not render detection panels (flags, reels, confidence sliders), and the flags/compare/commit endpoints must answer 409 for it.
- A run still viewable after its `ModelVersion` is deleted (axes snapshot carries names and classes).
- A very long video (tens of thousands of frames): lanes render from run-length segments, badge lookup is a binary search, not a scan.

---

## File Structure

Backend
- `backend/app/inference/models.py`: add `InferenceRun.axes`.
- `backend/alembic/versions/<new>_inference_run_axes.py`: migration after head `a1b2c3d4e5f6`.
- `backend/app/inference/axes.py` (new): axis-name inference from taxonomy.
- `backend/app/inference/schemas.py`: `ClassifierSpec`, `InferenceRunCreate` XOR validation, `InferenceRunRead` gains `task_type`, `axes`.
- `backend/app/inference/service.py`: `create_classification_run`, shared `_start_run`, 409 guard for flags/commit/compare.
- `backend/app/inference/router.py`: route dispatch and error mapping.

ml-worker
- `ml-worker/app/models.py`: mirror `InferenceRun.axes`.
- `ml-worker/app/classification_adapter.py` (new): request/result dataclasses and `UltralyticsClassificationAdapter`.
- `ml-worker/app/tasks.py`: `inference_run` branches on `payload["task_type"] == "classification"`.

Frontend
- `frontend/src/features/qc/classification/` (new folder): `types.ts`, `segments.ts`, `blips.ts`, `axisIndex.ts`, `AxisLanes.tsx`, `AxisBadges.tsx`, `ClassificationRunPage.tsx`, `BlipWindowControl.tsx`, and tests next to each.
- `frontend/src/features/qc/analysis/events.ts`: make `nextEvent`/`prevEvent` generic over `{ startMs: number }`.
- `frontend/src/features/qc/runnableModels.ts`: add `classificationModels`.
- `frontend/src/features/qc/RunForm.tsx`, `QcPage.tsx`: classify mode.
- `frontend/src/entities/useInferenceRuns.ts`: create-run body accepts `classifiers`.
- `frontend/src/features/qc/RunRoute.tsx` (new) and `frontend/src/app/App.tsx`: choose page by run kind.

Docs: `ROADMAP.md`, `CHANGELOG.md`.

---

### Task 1: Store axes on a run

**Files:**
- Modify: `backend/app/inference/models.py`, `backend/app/inference/schemas.py`, `ml-worker/app/models.py`
- Create: `backend/alembic/versions/<rev>_inference_run_axes.py`
- Test: `backend/tests/test_inference_axes_model.py`

**Interfaces:**
- Produces: `InferenceRun.axes: Mapped[list[dict] | None]` (JSON, nullable). Each entry: `{"model_version_id": int | None, "model_name": str, "name": str, "category_id": int | None, "classes": list[str]}`. `InferenceRunRead.axes: list[AxisRead] | None` and `InferenceRunRead.task_type: Literal["detection","segmentation","classification"] | None` (classification when `axes` is set; otherwise None, since detection runs carry no task column).

- [ ] **Step 1: Write the failing test** `test_a_run_stores_and_returns_axes`: create an `InferenceRun` with `axes=[{"model_version_id": None, "model_name": "m", "name": "Anatomy", "category_id": None, "classes": ["a", "b"]}]` and `model_version_id=None`, commit, reload, assert equality; assert `InferenceRunRead.model_validate(run).task_type == "classification"` and that a run without axes gives `task_type is None` and `axes is None`.
- [ ] **Step 2: Run** `cd backend && uv run pytest tests/test_inference_axes_model.py -v`. Expected: FAIL (no `axes`).
- [ ] **Step 3: Implement** the column, the `AxisRead` schema, the two read fields (a `computed_field` or validator deriving `task_type`), the Alembic migration (nullable, no backfill, `down_revision = "a1b2c3d4e5f6"`), and the mirror column in `ml-worker/app/models.py`.
- [ ] **Step 4: Run** the test and `uv run alembic upgrade head` against the test DB path used by the existing migration tests. Expected: PASS.
- [ ] **Step 5: Commit** `feat(qc): store classification axes on an inference run`.

### Task 2: Infer an axis name from the taxonomy

**Files:**
- Create: `backend/app/inference/axes.py`
- Test: `backend/tests/test_inference_axes_infer.py`

**Interfaces:**
- Produces: `infer_axis(session: Session, class_names: list[str]) -> tuple[str, int | None] | None`. Returns `(category name, category_id)` for the category owning the most **distinct label names** among `class_names`; `category_id` is returned only when that category owns all of `class_names`, else `None`. Returns `None` when no class name matches a label. Duplicate label rows with the same name (different taxonomy versions) count once.

- [ ] **Step 1: Write failing tests** with isolated-DB rows: (a) all classes in one category returns `(name, id)`; (b) 6 classes in Anatomy and `outside_the_body` in Artifacts returns `("Anatomy", None)`; (c) a label name present twice in a category counts once; (d) no matches returns `None`; (e) a tie between two categories picks the lower category id (deterministic).
- [ ] **Step 2: Run** the file. Expected: FAIL (module missing).
- [ ] **Step 3: Implement** `infer_axis` with one query over `Label` joined to `Category`; compare names exactly (case-sensitive; the model's class names come from the same label names at export).
- [ ] **Step 4: Run** the file. Expected: PASS.
- [ ] **Step 5: Commit** `feat(qc): infer a classifier's axis name from the taxonomy`.

### Task 3: Create classification runs via the API

**Files:**
- Modify: `backend/app/inference/schemas.py`, `backend/app/inference/service.py`, `backend/app/inference/router.py`
- Test: `backend/tests/test_inference_classification_api.py`

**Interfaces:**
- Consumes: `infer_axis` (Task 2), `InferenceRun.axes` (Task 1).
- Produces: `ClassifierSpec(model_version_id: int, name: str | None = None, category_id: int | None = None)`; `InferenceRunCreate.model_version_id: int | None = None` and `classifiers: list[ClassifierSpec] | None = None` with a validator requiring exactly one (422 otherwise) and `1 <= len(classifiers) <= 6`; `service.create_classification_run(session, *, video_id: int, classifiers: list[ClassifierSpec], frame_stride: int, created_by: User, perturbation: dict | None = None) -> InferenceRun`; a private `_start_run(session, run, payload, created_by) -> InferenceRun` extracted from the tail of `create_inference_run` (job row, `celery_app.send_task("inference_run", args=[job.id])`, enqueue-failure handling) and used by both.
- Job payload for classification: `{"inference_run_id", "video_id", "task_type": "classification", "model_name", "frame_stride", "perturbation", "axes": [{"name", "weights_key", "classes"}]}`.
- Run row: `model_version_id=None`, `model_name` = axis names joined with `", "` (truncated to 200), `axes` snapshot as in Task 1.

- [ ] **Step 1: Write failing tests** (TestClient, stubbed `send_task` as in `test_inference_api.py`): happy path with two axes returns 202 with `task_type == "classification"` and a job whose payload has two axes; both `model_version_id` and `classifiers` given and neither given both 422; a detection model in `classifiers` 422; a DINOv3-adapter version 422; two entries resolving to the same axis name 422; a version with empty `class_names` 422; a name not inferable and none given 422; explicit `name` wins over inference; unknown model 404; non-playable video 409; deleting an axis's `ModelVersion` leaves the run readable with its `axes` snapshot intact; the existing detection tests still pass.
- [ ] **Step 2: Run** the file. Expected: FAIL.
- [ ] **Step 3: Implement** schemas, `create_classification_run` (validation order: video, then each version: classification task, `YOLO_ADAPTER`, non-empty `class_names`, then axis name and uniqueness) and the router branch. Map the new refusals to `UnsupportedModelType` (422) so the router needs no new exception types.
- [ ] **Step 4: Run** the new file plus `tests/test_inference_api.py`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(qc): create classification inference runs`.

### Task 4: Refuse flag, commit and compare for classification runs

**Files:**
- Modify: `backend/app/inference/service.py`, `backend/app/inference/router.py`
- Test: `backend/tests/test_inference_classification_guards.py`

**Interfaces:**
- Produces: `class NotForClassificationRuns(Exception)`; raised by `_require_flaggable_run` (used by put/delete/commit of flags) and by `compare_runs` when either run has `axes`. The router maps it to 409 with the detail "Not available for classification runs".

- [ ] **Step 1: Write failing tests**: with a succeeded classification run, `PUT /inference/runs/{id}/flags`, `POST /inference/runs/{id}/commit` and `GET /inference/compare?run_a=&run_b=` answer 409 with that detail; `GET /inference/runs/{id}/flags` still answers 200 with an empty list.
- [ ] **Step 2: Run** the file. Expected: FAIL.
- [ ] **Step 3: Implement** the exception, the two raise sites and the router mapping.
- [ ] **Step 4: Run** the file plus `tests/test_qc_flags_api.py` and `tests/test_inference_compare.py`. Expected: PASS.
- [ ] **Step 5: Re-export OpenAPI** with `cd backend && PYTHONPATH=. uv run python scripts/export_openapi.py`, confirm `git diff --stat openapi.json` shows a change.
- [ ] **Step 6: Commit** `feat(qc): refuse flags, commit and compare for classification runs` (include `openapi.json`).

### Task 5: Classification adapter in ml-worker

**Files:**
- Create: `ml-worker/app/classification_adapter.py`
- Test: `ml-worker/tests/test_classification_adapter.py`

**Interfaces:**
- Consumes: `app.perturbation.apply_perturbation`, the frame-reading loop pattern of `ultralytics_inference_adapter.py` (`grab()`/`retrieve()`, timestamp rule).
- Produces: `AxisWeights(name: str, weights_path: Path)`; `ClassificationRequest(video_path: Path, axes: list[AxisWeights], frame_stride: int, perturbation: dict | None = None)`; `ClassificationResult(fps: float, axes: list[dict], frames: dict[str, dict])` where `axes[i] = {"name": str, "classes": list[str]}` and `frames[str(index)] = {"timestamp_ms": int, "axes": [{"class_id": int, "confidence": float, "probs": list[float]}]}` parallel to `axes`; `UltralyticsClassificationAdapter(model_loader=None).infer(request, on_progress) -> ClassificationResult` with the same `on_progress(processed, total)` contract.

- [ ] **Step 1: Verify the Ultralytics API.** In the ml-worker container, load a tiny classification model (or read the installed `ultralytics/engine/results.py`) and confirm which attribute gives the full probability vector for a classification `Results` (expected `result.probs.data`) and that `model.names` order equals class id order. Record the finding in the adapter's module docstring.
- [ ] **Step 2: Write failing tests** with an injected `model_loader` and a small synthetic video made with OpenCV: two stub axis models produce the documented JSON shape; `frame_stride=5` processes every fifth frame; `probs` are rounded to 3 decimals and `confidence` equals the max prob; the perturbation is applied before the models (a stub records the pixel mean); an unreadable video raises `ValueError("Could not open the video file")`; a video with no readable frames raises `ValueError("The video has no readable frames")`; each model is loaded once, not per frame.
- [ ] **Step 3: Run** with the documented workflow (`docker cp` the tests, `docker compose exec ml-worker pytest tests/test_classification_adapter.py -v`). Expected: FAIL.
- [ ] **Step 4: Implement** the module: decode once, for each kept frame run every model, build the entry list in axis order, flush progress per frame.
- [ ] **Step 5: Run** the same command. Expected: PASS.
- [ ] **Step 6: Commit** `feat(ml-worker): classification inference adapter`.

### Task 6: Run classification in the `inference_run` task

**Files:**
- Modify: `ml-worker/app/tasks.py` (the `inference_run` task, around line 1048)
- Test: `ml-worker/tests/test_tasks_inference.py` (extend)

**Interfaces:**
- Consumes: `UltralyticsClassificationAdapter`, `AxisWeights`, `ClassificationRequest` (Task 5); job payload from Task 3.
- Produces: for `payload["task_type"] == "classification"` the task downloads each axis's weights to the work dir, calls the classification adapter (injectable through the existing `adapter` argument), and uploads the document `{"task_type": "classification", "fps", "frame_stride", "perturbation", "axes": [{"name", "classes"}], "frames": {...}}` to `inference/{run.id}/predictions.json`. Eviction, progress throttling, the failed path and the tolerant force-delete path stay exactly as for detection.

- [ ] **Step 1: Write failing tests** next to the existing detection ones, with a stub adapter: a classification job ends SUCCEEDED with the document shape above and `frames_total == frames_processed`; a stub that raises ends FAILED with the message; the detection tests are unchanged.
- [ ] **Step 2: Run** with the ml-worker workflow. Expected: FAIL.
- [ ] **Step 3: Implement** the branch. Choose the default adapter from the payload's `task_type`; keep the document building for the two kinds in small helper functions so the task body stays readable.
- [ ] **Step 4: Run** `tests/test_tasks_inference.py` and `tests/test_ultralytics_inference_adapter.py`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(ml-worker): run classification jobs in the inference task`.

### Task 7: Segments, blips and lookups (pure frontend logic)

**Files:**
- Create: `frontend/src/features/qc/classification/types.ts`, `segments.ts`, `blips.ts`, `axisIndex.ts`
- Modify: `frontend/src/features/qc/analysis/events.ts`
- Test: `segments.test.ts`, `blips.test.ts`, `axisIndex.test.ts`, `analysis/events.test.ts` (extend)

**Interfaces:**
- Produces in `types.ts`: `ClassificationDocument { task_type: "classification"; fps: number; frame_stride: number; axes: { name: string; classes: string[] }[]; frames: Record<string, { timestamp_ms: number; axes: { class_id: number; confidence: number; probs: number[] }[] }> }`.
- `axisIndex.ts`: `AxisIndex { timestamps: number[]; classIds: number[]; confidences: number[] }`; `buildAxisIndexes(doc: ClassificationDocument): AxisIndex[]` (one per axis, frames sorted by time); `labelAt(index: AxisIndex, timeMs: number): { classId: number; confidence: number } | null` (nearest processed frame at or before the time, `null` before the first).
- `segments.ts`: `Segment { classId: number; startMs: number; endMs: number; frames: number }`; `buildSegments(index: AxisIndex, durationMs: number): Segment[]`. A segment ends where the next begins; the last ends at `max(durationMs, last timestamp)`.
- `blips.ts`: `Blip { axis: number; classId: number; surroundingClassId: number; startMs: number; endMs: number; frames: number }`; `findBlips(index: AxisIndex, axis: number, n: number): Blip[]`; `mergeBlips(perAxis: Blip[][]): Blip[]` sorted by `startMs`, ties by axis.
- `events.ts`: `nextEvent<T extends { startMs: number }>(events: T[], timeMs: number): T | null` and `prevEvent` likewise; behaviour unchanged.

- [ ] **Step 1: Write failing tests**: `labelAt` before the first frame is `null`, between processed frames holds the previous one; `buildSegments` on `[0,0,1,1,1,0]` gives three segments with the right frame counts and times, and on an all-equal sequence gives one; `findBlips` with `n=2` on `A A B A A` finds one blip (B), on `B A A A` and `A A A B` finds none (edges), on `A B A C A` finds two, on `A B C` finds none (different neighbours), on a stretch of length `n+1` finds none, on empty and single-frame input returns `[]`; `mergeBlips` orders across axes; the existing event tests pass for a non-flicker element type.
- [ ] **Step 2: Run** `cd frontend && npx vitest run src/features/qc/classification src/features/qc/analysis`. Expected: FAIL.
- [ ] **Step 3: Implement** the modules. `findBlips` works on run-length segments, not raw frames.
- [ ] **Step 4: Run** the same command. Expected: PASS.
- [ ] **Step 5: Commit** `feat(qc): segment and blip logic for classification runs`.

### Task 8: Run form, model list and request body

**Files:**
- Modify: `frontend/src/features/qc/runnableModels.ts`, `RunForm.tsx`, `QcPage.tsx`, `frontend/src/entities/useInferenceRuns.ts`
- Test: `runnableModels.test.ts`, `RunForm.test.tsx` (extend)

**Interfaces:**
- Consumes: regenerated `schema.d.ts` (run `npm run generate-api` after Task 4's `openapi.json`).
- Produces: `classificationModels<T extends { task_type: string; adapter: string }>(models: T[]): T[]` (task `classification` and adapter `ultralytics_yolo`); `RunForm` prop `classifyModels: ModelOption[]` and a submit payload variant `{ classifiers: { modelVersionId: number; name?: string }[]; videoId; frameStride; perturbation }`; `useCreateInferenceRun` body accepts either `model_version_id` or `classifiers: { model_version_id: number; name?: string }[]`.

- [ ] **Step 1: Write failing tests**: `classificationModels` keeps only Ultralytics classification versions; the form has a "Detect / segment" and a "Classify" mode switch; in Classify mode, "Add axis" adds a row (model select plus an optional axis-name input), up to 6 rows, a duplicate model cannot be added twice, Run is disabled with no axis row, and submit passes the `classifiers` payload; with no classification models the empty-state text is "Train a classification model first."; Detect mode behaves as before.
- [ ] **Step 2: Run** `npx vitest run src/features/qc/RunForm.test.tsx src/features/qc/runnableModels.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** the form mode, the helper and the hook body; `QcPage` passes both model lists and calls the mutation with the right body.
- [ ] **Step 4: Run** those tests plus `npx tsc --noEmit`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(qc): classify mode in the run form`.

### Task 9: Classification run view

**Files:**
- Create: `frontend/src/features/qc/classification/AxisBadges.tsx`, `AxisLanes.tsx`, `BlipWindowControl.tsx`, `ClassificationRunPage.tsx`, `frontend/src/features/qc/RunRoute.tsx`
- Modify: `frontend/src/app/App.tsx` (route `/qc/:runId` renders `RunRoute`), `frontend/src/entities/useInferenceRuns.ts` (type of `usePredictions` result)
- Test: `AxisBadges.test.tsx`, `AxisLanes.test.tsx`, `ClassificationRunPage.test.tsx`, `RunRoute.test.tsx`

**Interfaces:**
- Consumes: Task 7 modules, `useViewParams` (for `flickerN`), `COARSE_WINDOW_MS` and the coarse-window rule from `analysis/flicker.ts`, `EventNav`, `eventDirectionFor`/`isTypingTarget` from `eventKeys.ts`, `useVideoClock`, `TranscodePrompt`, `RunStatus`.
- Produces: `RunRoute` reads the run with `useInferenceRun`; renders `ClassificationRunPage` when `run.axes` is non-null, else the existing `RunViewPage`. `AxisBadges({ videoRef, indexes, axes })` renders one chip per axis `label NN%`, truncated with a tooltip. `AxisLanes({ videoRef, axes, indexes, durationMs, blips, onSeek, reference? })` renders one lane per axis (a coloured segment per `Segment`, a playhead, white blip ticks, per-axis header with change count and per-class time share); `reference` is an optional prop accepted and ignored in this sub-project.

- [ ] **Step 1: Write failing tests**: badges show `caecum 91%` for the label at the current time and hide for times before the first frame; lanes render the right number of segments per axis, seek on click with the clicked time, show the change count and class shares; the page for a classification run shows lanes and badges and does not render FlagsPanel, ReelsPanel or the confidence slider; `[` and `]` step through merged blips of all axes; the coarse-window warning appears when `frame_stride` makes the window exceed `COARSE_WINDOW_MS`; a non-playable video shows the transcode prompt; `RunRoute` picks the right page for a run with and without `axes`; a failed run shows its error through `RunStatus`.
- [ ] **Step 2: Run** `npx vitest run src/features/qc`. Expected: FAIL.
- [ ] **Step 3: Implement** the components. Palette: reuse `colorForClass` per class id within an axis. Use `useMemo` for indexes, segments and blips so the playhead re-render does not recompute them; lanes mark everything except the playhead as memoised.
- [ ] **Step 4: Run** `npx vitest run src/features/qc` and `npx tsc --noEmit`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(qc): classification run view with axis lanes and blips`.

### Task 10: Real-browser check, docs

**Files:**
- Modify: `ROADMAP.md`, `CHANGELOG.md`, `docs/specs/2026-11-03-qc-classification-design.md` (status line)

- [ ] **Step 1: Prerequisite models.** The only classification model today covers anatomy plus `outside_the_body`. For a three-axis check, train two more small YOLO-cls models (imaging mode, quality) through the Train screen if the data supports it; if it does not, run with the models that exist (one or two axes) and say so in the ROADMAP entry. Do not fake a model.
- [ ] **Step 2: Real run.** Start the stack as in CLAUDE.md (ask before touching any dev server). Through the real UI start a classification run on a real video, wait for success, open it, and check: badges follow playback, lanes match what the video shows, a blip tick appears where the label really flickers, `[`/`]` jump between blips, the detection page still works with an old run, and the flags panel is absent. Record the findings honestly, including anything that failed.
- [ ] **Step 3: Sweep.** Delete any run or video created only for this check from the real DB and MinIO (`inference/{run_id}/`), after backing up to the scratchpad.
- [ ] **Step 4: Docs.** Add the ROADMAP entry (phase, deviations, what was and was not verified live) and a CHANGELOG entry; set the spec status to implemented.
- [ ] **Step 5: Commit** `docs: QC classification status and changelog`.
