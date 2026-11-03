# QC working area Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** QC inference runs crop each frame to a per-run working area before the model, map detections back to full-frame coordinates, and show the full video with the area's outline.

**Architecture:** `InferenceRun.crop_box` (percent insets, the existing `CropBox` shape) travels in the job payload to the ml-worker, which crops after `capture.retrieve()` and remaps boxes/polygons to full-frame normalised coordinates before writing predictions. A backend endpoint proposes a crop from temporal pixel variance; the run form lets the user accept or edit it. Flagged frames committed from a run are cut with the same crop.

**Tech Stack:** FastAPI, SQLAlchemy + Alembic, OpenCV, Celery (ml-worker), React/Vite, openapi-typescript.

**Spec:** [docs/specs/2026-11-03-qc-working-area-design.md](../specs/2026-11-03-qc-working-area-design.md)

## Global Constraints

- English only in code, comments, UI copy; dark theme only (no light-background classes).
- Backend tests must use `import app.db as db_module` and `db_module.SessionLocal()`, never `from app.db import SessionLocal`; never leave rows in the real `endoscopy` DB.
- Media bytes only via `StorageService`; the only sanctioned temp file is `tempfile.NamedTemporaryFile` inside `media/service.py` OpenCV helpers.
- After any backend schema/route change: `cd backend && PYTHONPATH=. uv run python scripts/export_openapi.py`, check `git diff --stat openapi.json`. Never hand-edit `frontend/src/shared/api/generated/`; use `apiClient`.
- ml-worker tests run in the container (see memory "ml-worker test workflow": `docker cp` tests, `docker compose exec`); host `.venv` lacks torch/numpy.
- Crop arithmetic is the existing one: `int(size * pct / 100)` per side (`backend/app/media/service.py:_apply_crop`).
- Work directly on `master`, no branches or worktrees; commit per task; do not push.
- Old runs (no `crop_box`) must behave exactly as before.

## Review Focus

- All-zero crop (`{"left":0,...}`) must behave identically to `None`: same frames, no remap drift.
- Frame sizes where `int()` truncation matters (odd width/height, e.g. 101x75 with 7.5 %): remap must use the real pixel rectangle, not the nominal percentages.
- Polygon points and boxes touching the crop edge must land in [0, 1] and inside the outline after remap.
- Auto-detect on a video with no border or a fully static video must return no crop and not a tiny rectangle.
- Run documents written before this change (no `crop_box` key) must open in both run pages without outline and without errors.
- A/B compare of two runs with different crops must still diff correctly (both are full-frame coordinates).

---

### Task 1: Run-level crop in the backend model and API

**Files:**
- Modify: `backend/app/inference/models.py` (add column), `backend/app/inference/schemas.py`, `backend/app/inference/service.py` (`create_inference_run`, `create_classification_run`), `backend/app/inference/router.py` (`create_run`)
- Create: Alembic migration in `backend/alembic/versions/` (head after `fa9801ab5dbe`; confirm with `alembic heads`)
- Test: `backend/tests/test_inference_api.py`, `backend/tests/test_inference_classification_api.py`

**Interfaces:**
- Produces: `InferenceRun.crop_box: dict | None` (JSON); `InferenceRunCreate.crop: CropBox | None`; `InferenceRunRead.crop_box: dict | None`; job payload key `"crop_box": dict | None` for both run kinds. Services take `crop_box: dict | None = None` keyword.

- [ ] **Step 1: Write failing tests** in the two API test files:
  `test_create_run_stores_crop_and_puts_it_in_the_payload` (POST with `crop={"left":10,"right":5,"top":0,"bottom":2.5}` → 202, response `crop_box == that dict`, enqueued job payload `crop_box` equals it); same for a classification run; `test_create_run_without_crop_has_null_crop_box`; `test_create_run_rejects_a_crop_that_leaves_no_area` (`left=60,right=40` → 422).
- [ ] **Step 2: Run them, expect FAIL**: `cd backend && uv run pytest tests/test_inference_api.py tests/test_inference_classification_api.py -k crop -v`
- [ ] **Step 3: Implement.** Column `crop_box: Mapped[dict | None] = mapped_column(JSON, nullable=True)` on `InferenceRun`; migration adds `inference_runs.crop_box` JSON nullable (downgrade drops it). `InferenceRunCreate.crop: CropBox | None = None` (import from `app.media.schemas`); `InferenceRunRead.crop_box: dict | None = None`. Router passes `crop_box=body.crop.model_dump() if body.crop else None`; both services store it on the run and add `"crop_box"` to the payload.
- [ ] **Step 4: Run the two test files fully, expect PASS.** Then export openapi.
- [ ] **Step 5: Commit** `feat(qc): store a working-area crop on inference runs`

### Task 2: ml-worker crop and remap helpers

**Files:**
- Create: `ml-worker/app/crop.py`
- Test: `ml-worker/tests/test_crop.py`

**Interfaces:**
- Produces:
  - `crop_rect(width: int, height: int, crop_box: dict | None) -> tuple[int, int, int, int]`: `(x0, y0, x1, y1)` pixels, same truncation as `_apply_crop`; `None` gives `(0, 0, width, height)`.
  - `crop_frame(image: np.ndarray, crop_box: dict | None) -> np.ndarray` (view slice by `crop_rect`).
  - `remap_point(x: float, y: float, rect: tuple[int,int,int,int], width: int, height: int) -> tuple[float, float]` crop-normalised to full-frame normalised.
  - `remap_bbox(bbox: list[float], rect, width, height) -> list[float]` for `[x, y, w, h]`.

- [ ] **Step 1: Write failing tests:** `crop_rect(101, 75, {"left":7.5,"right":7.5,"top":0,"bottom":0})` equals `(7, 0, 101 - 7, 75)`; zero crop and `None` give the full rect; `crop_frame` on a 48x64 array with `left=10,top=25` has shape `(36, 58, 3)`; round trip: draw a white rectangle at known pixels in a full frame, crop, find the rectangle's normalised box in the crop, `remap_bbox` returns the original normalised box within 1e-6; `remap_point(1.0, 1.0, ...)` equals `(x1/width, y1/height)`; `crop_rect` parity: same output as `app.media.service._apply_crop` shape for a table of sizes/crops (copy the backend arithmetic into the test as the reference, comment that it must match `backend/app/media/service.py`).
- [ ] **Step 2: Run in the container, expect FAIL** (module missing).
- [ ] **Step 3: Implement** the four functions in `ml-worker/app/crop.py`. Remap uses the real pixel rectangle: `x_full = (x0 + x * (x1 - x0)) / width`, `y` likewise; bbox width/height scale by `(x1-x0)/width`, `(y1-y0)/height`.
- [ ] **Step 4: Run, expect PASS.**
- [ ] **Step 5: Commit** `feat(ml-worker): crop and remap helpers for the QC working area`

### Task 3: Apply the crop in both adapters and write it to predictions

**Files:**
- Modify: `ml-worker/app/inference_adapter.py` (`InferenceRequest.crop_box`), `ml-worker/app/ultralytics_inference_adapter.py`, `ml-worker/app/classification_adapter.py` (`ClassificationRequest.crop_box`), `ml-worker/app/tasks.py` (`_run_detection`, `_run_classification`)
- Test: `ml-worker/tests/test_ultralytics_inference_adapter.py`, `ml-worker/tests/test_classification_adapter.py`, `ml-worker/tests/test_tasks_inference.py`

**Interfaces:**
- Consumes: Task 2 helpers; payload key `crop_box` from Task 1.
- Produces: `InferenceRequest.crop_box: dict | None = None`, `ClassificationRequest.crop_box: dict | None = None`; predictions document optional top-level key `"crop_box"`.

- [ ] **Step 1: Write failing tests.** Detection adapter with the existing fake model: write a 64x48 video, request `crop_box={"left":25,"right":0,"top":0,"bottom":0}`; assert the image passed to the fake model has width 48 (not 64); the fake returns a box normalised `[0,0,1,1]` and a polygon touching `(1,1)`; assert stored bbox equals `[0.25, 0, 0.75, 1]` and the polygon corner equals `[1.0, 1.0]`. Test with `crop_box=None` and with all-zero insets: output identical to current behaviour. Classification adapter: the image seen by the fake model is cropped; perturbation is applied after crop (spy order). Task test: payload with `crop_box` produces `document["crop_box"]`; payload without it has no such key.
- [ ] **Step 2: Run in the container, expect FAIL.**
- [ ] **Step 3: Implement.** In both adapters, right after `capture.retrieve()` succeeds, record `full_h, full_w = image.shape[:2]`, compute `rect = crop_rect(full_w, full_h, request.crop_box)`, `image = crop_frame(image, request.crop_box)`, then perturbation, then the model. In the detection adapter, after `_detections_from`, remap each detection's `bbox` and `polygon` points when `request.crop_box` is set (skip entirely when `None`). `tasks.py` passes `job.payload.get("crop_box")` and adds `document["crop_box"]` only when it is not `None`.
- [ ] **Step 4: Run the three test files fully, expect PASS.**
- [ ] **Step 5: Commit** `feat(ml-worker): run QC inference on the run's working area`

### Task 4: Cut committed flagged frames with the run's crop

**Files:**
- Modify: `backend/app/media/service.py` (`extract_frames_at`), `backend/app/inference/service.py` (`store_frames_as_sequence`, `commit_flags`), `backend/app/reference/commit.py:242` (caller)
- Test: `backend/tests/test_extract_frames_at.py`, `backend/tests/test_inference_flags*.py` (the existing commit tests; locate with `grep -l commit_flags backend/tests`)

**Interfaces:**
- Produces: `extract_frames_at(video_bytes, frame_indices, crop: CropBox | None = None)`; `store_frames_as_sequence(..., crop: CropBox | None = None)` which also stores `sequence.crop_box = crop.model_dump()` when given.

- [ ] **Step 1: Write failing tests:** `extract_frames_at` on the existing 64x48 `make_video` with `CropBox(left=25)` returns frames of width 48 and unchanged content; no crop leaves sizes as today. Commit test: a run with `crop_box={"left":25,...}` committed via the endpoint yields a Sequence whose `crop_box` equals it and Frames with width 48. A run without crop is unchanged.
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement.** Apply `_apply_crop(frame, crop)` in `extract_frames_at` before encoding. `commit_flags` builds `CropBox(**run.crop_box)` when set and passes it. Inspect `reference/commit.py:242`: if the caller has a run, pass its crop the same way; if it has none, leave `crop=None` and say so in the commit message.
- [ ] **Step 4: Run the affected backend tests, expect PASS.**
- [ ] **Step 5: Commit** `feat(qc): cut committed flagged frames with the run's working area`

### Task 5: Crop detection endpoint

**Files:**
- Modify: `backend/app/media/service.py` (add `detect_crop`), `backend/app/inference/router.py` (new route), `backend/app/inference/schemas.py` (`DetectedCropRead`)
- Test: `backend/tests/test_media_service.py` (function), `backend/tests/test_inference_api.py` (route)

**Interfaces:**
- Produces: `detect_crop(video_bytes: bytes, samples: int = 50, margin_pct: float = 1.0) -> CropBox | None`; route `POST /inference/videos/{video_id}/detect-crop` → `DetectedCropRead {crop: CropBox | None}` (404 for unknown video).

- [ ] **Step 1: Write failing tests** with synthetic videos (MJPG, like `make_video`): static black border (left 20 %, right 10 %) around a region of per-frame random noise → `detect_crop` returns insets within 2 points of 20/10/0/0 (margin makes them slightly smaller, never larger than the true border); a video with static bright text painted in the border area gives the same insets; a video with noise across the whole frame → `None`; a fully static video → `None`; a 3-frame video → `None`. Route test: 200 with `crop` for the bordered video, 404 for an unknown video id.
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement** `detect_crop` in `media/service.py` using the temp-file pattern of `extract_frames`: sample `samples` frames evenly over the whole video, grayscale, per-pixel std over time, threshold at a fraction of the maximum (named module constant), keep the largest connected component, bounding box → percent insets, shrink insets by `margin_pct` toward looser (never tighter), return `None` when fewer than 5 frames were read, the active region covers under 5 % of the frame, or the insets are all below 1 %. Route downloads the video via `StorageService` and returns the result.
- [ ] **Step 4: Run, expect PASS; export openapi.**
- [ ] **Step 5: Commit** `feat(qc): propose a working area from temporal pixel variance`

### Task 6: Frontend run form with the crop picker

**Files:**
- Create: `frontend/src/features/qc/CropPicker.tsx`, `frontend/src/features/qc/CropPicker.test.tsx`
- Modify: `frontend/src/features/qc/RunForm.tsx` (+ `RunForm.test.tsx`), `frontend/src/features/qc/QcPage.tsx` (+ `QcPage.test.tsx`), `frontend/src/entities/useInferenceRuns.ts` (body type accepts `crop`)
- Create: `frontend/src/entities/useDetectCrop.ts`

**Interfaces:**
- Consumes: `CropFields`, `ZERO_CROP`, `Crop` (`features/media/CropFields`), `CropOverlay`, `computeVideoMediaRect`, `useVideo`; generated `POST /inference/videos/{video_id}/detect-crop`.
- Produces: `CropPicker({ videoId: number; crop: Crop; onChange: (crop: Crop) => void })`; `RunFormValues` gains `crop: Crop | null` (null when all insets are zero); `useDetectCrop()` mutation returning `{crop: Crop | null}`.

- [ ] **Step 1: Write failing tests.** `CropPicker`: renders the four fields and an overlay when a crop is non-zero; "Detect automatically" calls the endpoint and calls `onChange` with the returned crop; when it returns `crop: null` it shows "No border found" and leaves the value unchanged. `RunForm`: submitting with edited crop passes `crop` in values; untouched submits `crop: null`. `QcPage`: the POST body includes `crop` only when non-null.
- [ ] **Step 2: Run, expect FAIL**: `cd frontend && npx vitest run src/features/qc/CropPicker.test.tsx src/features/qc/RunForm.test.tsx src/features/qc/QcPage.test.tsx`
- [ ] **Step 3: Implement.** `CropPicker` shows a small `<video>` preview of the selected video (`stream_url`) with `CropOverlay`, `CropFields`, and the detect button; its initial value comes from the most recent sequence `crop_box` of that video as in `SequenceForm.mostRecentCrop` (reuse, do not copy, if it can be exported; otherwise extract it to a shared helper). Mount it in `RunForm` under the video select, only when a video is chosen. Map `crop` to the request body field `crop`.
- [ ] **Step 4: Run the three test files, expect PASS; `npx tsc --noEmit` clean for touched files.**
- [ ] **Step 5: Commit** `feat(qc): choose the working area when starting a run`

### Task 7: Outline the working area in the run viewers

**Files:**
- Modify: `frontend/src/features/qc/RunViewPage.tsx` (around the `<video>` at line ~273), `frontend/src/features/qc/classification/ClassificationRunPage.tsx`, `frontend/src/features/qc/AbComparePage.tsx` (each pane)
- Test: matching `*.test.tsx` files (`QcPage.test.tsx`, `ClassificationRunPage.test.tsx`, AB page test)

**Interfaces:**
- Consumes: `InferenceRun.crop_box`, `CropOverlay`, `computeVideoMediaRect`.

- [ ] **Step 1: Write failing tests:** with a run whose `crop_box` is `{left:10,right:10,top:5,bottom:5}` the viewer renders `crop-overlay-root` and `crop-overlay-border`; with `crop_box: null` (and with the field absent) no overlay is rendered and nothing throws.
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement.** Render `CropOverlay` next to `PredictionOverlay` when `run.crop_box` is non-null, passing a `mediaRect` computed from the video element on `loadedmetadata` and resize, as `VideoReviewPlayer` does. Do not change how detections are drawn.
- [ ] **Step 4: Run the touched test files, expect PASS.**
- [ ] **Step 5: Commit** `feat(qc): draw the run's working area over the full video`

### Task 8: Real-stack verification and docs

**Files:**
- Modify: `ROADMAP.md`, `CHANGELOG.md` only if the repo keeps unreleased entries there

- [ ] **Step 1:** Start the stack as in CLAUDE.md (ask before touching dev ports/servers, per memory). Take a real video with a border and overlay, upload it in QC, run `detect-crop`, confirm the proposal visually in the picker, adjust, start a classification run and a detection/segmentation run.
- [ ] **Step 2:** Verify in the browser: outline appears on the full video; boxes/masks sit on the lesion, not shifted; the same model on the same video with and without the area gives different results, and the cropped result matches what the model gives on a hand-cropped frame of the same video.
- [ ] **Step 3:** Commit a flagged frame from a cropped run and check that the created sequence's frames are cropped and `crop_box` is set.
- [ ] **Step 4:** Clean up any test rows and MinIO prefixes created in the real DB. Add a ROADMAP entry (what shipped, deviations from the spec, notably the pixel-exact remap instead of nominal percentages, and that sub-project B is next).
- [ ] **Step 5: Commit** `docs: record the QC working area in the roadmap`
