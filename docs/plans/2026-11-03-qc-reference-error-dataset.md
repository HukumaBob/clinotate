# QC Error Dataset Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** From a classification run's evaluation the user ticks error episodes (with quick filters), previews, and sends them to training as one new `Sequence` of the QC video whose frames carry classification annotations taken from the reference.

**Architecture:** Pure sampling and labeling functions in `backend/app/reference/commit.py`; the evaluation loader in `service.py` is split so the evaluation and the commit share one context; `commit_flags`' frame cutting/upload/cleanup is extracted into a helper both commits use; one route `POST /reference/runs/{run_id}/commit-episodes` (with `dry_run`). The frontend gets a mutation hook, pure selection helpers, checkboxes and filters in `EvaluationPanel`, and an `EpisodeCommitDialog`.

**Tech Stack:** FastAPI + SQLAlchemy (no new tables, no migration), OpenCV frame cutting via `extract_frames_at`, React + Vite + TanStack Query + openapi-typescript, Vitest.

**Spec:** [docs/specs/2026-11-03-qc-reference-error-dataset-design.md](../specs/2026-11-03-qc-reference-error-dataset-design.md). Depends on the QC classification, reference labeling and reference evaluation plans (all done).

## Global Constraints

- English only in code, comments, docstrings and UI copy (CLAUDE.md). Dark theme only.
- Work directly on `master`; no branches or worktrees. End commit messages with `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`.
- Tests never write to the real `endoscopy` DB or MinIO beyond the repo's isolated fixtures; never `from app.db import SessionLocal`; clean up what you create. No migration in this plan: do not run alembic against the dev DB.
- `apiClient` only; do not hand-edit `frontend/src/shared/api/generated/`. After backend schema/route changes: `cd backend && PYTHONPATH=. uv run python scripts/export_openapi.py` and check `git diff --stat openapi.json`.
- Frontend type check is `cd frontend && npx tsc --noEmit -p tsconfig.app.json 2>&1 | grep <folders you touched>` (plain `npx tsc --noEmit` checks nothing here; many pre-existing errors, notably jest-dom matcher typings; add none of your own in non-test files).
- Check `df -h /mnt/work-disk` before large writes; if the disk is full stop and report, never delete anything. Do not touch dev servers/ports without asking.
- All binary media through `StorageService`; the only sanctioned temp-file use is inside `extract_frames_at`.
- Every label reference carries the `taxonomy_version` the label has at the moment of the commit (copied, CLAUDE.md).
- Request: `POST /reference/runs/{run_id}/commit-episodes` body `{ "episodes": [{"axis": str, "start_ms": int}], "step_ms": int = 1000 (100..60000), "margin_ms": int = 1000 (0..60000), "name": str | null (max 255), "dry_run": bool = false }`; response `{dry_run, episodes, frames, dropped_unlabeled, annotations_by_axis: {axis name: count}, sequence_id | null, sequence_name | null}`; `201` real, `200` dry run. 404 unknown run; 409 `RunNotEvaluable` reasons (not a finished classification run, no reference, predictions gone) and the video unreadable / frames past the end (as `commit_flags`); 422 for an empty selection, an unknown or stale `(axis, start_ms)`, bounds, no frame left after dropping unlabeled ones, more than 2000 frames (the count in the message).
- Episode identity: `(axis name, start_ms)` as the evaluation returns them; the server recomputes the evaluation itself (any tolerance: membership does not depend on it) and never trusts frame lists from the client.
- Sampling: for each selected episode, instants `t = start_ms - margin_ms + k*step_ms` for `k = 0, 1, ...` while `t <= end_ms + margin_ms`; for each instant the nearest processed frame of the run (by timestamp, ties to the lower timestamp) within `step_ms / 2` (inclusive), otherwise no frame; instants before 0 are skipped; frames deduplicated across episodes and sorted by timestamp.
- Keeping: a sampled frame is kept only when at least one reference axis has a non-orphaned interval containing its timestamp (`start_ms <= ts < end_ms`); the others are `dropped_unlabeled`.
- Labels: one `CLASSIFICATION` annotation (`payload={}`) per reference axis with an interval covering the frame (all axes of the video's reference); `created_by_id` the user.
- Result: one new `Sequence` of the video (`origin_qc_run_id` = the run, name default `QC errors · <video title> · run #<id> · <date>`, `start_time` = first kept timestamp // 1000, `duration` = max(1, ceil(last kept timestamp / 1000) - start_time)), one `Frame` per kept frame (cut in one sequential pass), annotations attached; all or nothing; uploaded objects removed when the database write fails.
- A `dry_run` writes nothing and uploads nothing.

## Review Focus

- A failure after frames were uploaded (a database error while writing rows) leaves no `Sequence`, no rows and no uploaded objects.
- Two selected overlapping episodes collapse to one frame per instant (no duplicate frame); margins are clipped at 0 and at the video end.
- A frame covered by two reference axes gets two annotations; a frame covered by none is dropped and counted, never sent unlabeled.
- A stale or unknown key is a 422 (not a 500 and not silently ignored); an empty selection is a 422.
- The cap (2000) is enforced before any frame is cut.
- `commit_flags` behaves exactly as before after the shared helper is extracted.
- The panel's selection survives a tolerance change, is cleared when the run changes, and the quick filters set (not hide) the selection.

---

## File Structure

Backend
- `backend/app/reference/commit.py` (new): sampling, labeling, `commit_episodes`.
- `backend/app/reference/service.py`: split `evaluate_run` into a context loader (`load_run_eval_context`) plus the scoring; no behaviour change.
- `backend/app/inference/service.py`: extract the shared frame-storing helper from `commit_flags`.
- `backend/app/reference/schemas.py`, `router.py`: request/response models and the route.
- Tests: `backend/tests/test_reference_commit_sampling.py`, `test_reference_commit_api.py`, extend the existing flags-commit tests only if the helper changes their fixtures.

Frontend
- `frontend/src/entities/useCommitEpisodes.ts`.
- `frontend/src/features/qc/classification/episodeSelection.ts` (pure), `EpisodeCommitDialog.tsx`, changes in `EvaluationPanel.tsx`; tests next to each.

Docs: `ROADMAP.md`, `CHANGELOG.md`.

## Worked scenario (the numbers the sampling tests must reproduce)

Processed frames every 500 ms from 0 to 10000 (`frame_index = ts / 500`, so indices 0..20). Selected episodes of axis "Anatomy": A = `[2000, 3000]` and B = `[3500, 4000]` (start_ms 2000 and 3500). `step_ms = 1000`, `margin_ms = 1000`. Instants: A gives 1000, 2000, 3000, 4000; B gives 2500, 3500, 4500. Union of frames by timestamp: 1000, 2000, 2500, 3000, 3500, 4000, 4500 (frame indices 2, 4, 5, 6, 7, 8, 9). Reference: Anatomy interval `[0, 4200)` caecum, Quality interval `[2200, 3800)` good_quality. Kept frames: ts 1000, 2000, 2500, 3000, 3500, 4000 (6; ts 4500 is outside every interval: `dropped_unlabeled = 1`). Annotations: Anatomy 6 (all kept frames), Quality 3 (ts 2500, 3000, 3500); `annotations_by_axis = {"Anatomy": 6, "Quality": 3}`; sequence `start_time = 1` (1000 // 1000), `duration = 3` (ceil(4000/1000) - 1). Tolerance case: processed frames every 700 ms (ts 0, 700, 1400, 2100, 2800, 3500, ...) with `step_ms = 1000`: instant 1000 takes ts 700 (diff 300), 2000 takes 2100 (diff 100), 3000 takes 2800 (diff 200); with only processed frames at ts 0 and 5000, an instant of 2000 finds none within 500 and is skipped; a tie (instant exactly between two frames) takes the lower timestamp.

---

### Task 1: Sampling and labeling (pure)

**Files:**
- Create: `backend/app/reference/commit.py`
- Test: `backend/tests/test_reference_commit_sampling.py`

**Interfaces:**
- Produces dataclasses `ProcessedFrame(frame_index: int, ts_ms: int)`, `EpisodeSpan(axis: str, start_ms: int, end_ms: int)`, `RefInterval(category_id: int, label_id: int, start_ms: int, end_ms: int)`; functions `sample_frames(episodes: list[EpisodeSpan], processed: list[ProcessedFrame], step_ms: int, margin_ms: int) -> list[ProcessedFrame]` (deduplicated, ascending by `ts_ms`; the nearest-frame rule, tie to the lower timestamp, tolerance `step_ms / 2` inclusive, instants below 0 skipped; `processed` need not be sorted) and `labels_at(ts_ms: int, intervals: list[RefInterval]) -> list[tuple[int, int]]` (`(category_id, label_id)` for every interval containing `ts_ms`, start inclusive and end exclusive, ordered by category id).

- [ ] **Step 1: Write the failing tests** with the worked scenario (the union of frame indices `[2,4,5,6,7,8,9]`), the 700 ms tolerance cases, the skipped instant with no frame within half a step, the tie rule, margins clipped at 0, an empty episode list and an empty processed list (`[]`), overlapping episodes collapsing to one frame each, unsorted `processed`; `labels_at` at an interval start (included) and end (excluded), a frame in two axes (two pairs), none (`[]`).
- [ ] **Step 2: Run** `cd backend && uv run pytest tests/test_reference_commit_sampling.py -v` (test files must `import app.main`, see the earlier evaluation tests). Expected: FAIL.
- [ ] **Step 3: Implement** with `bisect` over the sorted timestamps (O(instants log frames)).
- [ ] **Step 4: Run** the file. Expected: PASS.
- [ ] **Step 5: Commit** `feat(reference): sample frames around error episodes`.

### Task 2: Share the evaluation context and the frame-storing code

**Files:**
- Modify: `backend/app/reference/service.py`, `backend/app/inference/service.py`
- Test: existing `tests/test_reference_evaluation_api.py`, `tests/test_qc_flags_api.py` (must keep passing), plus new focused tests for the extracted helpers in `backend/tests/test_reference_commit_helpers.py`

**Interfaces:**
- Produces in `service.py`: `RunEvalContext` (a dataclass holding what `evaluate_run` loads: the run, the video, the reference (`ReferenceRead`), the parsed predictions document, per model axis the matched reference axis index or None, the `EvalFrame` list with their frame indices, the non-orphaned `RefInterval` list of the matched axis) and `load_run_eval_context(session, storage, run_id) -> RunEvalContext` raising the same errors as today (`InferenceRunNotFound`, `RunNotEvaluable`, `VideoNotFound`); `evaluate_run` is rebuilt on it with identical output and error behaviour.
- Produces in `inference/service.py` a helper both commits use, e.g. `store_frames_as_sequence(session, storage, *, video, name, start_time, duration, origin_qc_run_id, frame_numbers: list[int], on_frame)` that cuts the frames in one pass (`extract_frames_at`, the same checks and exceptions as today), creates the `Sequence`, uploads `frames/{sequence.id}/{position}.png`, creates the `Frame` rows in order, calls `on_frame(position, frame)` so the caller can add flags/annotations before the commit, commits, and on any failure rolls back and deletes the uploaded objects (best effort). `commit_flags` becomes a thin caller with unchanged behaviour (frame no-findings marks for FP flags and the flag bookkeeping stay in its `on_frame`/post step). The exact signature is the implementer's, documented in the docstring.

- [ ] **Step 1: Write the failing tests** for the helper itself with fake storage and a tiny real video (follow `test_qc_flags_api.py`): rows and objects created in order, `on_frame` called per frame with its position, a failure inside `on_frame` or on commit removes every uploaded object and leaves no `Sequence`/`Frame` rows; the context loader raises the documented errors (unknown run, detection run, no reference, missing predictions) and returns the matched axis and frames for a classification run (the worked scenario fixture of the evaluation API tests).
- [ ] **Step 2: Run** the new file. Expected: FAIL.
- [ ] **Step 3: Refactor** `evaluate_run` and `commit_flags` onto the new pieces; no behaviour change.
- [ ] **Step 4: Run** `uv run pytest tests/test_reference_commit_helpers.py tests/test_reference_evaluation_api.py tests/test_reference_evaluation_core.py tests/test_reference_evaluation_episodes.py tests/test_qc_flags_api.py tests/test_inference_api.py tests/test_inference_classification_api.py -q`. Expected: PASS apart from the known unrelated failures (`tests/test_inference_api.py::test_deleting_a_video_that_has_qc_runs_is_refused`, `tests/test_jobs.py::test_enqueue_sam3_predict_creates_pending_job`).
- [ ] **Step 5: Commit** `refactor(qc): share the evaluation context and the frame-storing helper`.

### Task 3: The commit service and the endpoint

**Files:**
- Modify: `backend/app/reference/commit.py`, `backend/app/reference/schemas.py`, `backend/app/reference/router.py`
- Test: `backend/tests/test_reference_commit_api.py`

**Interfaces:**
- Consumes: `sample_frames`, `labels_at`, `ProcessedFrame`, `EpisodeSpan`, `RefInterval` (Task 1); `load_run_eval_context`, the store helper (Task 2); `evaluate_axis` (existing) to recompute the episodes.
- Produces schemas `EpisodeKey(axis: str, start_ms: int)`, `CommitEpisodesRequest` (bounds as in the Global Constraints, `episodes` min length 1), `CommitEpisodesRead` (fields as in the Global Constraints); service `commit_episodes(session, storage, run_id, request, user) -> CommitEpisodesRead`; exceptions mapped in the router: unknown/stale key and the other bounds as 422 (`InvalidSelection(message)`), `RunNotEvaluable` 409, unknown run 404, `VideoUnreadable`/`FramesPastEnd` as the flags commit maps them (409).
- Behaviour: load the context; for every selected key find the episode among the evaluation's episodes of that model axis (name match; matched axes only), else 422; sample over the run's processed frames; keep only frames covered by at least one reference axis; enforce the 2000-frame cap before cutting; `dry_run` returns the counts and writes/uploads nothing; otherwise create the sequence through the shared helper with one `Annotation` per covering axis (`taxonomy_version` copied from the label at this moment, loaded in one query), annotations created in the same transaction (not via `create_classification_annotation`, which commits per call).

- [ ] **Step 1: Write the failing tests** (TestClient, isolated rows, fake storage, a tiny real video as the flags-commit tests): the worked scenario end to end through the API (frames 6, `dropped_unlabeled` 1, `annotations_by_axis {"Anatomy": 6, "Quality": 3}`, sequence `start_time 1`, `duration 3`, `origin_qc_run_id` the run, the label of each annotation, `taxonomy_version` equal to the label's, frames in time order); `dry_run` returns identical counts and creates no sequence, frames, annotations or uploaded objects; two overlapping episodes give no duplicate frame; an unknown axis name and a stale `start_ms` give 422; an empty list 422; `step_ms=99` and `margin_ms=60001` 422; the cap (build a selection that yields more than 2000 frames) 422 before any cut; a selection whose frames are all unlabeled 422; run states 404 and 409 (pending, detection, no reference intervals); a failure after upload (monkeypatch the Annotation insert to raise) leaves no `Sequence`, `Frame`, `Annotation` rows and no uploaded objects; the name defaults and a given name is used.
- [ ] **Step 2: Run** `uv run pytest tests/test_reference_commit_api.py -v`. Expected: FAIL.
- [ ] **Step 3: Implement** the service, schemas and route.
- [ ] **Step 4: Run** the new file plus the Task 2 command. Expected: PASS.
- [ ] **Step 5: Re-export OpenAPI**; confirm `git diff --stat openapi.json` changed.
- [ ] **Step 6: Commit** `feat(reference): send error episodes to training` (include `openapi.json`).

### Task 4: Frontend hook and selection helpers

**Files:**
- Create: `frontend/src/entities/useCommitEpisodes.ts`, `frontend/src/features/qc/classification/episodeSelection.ts`
- Test: `useCommitEpisodes.test.tsx`, `episodeSelection.test.ts`

**Interfaces:**
- Consumes: regenerated `schema.d.ts` (`npm run generate-api` after Task 3); the `Episode` type from `EvalEpisodeRead`.
- Produces: `useCommitEpisodes(runId: number | null)` returning a mutation whose variables are `{ episodes: { axis: string; start_ms: number }[]; stepMs: number; marginMs: number; name?: string | null; dryRun: boolean }` and result `CommitEpisodesRead` (`apiClient.POST("/reference/runs/{run_id}/commit-episodes", ...)`, `throw result.error`); a successful real commit invalidates `["sequences"]`-style list queries the app already uses (look at how `useCommitQcFlags` invalidates sequences and the "video-sent" figure and do the same; invalidate `["evaluation"]` is NOT needed). Pure helpers in `episodeSelection.ts`: `episodeKey(axis: string, episode: { start_ms: number }): string` (`"<axis>|<start_ms>"`), `filterSelection(axis: string, episodes: Episode[], filters: { interiorOnly: boolean; minFrames: number | null; minConfidence: number | null }): string[]` (the keys of the episodes passing every ENABLED filter: interior means `kind === "interior"`, `minFrames` is `frames >= n`, `minConfidence` is `mean_confidence >= x` with x in 0..1), `toRequestEpisodes(keys: string[]): { axis: string; start_ms: number }[]` (parses the keys; ignores malformed ones), `selectionSummary(keys, episodesByAxis): { episodes: number; frames: number }` (episode count and the sum of their evaluated `frames`).

- [ ] **Step 1: Write the failing tests**: each filter alone and combined (boundary equalities `frames == n`, `mean_confidence == x`), no filter enabled returns every key, an empty episode list; `episodeKey`/`toRequestEpisodes` round trip with an axis name containing `|`; `selectionSummary`; the hook sends the right body (snake_case, `dry_run`), throws the server error, and a real commit invalidates the sequence queries (spy).
- [ ] **Step 2: Run** `cd frontend && npx vitest run src/entities src/features/qc/classification/episodeSelection.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** the hook and helpers (the key must survive an axis name containing `|`: split on the LAST `|`).
- [ ] **Step 4: Run** the same command and the type check. Expected: PASS.
- [ ] **Step 5: Commit** `feat(reference): hook and selection helpers for sending episodes`.

### Task 5: Checkboxes, filters and footer in the panel

**Files:**
- Modify: `frontend/src/features/qc/classification/EvaluationPanel.tsx`
- Test: extend `EvaluationPanel.test.tsx`

**Interfaces:**
- Consumes: `episodeKey`, `filterSelection`, `selectionSummary` (Task 4).
- Produces: in the episode list a checkbox per row (clicking the row text still seeks; the checkbox only selects), "Select all" and "Select none" for the shown axis, quick-filter chips "Interior only" (toggle), "At least N frames" (number input) and "Mean confidence at least X%" (number input) with an "Apply" behaviour that REPLACES the selection with the matching keys of the shown axis (they do not hide rows); a footer "N episodes selected" with a button "Send to training…" (disabled at zero) that opens the dialog (Task 6; until then a prop `onSend?: (keys: string[]) => void` or an internal state stub is acceptable, the implementer decides and documents). The selection (a `Set<string>`) lives in the panel across axes, survives a tolerance change (keys do not depend on it), and is cleared when `runId` changes; with the Show-more cap, "Select all" selects every episode of the axis, not only the visible rows.

- [ ] **Step 1: Write the failing tests**: ticking and unticking rows updates the footer count; clicking a row's text still seeks and does not toggle the checkbox; select all/none; each quick filter replaces the selection (and the previous manual ticks are gone); selecting all with more than 200 episodes selects all of them; the selection survives a tolerance change and is cleared on a run change; the button is disabled at zero and enabled otherwise; the interior filter uses the panel's current tolerance data.
- [ ] **Step 2: Run** `npx vitest run src/features/qc/classification/EvaluationPanel.test.tsx`. Expected: FAIL.
- [ ] **Step 3: Implement** the UI (Tailwind dark classes; compact for the narrow sidebar).
- [ ] **Step 4: Run** the test and the type check. Expected: PASS.
- [ ] **Step 5: Commit** `feat(reference): tick episodes and filter the selection`.

### Task 6: The commit dialog and its wiring

**Files:**
- Create: `frontend/src/features/qc/classification/EpisodeCommitDialog.tsx`
- Modify: `EvaluationPanel.tsx` (open the dialog from the footer button)
- Test: `EpisodeCommitDialog.test.tsx`, extend `EvaluationPanel.test.tsx`

**Interfaces:**
- Consumes: `useCommitEpisodes`, `toRequestEpisodes` (Task 4); the existing "sent" figure hook (`useVideoSent` in `frontend/src/entities/useQcFlags.ts`); the look of `frontend/src/features/qc/CommitDialog.tsx`.
- Produces: `EpisodeCommitDialog({ runId, videoId, keys, referenceStatus, onClose })`: a name field (placeholder shows the default pattern), step and margin fields in seconds (defaults 1 and 1; 0.1..60 and 0..60), a live preview from the dry run (debounced about 400 ms after the last change of step, margin or selection; shows episodes, frames, frames dropped as unlabeled, labels per axis; a loading state and the server's error text), the reference note (`clean`: "Once a classifier is trained on these frames, this video's reference will stop being an independent test." `compromised`: "This video's reference is already compromised: frames of it were used for training."), the already-sent note when `useVideoSent` reports frames ("N frames of this video were already sent to training"), "Send" (disabled while the preview is loading, has an error, or shows zero frames) and "Cancel"; on success the dialog shows "Created sequence <name>" with an "Open sequence" link (to the existing sequence grid route `/sequences/{id}`) and a Close button, and the panel clears the selection. Errors never close the dialog.

- [ ] **Step 1: Write the failing tests** (mock `useCommitEpisodes` and `useVideoSent`): the preview request fires after the debounce with the right body (`dryRun: true`, seconds converted to ms) and refreshes when step/margin change; the preview numbers render; Send is disabled for zero frames, on error and while loading; Send posts the real commit with the name; success shows the sequence name and the link; both reference notes; the already-sent note; an error from the server shows in the dialog and keeps it open; cancel closes; the panel opens the dialog from the footer and clears the selection after a successful commit.
- [ ] **Step 2: Run** `npx vitest run src/features/qc/classification`. Expected: FAIL.
- [ ] **Step 3: Implement** the dialog and the wiring.
- [ ] **Step 4: Run** `npx vitest run src/features/qc src/features/reference src/entities` and the type check. Expected: PASS.
- [ ] **Step 5: Commit** `feat(reference): commit dialog for error episodes`.

### Task 7: Live check and docs

**Files:**
- Modify: `ROADMAP.md`, `CHANGELOG.md`, `docs/specs/2026-11-03-qc-reference-error-dataset-design.md` (status line)

- [ ] **Step 1: Prepare data.** No migration. The backend (`uvicorn --reload`) picks up the code; ask before touching any container or dev server. In the real browser label a short real video (`polyposis`, 28 s) with at least two axes' intervals, run the classification model on it.
- [ ] **Step 2: Walk the flow.** Open the run page, tick episodes by hand, use each quick filter, open the dialog, watch the preview change with step and margin, send. Open the new sequence in the frame grid and check that its frames show the reference labels as classification badges; compare the frame count and labels with a hand count from the preview and the reference intervals; check that frames in reference gaps are absent; check that the reference status is unchanged after the commit and that a repeat commit shows the "already sent" figure. Note every failure honestly.
- [ ] **Step 3: Sweep.** Delete the sequence (and its frames, annotations and MinIO objects through the app's own delete or by precise predicates after backing up to the scratchpad), the intervals, the `video_references` row and the run created for the check.
- [ ] **Step 4: Docs.** ROADMAP entry (what was built, deviations, what was and was not verified live, open items), CHANGELOG entry, spec status line.
- [ ] **Step 5: Commit** `docs: QC error dataset status, changelog and roadmap`.
