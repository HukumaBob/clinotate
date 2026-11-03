# QC Reference Labeling Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A user can label a video's frame classes as intervals on per-axis lanes (keyboard and mouse), before any model runs and on the QC run page; the reference is stored per video and carries an automatic clean/compromised status with non-blocking warnings.

**Architecture:** A new backend module `backend/app/reference/` (two tables, service, router) owns intervals and status; a hook in `training.service.create_training_run` marks videos compromised. The frontend gets a `features/reference/` folder with pure interval logic, hooks, editable lanes, a page at `/qc/reference/:videoId`, and the reference drawn above the model lanes on the classification run page.

**Tech Stack:** FastAPI + SQLAlchemy + Alembic, React + Vite + TanStack Query + openapi-typescript, Vitest.

**Spec:** [docs/specs/2026-11-03-qc-reference-labeling-design.md](../specs/2026-11-03-qc-reference-labeling-design.md). Depends on sub-project 1 ([plan](2026-11-03-qc-classification.md), done).

## Global Constraints

- English only in code, comments, docstrings and UI copy (CLAUDE.md). Dark theme only.
- Work directly on `master`; no branches or worktrees. End commit messages with `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`.
- Tests never write to the real `endoscopy` DB: `import app.db as db_module` + `db_module.SessionLocal()` or the repo's isolated fixtures (`db_session`); clean up anything created. Never `from app.db import SessionLocal`.
- Use `apiClient`; never a hand-rolled `fetch()`. Do not hand-edit `frontend/src/shared/api/generated/`.
- After backend schema/route changes: `cd backend && PYTHONPATH=. uv run python scripts/export_openapi.py` and check `git diff --stat openapi.json`.
- Every label reference carries the `taxonomy_version` it had at creation, copied (CLAUDE.md).
- Intervals: `[start_ms, end_ms)` in milliseconds on the video's timeline; `0 <= start_ms < end_ms <= round(videos.duration_seconds * 1000)`; minimum length `MIN_INTERVAL_MS = 100`.
- Intervals of one axis (category) never overlap; touching ends are allowed; gaps are allowed and mean "no reference".
- Axis = a `Category` of the video's procedure that has labels of evaluation type `frame_classification`. Keys: digits `1`..`9`,`0` in one running sequence over all axes (axes ordered by category id, classes by label id); classes beyond the tenth have no key.
- Compromise only by training runs of task type classification; warnings never block.
- Do not touch dev servers or ports (:5173, uvicorn) without asking. Tests of the Celery/ml-worker are not involved.

## Review Focus

- Two simultaneous overlapping `POST .../intervals` yield exactly one 201 (the other 409).
- A growing interval whose right edge reaches the start of the next interval of its axis stops there; a drag past the video end stops at the end.
- A video with no procedure, or a procedure with no frame-classification labels: empty `axes`, readable UI message, no crash.
- A label moved to another category after intervals exist: its intervals come back `orphaned: true` and are not drawn; deleting a label that has intervals answers a readable 409, not a raw database error.
- A failed save: the UI rolls the change back and shows "not saved"; a closed tab does not leave a growing interval with a stale end (the last throttled save plus a flush on close/page hide).
- Keys typed into an input (blip window, names) never start an interval; `[` and `]` keep blip navigation.
- A detection/segmentation training run on a dataset containing the video's frames leaves the status `clean`; a classification run flips it to `compromised` exactly once.

---

## File Structure

Backend
- `backend/app/reference/__init__.py`, `models.py`, `schemas.py`, `service.py`, `router.py` (new module).
- `backend/alembic/versions/<rev>_reference_intervals.py` (after the current head `b2c3d4e5f6a7`; verify with `uv run alembic heads`).
- `backend/app/main.py`: include the router and import the models.
- `backend/app/training/service.py`: call `mark_compromised` after the run row exists.
- `backend/app/datasets/{schemas,router}.py`: `reference_exposure` on the balance response.
- `backend/app/media/router.py`: 409 on deleting a video with a reference. `backend/app/taxonomy/router.py`: readable 409 on deleting a label with intervals.

Frontend (`frontend/src/features/reference/`, new)
- `types.ts`, `keymap.ts`, `intervals.ts`, `matchAxes.ts` (pure), `useReferenceEditor.ts` (keyboard and save state machine), `ReferenceKeys.tsx`, `ReferenceLanes.tsx`, `ReferenceStatus.tsx`, `ReferencePage.tsx`, tests next to each.
- `frontend/src/entities/useReference.ts`.
- Modify: `frontend/src/app/App.tsx` (route), `frontend/src/features/qc/QcPage.tsx` and `RunsTable.tsx` (entry links), `frontend/src/features/qc/classification/AxisLanes.tsx` and `ClassificationRunPage.tsx` (reference lane, banner), `frontend/src/features/datasets/BalancePanel.tsx`, `frontend/src/features/training/TrainConfigForm.tsx` (warnings).

Docs: `ROADMAP.md`, `CHANGELOG.md`.

---

### Task 1: Tables, models and migration

**Files:**
- Create: `backend/app/reference/__init__.py`, `backend/app/reference/models.py`, `backend/alembic/versions/<rev>_reference_intervals.py`
- Modify: `backend/app/main.py` (import the models so they register on `Base.metadata`)
- Test: `backend/tests/test_reference_models.py`

**Interfaces:**
- Produces: `ReferenceInterval` (`id, video_id` FK `videos` `ON DELETE RESTRICT, category_id` FK `categories, label_id` FK `labels, taxonomy_version: int, start_ms: int, end_ms: int, created_by_id` FK `users, created_at, updated_at`), index on `(video_id, category_id, start_ms)`; `VideoReference` (`video_id` PK FK `videos` `ON DELETE RESTRICT, compromised_at: datetime | None, compromised_by_training_run_id: int | None` plain integer, no FK).

- [ ] **Step 1: Write the failing test** `test_a_reference_interval_round_trips`: create a video, procedure, category, evaluation type and label with the repo fixtures; insert a `ReferenceInterval` and a `VideoReference`; reload and assert every field; assert deleting the video while an interval exists raises `IntegrityError`.
- [ ] **Step 2: Run** `cd backend && uv run pytest tests/test_reference_models.py -v`. Expected: FAIL (module missing).
- [ ] **Step 3: Implement** the models (style of `app/inference/models.py`), the Alembic migration (revision after `b2c3d4e5f6a7`, no backfill, downgrade drops both tables) and the import in `main.py`.
- [ ] **Step 4: Run** the test and `uv run alembic upgrade head` against the test DB the way existing migration tests do. Expected: PASS.
- [ ] **Step 5: Commit** `feat(reference): reference interval tables`.

### Task 2: Axes, status and the read endpoint

**Files:**
- Create: `backend/app/reference/schemas.py`, `backend/app/reference/service.py`, `backend/app/reference/router.py`
- Modify: `backend/app/main.py` (include the router)
- Test: `backend/tests/test_reference_read.py`

**Interfaces:**
- Produces schemas: `ReferenceClassRead(label_id: int, name: str, key: str | None)`, `ReferenceAxisRead(category_id: int, name: str, classes: list[ReferenceClassRead])`, `ReferenceIntervalRead(id, video_id, category_id, label_id, taxonomy_version, start_ms, end_ms, orphaned: bool)`, `ReferenceRead(video_id: int, procedure_id: int | None, duration_ms: int, status: Literal["none","clean","compromised"], compromised_at: datetime | None, compromised_by_training_run_id: int | None, axes: list[ReferenceAxisRead], intervals: list[ReferenceIntervalRead])`.
- Produces service: `build_axes(session, procedure_id: int | None) -> list[ReferenceAxisRead]` (categories of the procedure holding at least one label whose evaluation type is `frame_classification`; classes ordered by label id; digit keys assigned across all axes in one running sequence, axes ordered by category id, tenth key is `"0"`, later classes get `key=None`); `get_reference(session, video_id: int) -> ReferenceRead` (raises `VideoNotFound`; `orphaned` true when the interval's label no longer belongs to its stored category or that category is not among the axes); constants `MIN_INTERVAL_MS = 100`.
- Produces route: `GET /reference/videos/{video_id}` (router prefix `/reference`, `dependencies=[Depends(get_current_user)]`), 404 for an unknown video.

- [ ] **Step 1: Write failing tests** (TestClient with the repo's auth helper, isolated rows): a colonoscopy-like procedure with Anatomy (8 labels) and Quality (2) gets keys `1..8` then `9`,`0`; a procedure with 12 anatomy classes and 2 quality classes gets keys for the first ten and `None` after; a procedure with no frame-classification labels and a video with no procedure both return `axes == []`; status is `none` with no intervals, `clean` with intervals and no `compromised_at`, `compromised` with it set; an interval whose label was moved to another category returns `orphaned: true`; unknown video 404.
- [ ] **Step 2: Run** `uv run pytest tests/test_reference_read.py -v`. Expected: FAIL.
- [ ] **Step 3: Implement** schemas, `build_axes`, `get_reference` (one query per table, no N+1 over intervals) and the route.
- [ ] **Step 4: Run** the file. Expected: PASS.
- [ ] **Step 5: Commit** `feat(reference): read a video's reference with axes and status`.

### Task 3: Create, change and delete intervals

**Files:**
- Modify: `backend/app/reference/service.py`, `backend/app/reference/schemas.py`, `backend/app/reference/router.py`
- Test: `backend/tests/test_reference_intervals_api.py`

**Interfaces:**
- Consumes: `get_reference`, `build_axes` (Task 2).
- Produces schemas: `IntervalCreate(label_id: int, start_ms: int, end_ms: int)`, `IntervalUpdate(label_id: int | None, start_ms: int | None, end_ms: int | None)` (at least one field).
- Produces service: `create_interval(session, video_id, payload: IntervalCreate, created_by: User) -> ReferenceInterval`, `update_interval(session, video_id, interval_id, payload: IntervalUpdate) -> ReferenceInterval`, `delete_interval(session, video_id, interval_id) -> None`; exceptions `IntervalNotFound`, `InvalidInterval(message)` (maps to 422), `IntervalOverlap(message)` (maps to 409).
- Produces routes: `POST /reference/videos/{video_id}/intervals` (201), `PATCH .../intervals/{interval_id}`, `DELETE .../intervals/{interval_id}` (204).
- Rules: the label must be a frame-classification label of an axis of the video's procedure (422 otherwise); `category_id` and `taxonomy_version` are copied from the label at creation; `end_ms <= start_ms`, shorter than `MIN_INTERVAL_MS` or outside `[0, round(duration_seconds*1000)]` is 422; overlap with another interval of the same category is 409 (touching ends allowed); a relabel must stay within the interval's category (422); the video row is locked (`SELECT ... FOR UPDATE`) for the overlap check and write; the first interval creates the `VideoReference` row.

- [ ] **Step 1: Write failing tests**: happy create (taxonomy_version copied, `VideoReference` row created); label of another procedure 422; label that is not frame-classification 422; `end <= start`, 99 ms, `start < 0`, `end > duration` each 422; overlap 409 and exactly touching 201; PATCH moving an edge into a neighbour 409; PATCH relabel inside the category 200 and across categories 422; DELETE then re-create the freed span 201; unknown video/interval 404; two overlapping creates from two threads each with its own session yield one 201 and one 409.
- [ ] **Step 2: Run** `uv run pytest tests/test_reference_intervals_api.py -v`. Expected: FAIL.
- [ ] **Step 3: Implement** the service functions and routes; map exceptions in the router.
- [ ] **Step 4: Run** the file plus `tests/test_reference_read.py`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(reference): create, change and delete reference intervals`.

### Task 4: Compromise, exposure and restore

**Files:**
- Modify: `backend/app/reference/service.py`, `backend/app/reference/schemas.py`, `backend/app/reference/router.py`, `backend/app/training/service.py`
- Test: `backend/tests/test_reference_compromise.py`

**Interfaces:**
- Consumes: `VideoReference`, `ReferenceInterval` (Task 1).
- Produces schemas: `ExposureVideoRead(video_id: int, title: str, frames: int)`.
- Produces service: `mark_compromised(session, dataset_id: int, run_id: int) -> list[int]` (video ids newly marked; no-op for the run's task type other than classification, for videos without intervals and for already compromised ones; sets `compromised_at` now and `compromised_by_training_run_id`); `exposure_for_dataset(session, dataset_id: int) -> list[ExposureVideoRead]` and `exposure_for_sequences(session, sequence_ids: list[int], task_type: TaskType) -> list[ExposureVideoRead]` (clean reference videos only; empty unless the task type is classification); `restore_clean(session, video_id: int) -> None` (raises `NoReference` when the video has no `VideoReference` row, maps to 409).
- Produces routes: `GET /reference/datasets/{dataset_id}/exposure`, `POST /reference/videos/{video_id}/restore-clean` (204).
- Hook: `training.service.create_training_run` calls `mark_compromised(session, dataset_id, run.id)` right after the first `session.commit()` that persists the run row; a failure inside it must not undo the run (log and continue).
- Path from frames to videos: `DatasetItem.frame_id` to `Frame.sequence_id` to `Sequence.video_id`.

- [ ] **Step 1: Write failing tests**: a classification dataset with frames of a reference video, then `create_training_run`, flips the status to `compromised` with the run id; a detection dataset leaves it `clean`; a video without intervals is not marked; a second run does not change `compromised_at`; `exposure_for_dataset` lists only clean reference videos with frame counts; `exposure_for_sequences` returns `[]` for a detection task type; `restore-clean` clears the status and answers 409 for a video with no reference.
- [ ] **Step 2: Run** `uv run pytest tests/test_reference_compromise.py -v`. Expected: FAIL.
- [ ] **Step 3: Implement** the service functions, routes and the hook.
- [ ] **Step 4: Run** the new file plus `tests/test_training_service.py` and `tests/test_training_api.py`. Expected: PASS (known pre-existing failures per the memory note are not yours; report them).
- [ ] **Step 5: Commit** `feat(reference): mark reference videos compromised by classification training`.

### Task 5: Guards, balance warning field and OpenAPI

**Files:**
- Modify: `backend/app/media/router.py` (`delete_video`), `backend/app/taxonomy/router.py` (`delete_label`), `backend/app/datasets/schemas.py`, `backend/app/datasets/router.py`
- Test: `backend/tests/test_reference_guards.py`

**Interfaces:**
- Consumes: `exposure_for_sequences` (Task 4).
- Produces: `delete_video` answers 409 with detail "This video still has a reference: delete its intervals first" when it has intervals (checked next to the existing sequence and QC-run guards); `delete_label` answers 409 with a readable detail naming the reference intervals when any exist (check before the delete); `BalanceReportRead.reference_exposure: list[ExposureVideoRead]` (default empty) filled by `dataset_balance` from `payload.sequence_ids` and `payload.task_type`.

- [ ] **Step 1: Write failing tests**: deleting a video with an interval is 409 with that text and succeeds after the intervals are deleted; deleting a label with an interval is 409 with a readable text and a label without one still deletes; `POST /datasets/balance` for a classification selection containing a clean reference video returns it in `reference_exposure`, for a detection selection returns `[]`.
- [ ] **Step 2: Run** `uv run pytest tests/test_reference_guards.py -v`. Expected: FAIL.
- [ ] **Step 3: Implement** the guards and the field.
- [ ] **Step 4: Run** the file plus `tests/test_media.py`, `tests/test_taxonomy.py`, `tests/test_dataset_balance.py`. Expected: PASS apart from known pre-existing failures.
- [ ] **Step 5: Re-export OpenAPI** and confirm `git diff --stat openapi.json` changed.
- [ ] **Step 6: Commit** `feat(reference): delete guards and balance exposure` (include `openapi.json`).

### Task 6: Pure interval logic (frontend)

**Files:**
- Create: `frontend/src/features/reference/types.ts`, `keymap.ts`, `intervals.ts`, `matchAxes.ts`
- Test: `keymap.test.ts`, `intervals.test.ts`, `matchAxes.test.ts`

**Interfaces:**
- `types.ts`: `RefInterval { id: number; categoryId: number; labelId: number; startMs: number; endMs: number }`; `RefAxis { categoryId: number; name: string; classes: { labelId: number; name: string; key: string | null }[] }`; `MIN_INTERVAL_MS = 100`; `SNAP_MS = 1000`.
- `keymap.ts`: `buildKeymap(axes: RefAxis[]): Map<string, { categoryId: number; labelId: number }>` (from each class's `key`; classes with null key absent).
- `intervals.ts`: `snapStart(intervals: RefInterval[], categoryId: number, tMs: number): number` (end of the nearest interval of the axis ending at or before `tMs` if at most `SNAP_MS` before it, else `tMs`); `clampEnd(intervals, categoryId, selfId: number | null, startMs: number, endMs: number, durationMs: number): number` (not before `startMs + MIN_INTERVAL_MS`, not past the start of the next interval of the axis nor `durationMs`); `moveEdge(intervals, id, edge: "start" | "end", ms: number, durationMs: number): RefInterval | null` (clamped against neighbours, bounds and minimum length; null for an unknown id); `decideKey(state: { growing: Record<number, RefInterval | undefined>; selectedId: number | null; intervals: RefInterval[] }, target: { categoryId: number; labelId: number }, tMs: number, durationMs: number): KeyAction` where `KeyAction = { kind: "start"; startMs: number } | { kind: "close"; id: number; endMs: number } | { kind: "switch"; closeId: number; closeEndMs: number; startMs: number } | { kind: "relabel"; id: number } | { kind: "none" }`; `coverage(intervals: RefInterval[], categoryId: number, durationMs: number): number` (0..1).
- `matchAxes.ts`: `matchAxes(modelAxes: { name: string; classes: string[] }[], refAxes: { categoryId: number; classes: { name: string }[] }[]): (number | null)[]` (for each model axis the index of the reference axis sharing the most class names, null when none shares any; ties to the lower index).
- `decideKey` rules (spec): no growing interval on the axis and none selected: `start` at `snapStart`; no growing and an interval selected: `relabel` that one; growing of the same label: `close` at `tMs`; growing of another label: `switch` (close at `tMs`, start at `tMs`); a key whose start would be inside an existing interval of the axis and nothing growing or selected: `none`.

- [ ] **Step 1: Write failing tests** with the spec's values: key assignment (ten classes get `1`..`9`,`0`; the eleventh has no entry); `snapStart` at 900 ms after an end snaps, at 1100 ms does not; `clampEnd` stops at the next interval and at the video end and keeps the minimum length; `moveEdge` on touching neighbours cannot cross; each `decideKey` branch; start inside an existing interval is `none`; `coverage` with a gap; `matchAxes` with a model class missing from the reference, two reference axes sharing one name, and no overlap.
- [ ] **Step 2: Run** `cd frontend && npx vitest run src/features/reference`. Expected: FAIL.
- [ ] **Step 3: Implement** the modules (no DOM, no React).
- [ ] **Step 4: Run** the same command and `npx tsc --noEmit` (no new errors in touched files). Expected: PASS.
- [ ] **Step 5: Commit** `feat(reference): interval and keymap logic`.

### Task 7: Reference hooks

**Files:**
- Create: `frontend/src/entities/useReference.ts`
- Test: `frontend/src/entities/useReference.test.tsx`

**Interfaces:**
- Consumes: regenerated `schema.d.ts` (run `npm run generate-api` after Task 5's `openapi.json`).
- Produces: `useReference(videoId: number | null)` (query key `["reference", videoId]`, returns `ReferenceRead`); `useCreateInterval(videoId)`, `useUpdateInterval(videoId)`, `useDeleteInterval(videoId)` (mutations that update the cached `["reference", videoId]` optimistically and roll back on error; `onSettled` invalidates); `useRestoreClean(videoId)`; `useReferenceExposure(datasetId: number | null)` (`["reference-exposure", datasetId]`). Mutation arguments mirror the API bodies (`{ labelId, startMs, endMs }` etc., converted to snake_case inside).

- [ ] **Step 1: Write failing tests** with a mocked `apiClient`: create adds the interval to the cache before the server answers and replaces it with the server's row; a 409 rolls the cache back and surfaces the error text; delete removes optimistically and restores on failure; restore invalidates the reference.
- [ ] **Step 2: Run** `npx vitest run src/entities/useReference.test.tsx`. Expected: FAIL.
- [ ] **Step 3: Implement** the hooks (follow `useQcFlags.ts` for the optimistic-update style).
- [ ] **Step 4: Run** the test and `npx tsc --noEmit`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(reference): reference hooks`.

### Task 8: Editor state machine, legend and lanes

**Files:**
- Create: `frontend/src/features/reference/useReferenceEditor.ts`, `ReferenceKeys.tsx`, `ReferenceLanes.tsx`, `ReferenceStatus.tsx`
- Test: `useReferenceEditor.test.tsx`, `ReferenceKeys.test.tsx`, `ReferenceLanes.test.tsx`, `ReferenceStatus.test.tsx`

**Interfaces:**
- Consumes: `decideKey`, `clampEnd`, `moveEdge`, `coverage`, `buildKeymap` (Task 6); hooks (Task 7); `isTypingTarget` from `features/qc/eventKeys.ts`; `useVideoClock`.
- Produces `useReferenceEditor({ videoRef, reference: ReferenceRead | undefined, durationMs }): { intervals: RefInterval[]; growing: Record<number, RefInterval | undefined>; selectedId: number | null; select(id: number | null): void; pressClass(categoryId: number, labelId: number): void; closeAll(): void; deleteSelected(): void; dragEdge(id: number, edge: "start" | "end", ms: number): void; saveState: "idle" | "saving" | "error" }`. It registers a window `keydown` for digit keys (via the keymap), `Escape` and `Delete`, ignoring typing targets, held-key repeats and modified keys; a growing interval is created on the server at start (end = start + `MIN_INTERVAL_MS`), its end follows the playhead (`timeupdate` and a clock), is saved at most once per second and once more on close, on `Escape` and on `pagehide`; dragging an edge seeks the video to that position.
- Produces `ReferenceKeys({ axes, onPress })` (the legend: grouped by axis, each chip `key name`, clickable, keyless chips marked); `ReferenceLanes({ videoRef, axes, intervals, growing, selectedId, durationMs, onSelect, onDragEdge, orphanedCount })` (one lane per axis with segments, gaps shown as hatching, handles on the selected interval, a playhead, coverage text "NN% labeled"); `ReferenceStatus({ status, compromisedAt, onRestore })` (badge `none` | `clean` | `compromised`, restore button with a confirm for `compromised`).

- [ ] **Step 1: Write failing tests**: pressing a mapped digit starts an interval and saves a created interval with `end = start + 100`; pressing it again closes at the current time and saves the end; another digit on the same axis closes and starts; a digit of the other axis does not touch the first; digits while an `<input>` is focused do nothing; `Escape` closes all; `Delete` removes the selected; the growing end never passes the next interval's start; a failed save sets `saveState` to `error` and rolls back; the throttle (fake timers) sends at most one PATCH per second while time advances; `pagehide` flushes the last end; lanes render gaps and the coverage text; dragging a handle calls `onDragEdge` with a time in ms; legend chips call `onPress`; the status badge shows the three states and confirms before restoring.
- [ ] **Step 2: Run** `npx vitest run src/features/reference`. Expected: FAIL.
- [ ] **Step 3: Implement** the hook and components (Tailwind, dark classes; lane colours via the existing `colorForClass`).
- [ ] **Step 4: Run** the same command and `npx tsc --noEmit`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(reference): editable reference lanes, legend and status`.

### Task 9: Reference page, route and entry points

**Files:**
- Create: `frontend/src/features/reference/ReferencePage.tsx`
- Modify: `frontend/src/app/App.tsx`, `frontend/src/features/qc/QcPage.tsx`, `frontend/src/features/qc/RunsTable.tsx`
- Test: `ReferencePage.test.tsx`, extend `RunsTable.test.tsx`

**Interfaces:**
- Consumes: Task 7 and 8 modules, `useVideo`, `TranscodePrompt`.
- Produces: route `/qc/reference/:videoId` rendering `ReferencePage` (title with the video name, player with `stream_url`, `ReferenceKeys`, `ReferenceLanes`, `ReferenceStatus`, an orphaned-intervals warning, a plain message when `axes` is empty: "This video has no procedure or its procedure has no frame-classification labels"); a "Label reference" link on the QC page next to the video picker (visible when a video is chosen) and a link per row in the run history to `/qc/reference/{video_id}`.

- [ ] **Step 1: Write failing tests**: the page renders legend, lanes and status for a video with axes; an empty-axes video shows the message; a non-playable video shows the transcode prompt; the QC page shows the link only with a video chosen; the history row links to the right video.
- [ ] **Step 2: Run** `npx vitest run src/features/reference src/features/qc`. Expected: FAIL.
- [ ] **Step 3: Implement** the page, the route (place it so `/qc/reference/:videoId` is not captured by `/qc/:runId`) and the links.
- [ ] **Step 4: Run** the same command and `npx tsc --noEmit`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(reference): reference labeling page and entry points`.

### Task 10: Reference on the classification run page

**Files:**
- Modify: `frontend/src/features/qc/classification/AxisLanes.tsx`, `frontend/src/features/qc/classification/ClassificationRunPage.tsx`
- Test: extend `AxisLanes.test.tsx`, `ClassificationRunPage.test.tsx`

**Interfaces:**
- Consumes: `matchAxes`, `useReferenceEditor`, `ReferenceKeys`, `ReferenceLanes`, `ReferenceStatus`, `useReference`.
- Produces: on the run page, for each model axis matched to a reference axis, an editable reference lane sits above the model lane (the existing optional `reference` prop of `AxisLanes` becomes `{ axisIndex: number | null; node: ReactNode }[]`-style slot or equivalent, decided by the implementer so lanes stay memoised); the legend and keyboard editing are active on this page; a model axis with no matching reference axis shows none; a banner above the video when the reference is `compromised` ("This video's reference is no longer an unbiased test: frames of it were used for training"); `[` and `]` keep stepping blips.

- [ ] **Step 1: Write failing tests**: with a reference whose Anatomy classes match the model's class names, a reference lane renders above that model lane; a model axis without a match renders none; a digit key edits the reference through the same hooks; `]` still steps blips; the compromised banner appears for a compromised reference and not for a clean one; a video with no reference shows the lanes without reference and a "Label reference" link.
- [ ] **Step 2: Run** `npx vitest run src/features/qc`. Expected: FAIL.
- [ ] **Step 3: Implement** the integration without recomputing segments or blips on playhead ticks.
- [ ] **Step 4: Run** the same command and `npx tsc --noEmit`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(reference): reference lanes on the classification run page`.

### Task 11: Warnings on Dataset and Train

**Files:**
- Modify: `frontend/src/features/datasets/BalancePanel.tsx`, `frontend/src/features/training/TrainConfigForm.tsx`
- Test: extend `BalancePanel.test.tsx`, `TrainConfigForm.test.tsx`

**Interfaces:**
- Consumes: `report.reference_exposure` (balance response, regenerated types) and `useReferenceExposure(dataset.id)` (Task 7).
- Produces: in the balance panel a warning block (`data-testid="reference-exposure-warning"`, same styling as the QC-origin one) listing the videos: "These clean reference videos will become compromised if you train a classifier on this selection: <titles>"; in the Train config form the same text (`data-testid="reference-exposure-warning"`) under the dataset summary when the exposure list is non-empty and the dataset's task type is classification. Neither blocks any action.

- [ ] **Step 1: Write failing tests**: the balance panel shows the list for a non-empty `reference_exposure` and nothing for an empty or missing field; the train form shows it for a classification dataset with exposure and not for an empty list; the Run button stays enabled.
- [ ] **Step 2: Run** `npx vitest run src/features/datasets src/features/training`. Expected: FAIL.
- [ ] **Step 3: Implement** the two blocks.
- [ ] **Step 4: Run** the same command and `npx tsc --noEmit`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(reference): warn about compromising reference videos`.

### Task 12: Live check and docs

**Files:**
- Modify: `ROADMAP.md`, `CHANGELOG.md`, `docs/specs/2026-11-03-qc-reference-labeling-design.md` (status line)

- [ ] **Step 1: Ask before touching the stack.** The backend (`uvicorn --reload`) picks up the new code; the migration must be applied to the dev DB (`cd backend && uv run alembic upgrade head`), which is additive. Ask the user before restarting any container or dev server.
- [ ] **Step 2: Real browser check** on a short real video with a procedure: label with keys (start, grow while playing, switch class, close), drag an edge, create a gap, relabel, delete; reload and see it persisted; open a classification run on that video and see the reference above the model lane; check the keys do nothing while a field is focused; note any failure honestly.
- [ ] **Step 3: Compromise check** on a scratch classification dataset made only from that video: confirm the Dataset balance warning and the Train form warning, then create a training run only if the user agrees (it uses the GPU); otherwise exercise the hook through the API test and say so.
- [ ] **Step 4: Sweep.** Delete every interval, `video_references` row, dataset, run and object created for the check (back up to the scratchpad first; delete by precise predicate).
- [ ] **Step 5: Docs.** ROADMAP entry (what was built, deviations, what was and was not verified live), CHANGELOG entry, spec status line.
- [ ] **Step 6: Commit** `docs: QC reference labeling status, changelog and roadmap`.
