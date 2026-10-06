# QC screen, sub-project 1: inference runs

Date: 2026-10-06. Status: implemented; browser verification pending. Plan:
[docs/plans/2026-10-06-qc-inference-runs.md](../plans/2026-10-06-qc-inference-runs.md).

Source material: `yolo_qc_playground_architecture.pdf` (untracked, Russian) proposes a
"Review" module (Inference & QC Playground). This document designs its first
slice only. The UI/UX spec's `## Results` section is superseded by it.

## Decomposition of the QC module

The PDF covers five independent subsystems. Each gets its own spec, plan and
implementation cycle:

1. **Inference runs** (this document): pick a model and a video, run
   inference as a job, persist the result, view it with an overlay, keep a
   history.
2. **Inspection**: confidence/NMS sliders over stored predictions, timeline
   markers, flicker highlighting, latency figures.
3. **QC flagging to dataset**: FP/FN hotkeys, draft box editing, error queue,
   commit to a dataset with a source tag (closes the active-learning loop).
4. **A/B comparison and stress tests**: two models on one video, noise/blur/
   brightness at inference time.
5. **Interpretability**: Grad-CAM heatmaps, anomaly reels, auto-label export.

Order: 1, 2, 3. Sub-projects 4 and 5 are backlog with no commitment.

## Decisions

| Question | Decision |
|---|---|
| Relation to Results screen | QC replaces Results. One screen, one history. |
| Input video | Drop zone calls the existing `POST /media/videos`, so a QC video is an ordinary `Video`. An already-uploaded video can be picked instead. |
| What a run stores | Raw per-frame predictions as JSON in object storage. The overlay is drawn client-side on a canvas over the original video. No rendered video. |
| Frames processed | The whole video, with a `frame_stride` parameter (default 1). |
| Supported models | Detect and segment. Classify is a later iteration. |
| Execution | `InferenceRun` plus a `Job` executed by `ml-worker`, mirroring `TrainingRun`/`model_train`. |

Rejected: running inference inside the API process (the host has no torch or
GPU), and Triton/TorchServe with a WebSocket stream as in the PDF (a second
delivery path and a new service for a scenario the job mechanism already
covers).

Leakage risk: a QC video is a normal `Video` and could end up in a training
dataset. `grouping_key` (the unit of data independence) is the intended
guard. How QC videos are marked or excluded is **not** decided here and must
be settled in the implementation plan before sub-project 3 commits frames
back to datasets.

## Navigation and screen

`Results` becomes `QC`, route `/qc`:
`Tags -> Media -> Sequences -> Dataset -> Train -> QC`. (`Review` collides
with the Review player in Media; `Validate` collides with the val split.)
All UI copy is English.

### `/qc`: launch and history

- Run form: model select (detect/segment `ModelVersion`s, showing name and
  task type, not mAP50; classify models are not listed), video (a select of
  uploaded videos, or the existing `VideoUploadFlow` form (title, procedure,
  file input); drag-and-drop is not added in this sub-project), `Frame
  stride`, `Run`.
- Live status of the selected run: badge, progress bar, `frames done / total`.
- History table: video, model, stride, status, date, `View`, `Delete`
  (arm/confirm, as in Train).
- Empty states with guidance, e.g. "Train a detect or segment model first".

### `/qc/:runId`: run view

- Video player with a canvas overlay: boxes, and translucent polygons for
  masks, coloured by `class_id` from one fixed palette. Label is class plus
  confidence.
- Legend with per-class detection counts.
- The display threshold is fixed at 0.25 (the Ultralytics default). The
  slider is sub-project 2 and is deliberately absent.

## Backend

New module `backend/app/inference/` (`models.py`, `schemas.py`, `service.py`,
`router.py`), laid out like `training/`.

### `inference_runs` table

`id`, `video_id` (FK `videos`), `model_version_id` (FK `model_versions`,
nullable, `ON DELETE SET NULL`), `model_name` (copied from the model
version at creation), `job_id` (FK `jobs`), `frame_stride`,
`status` (pending, running, succeeded, failed), `frames_total`,
`frames_processed`, `predictions_key`, `error`, `created_by_id`,
`started_at`, `finished_at`, `created_at`.

No `stopped` status: cancelling a run is out of scope.

The model's task type and class list are copied into the result JSON. A run
must stay viewable after its `ModelVersion` is deleted, so the overlay never
needs the live model row, and the history shows `model_name`, which is also copied at creation.

### API (prefix `/inference`)

- `POST /runs` takes `{video_id, model_version_id, frame_stride}`, creates
  the run and its `Job`, answers 202. 404 for an unknown video or model; 422
  for a classify model or `frame_stride < 1`; a clear error if the video is
  not `browser_playable` (it could be inferred but not viewed): that is a 409.
  If the job cannot be handed to the broker, the run and its job are marked
  `failed` (error "Could not enqueue the job: ...") and the API answers 503.
- `GET /runs`, newest first. `GET /runs/{id}` for status and progress.
- `GET /runs/{id}/predictions` returns a presigned URL to the JSON, in the
  style of `download_model`. The JSON is not proxied through the API.
- `DELETE /runs/{id}` removes the row and the JSON object together (the
  lesson from model artifacts that outlived their version). Refused with 409
  while the run is `pending` or `running`. `DELETE /runs/{id}?force=true`
  removes an active run too: its job is marked failed first, and the worker
  tolerates the vanished rows. Deleting a run also deletes its job row.
- After any schema or route change regenerate `openapi.json` (see CLAUDE.md).

### Media

Deleting a video that has QC runs returns 409 ("Delete this video's QC runs
before deleting it"), because the run rows reference it.

### `ml-worker`

- `JobType.INFERENCE_RUN` and a Celery task `inference_run`. Like every other
  task it first calls the `_evict_*_models()` helpers so SAM2, SAM3, quality
  and similarity models do not share VRAM with it.
- `ml-worker/app/inference_adapter.py`: an `InferenceAdapter` Protocol
  (`infer(request, on_progress, ...) -> InferenceResult`), plus an Ultralytics
  implementation. It reads frames with OpenCV through a transient temp file
  (the sanctioned exception in CLAUDE.md), takes every `frame_stride`-th
  frame, and runs the model with `conf=0.05`. Weights come from object
  storage via `ModelVersion.storage_key`.
- Progress is flushed in batches (about every 2 seconds) to
  `frames_processed` and `Job.progress`, like the training log.
- Output goes through `StorageService` to `inference/{run_id}/predictions.json`.
- Failures (video cannot be opened, weights cannot be loaded) set `failed`
  with the message in `error`.

### Predictions JSON

```json
{
  "task_type": "detection | segmentation",
  "model": {"name": "...", "version_id": 12},
  "fps": 25.0,
  "frame_stride": 5,
  "classes": ["polyp", "..."],
  "frames": {
    "1420": {
      "timestamp_ms": 56800,
      "detections": [
        {"class_id": 0, "confidence": 0.87,
         "bbox": [0.324, 0.412, 0.120, 0.095],
         "polygon": [[0.324, 0.412], [0.330, 0.415]]}
      ]
    }
  }
}
```

Boxes are normalised 0..1 as `[x, y, w, h]`; `polygon` is present only for
segment models. `task_type` leaves room for classify without a migration.

`task_type` uses the `TaskType` enum values. `bbox` is `[x, y, w, h]` normalised to 0..1 with `(x, y)` the **top-left** corner.

Edge cases:

- A processed frame with no detections has `detections: []`. The key is
  never omitted, so the overlay can tell "nothing found" from "not processed".
- With `frame_stride > 1`, playback shows the nearest processed frame at or
  before the current time, so the tail of the video does not flicker.
- Variable fps: both `frame_index` (the key) and `timestamp_ms` are stored,
  and the overlay looks up by time.

## Frontend

Structure follows `features/training/` and `features/media/`; no new
libraries.

- `entities/useInferenceRuns.ts`: hooks over `apiClient` for list, one run,
  create, delete, and predictions. Pending or running runs poll with
  `refetchInterval`, as on Train, and stop on `succeeded` or `failed`.
- `features/qc/QcPage.tsx`, `RunForm.tsx`, `RunStatus.tsx`, `RunsTable.tsx`.
  The upload form is the existing `VideoUploadFlow` form (title, procedure, file input); drag-and-drop is not added in this sub-project. It selects the new video on
  success.
- `features/qc/RunViewPage.tsx`, `PredictionOverlay.tsx`, and
  `predictions.ts` (`detectionsAt`), a pure function from time to the nearest
  processed frame's detections, kept out of the component so it can be unit tested.
- `AppHeader.tsx` and `App.tsx`: the `Results` entry becomes `QC`.
- The overlay positions shapes inside the real picture rectangle, because
  the video is letterboxed. It reuses `features/media/computeVideoMediaRect.ts`.
  The overlay redraws from a `requestAnimationFrame` loop that draws only when the video time or the element size changed, which also covers paused and scrubbed states.
- The predictions JSON is downloaded once and held in the React Query cache.
  Long videos make it large (tens of MB); chunked loading is a sub-project 2
  concern if it proves necessary.

States: skeleton while the JSON loads (the player already works), a failed
run shows its `error` and a disabled `View`, a video that is not
`browser_playable` shows a transcode prompt in the style of `TranscodePrompt`,
and a deleted model leaves history and viewing intact.

## Testing

Test-first, per CLAUDE.md.

- Backend (isolated database via `import app.db as db_module`, never
  `from app.db import SessionLocal`): run creation (happy path, unknown
  video, classify model, `frame_stride < 1`, non-playable video); delete
  removes the row and the object; deleting a `ModelVersion` leaves the run
  readable with a null `model_version_id`.
- `ml-worker` (run inside the container, as in the existing test workflow):
  the adapter with a stubbed model for stride 1 and stride 5, JSON shape,
  the confidence floor; the task's progress, its `failed` path, and that
  eviction runs before the model loads. Tests sweep the rows and objects
  they create.
- Frontend: unit tests for `detectionsAt` and the overlay geometry,
  hook tests with a mocked `apiClient`, component tests for `RunForm` and
  `RunsTable`.
- Before the work is called done, one real run in a real browser against the
  real stack with a real model and video. Mocked tests cannot catch CORS or
  packaging problems (see "Testing philosophy" in CLAUDE.md).

## Deviations from the first draft

Decided during implementation:

- `inference_runs.model_name` column, copied at creation, so the history and
  the overlay survive deletion of the model version.
- Bounding boxes are stored and drawn top-left (`x, y, w, h`, normalized).
- The overlay redraws in a `requestAnimationFrame` loop rather than on
  `timeupdate`, which is too coarse for smooth boxes.
- No drag-and-drop upload; the existing form is reused.
- Force delete for active runs (arm/confirm, labelled "Force delete").
- A failed run's error is shown in the history table, under its status.

## Out of scope

- Sub-projects 2 to 5 above.
- Classify models, run cancellation, a time-range selection, streaming over
  WebSocket, Triton or TorchServe.

## Open items for the implementation plan

- Resolved: an Alembic migration is needed (new `JobType` value and table), and `VideoReviewPlayer` is coupled to sequences and cropping, so the QC player is a new component.
- How QC videos are marked or excluded from training datasets (see the
  leakage note).
