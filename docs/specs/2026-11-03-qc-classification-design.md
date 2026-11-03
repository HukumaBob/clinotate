# QC screen: classification, sub-project 1 of 4

Date: 2026-11-03. Status: draft, awaiting approval. Builds on
[inference runs](2026-10-06-qc-inference-runs-design.md),
[inspection](2026-10-06-qc-inspection-design.md) and
[frame classification labeling](../superpowers/specs/2026-08-13-sequence-grid-frame-classification-design.md).

Decisions marked **(my call)** were made by the author, not the user, and are
open to challenge. Everything else was stated by the user.

## Why

QC can run detection and segmentation models on a video, but not frame
classifiers. The platform already trains classifiers (YOLO11-cls) on
frame-level labels along independent **axes** (a taxonomy `Category`: anatomy,
imaging mode, quality). A single frame carries one label per axis, for
example *cecum* + *NBI* + *poor quality*. The user needs to run those
classifiers on a control video, watch what they say frame by frame, and
distrust abrupt changes: smooth transitions are normal, a sudden jump is a
reason to look.

## The whole feature, and where this document sits

The user wants QC to also **judge** the classifiers against a hand-labeled
reference and turn the errors into training data. That is four independent
sub-projects, built in this order, each with its own spec and plan:

1. **Classification in QC runs (this document).** Run a set of classifiers,
   store labels and probabilities per frame, show them on the run view,
   highlight abrupt changes. Enough on its own to review an unlabeled video
   by eye.
2. **Reference labeling.** Intervals on per-axis lanes inside the QC window,
   drawn with keys and mouse; gray zones; a *clean / compromised* status per
   video.
3. **Evaluation against the reference.** Per-class precision/recall/F1,
   confusion matrix, error episodes, boundary versus interior errors, flicker
   against the reference, confident errors. Paired lanes (reference above
   prediction, mismatches hatched red).
4. **Dataset from errors.** Commit error episodes (sampled, with margin) to a
   `Sequence` of frames with classification annotations taken from the
   reference.

Everything in this document is shaped so 2 to 4 can be added without
reworking it: probabilities are stored (needed for "confident errors"), the
lanes component accepts an optional reference lane, and the predictions file
is per axis.

## Goals

- Run one or more classification models on one video in a single QC run, one
  model per axis.
- Show, during playback, the current label and confidence of every axis.
- Show a lane per axis under the video: contiguous stretches of one label as
  coloured segments, clickable to seek.
- Mark abrupt changes on the lanes and let the user jump between them.
- Keep a run viewable after its models are deleted (as for detection).

## Non-goals

- Reference labels, metrics, dataset commit (sub-projects 2 to 4).
- FP/FN flags, A/B comparison and review reels for classification runs. They
  are defined for boxes and masks. The API answers 409 with a plain reason
  and the UI hides them.
- A multi-head model (one network, several outputs). The platform trains one
  model per axis; a multi-head model would later just fill several axes.
- A per-axis `frame_stride`. One `frame_stride` for the run; per-axis stride
  belongs in the clinical application, which is a separate project.
- Temporal smoothing of predictions. QC shows the raw output; smoothing is a
  clinical-application concern.
- A confidence floor slider (low confidence rendered as "uncertain"). The
  probabilities are stored so it can be added later.

## Anti-goals

- Hiding jumps. Nothing in QC may smooth, debounce or filter what the model
  emitted.
- Changing how detection and segmentation runs are created, stored or viewed.
- Loading models so large that classifiers and the existing detection path
  cannot share the 8 GB GPU; classifiers are loaded only for classification
  runs, after the other model families are evicted.

## Decisions

| Question | Decision |
|---|---|
| Unit of a run | Still one `InferenceRun` per video. A classification run holds a list of **axes**, each a classification `ModelVersion` bound to a taxonomy `Category`. |
| Where axes live | A nullable JSON column `inference_runs.axes` (non-null means a classification run), a snapshot like `model_name`: `[{"model_version_id", "model_name", "name", "category_id" (nullable), "classes"}]`. `model_version_id` on the run stays null for such a run. **(my call)** |
| Which models can run | Classification versions trained by the Ultralytics adapter only (`task_type` classification and `adapter == "ultralytics_yolo"`). DINOv3 versions are crop classifiers that inherit a detection or segmentation task type; they are not listed and the backend refuses them, as it does today. Chained inference (box, crop, DINOv3) stays its own project. |
| What an axis is | A **name** plus the model's own class list. It is *not* forced to be one taxonomy `Category`: the only real classification model today (`yolo11n-cls-run528`) mixes seven classes of two categories (Anatomy plus `outside_the_body` from Artifacts) in one head. The axis name defaults to the category owning most of the model's classes (matched on label name, ignoring duplicate label rows) and is editable in the form. `category_id` is optional metadata, null when the classes span categories. Later sub-projects match reference intervals to model classes by label name, not by category. **(my call)** |
| Axes per run | One or more; axis names unique within a run; at most 6 (a sanity cap). **(my call)** |
| Frames | All frames with the run's `frame_stride` (default 1), same as detection. |
| What is stored | Per processed frame and axis: top class id, its confidence and the whole probability vector. |
| Execution | Same `Job` plus `ml-worker` mechanism; one decode pass, every frame goes through every axis model. |
| Perturbation (stress) | Allowed on classification runs: it is applied to the frame before the models, on the existing code path. |
| What counts as an abrupt change | A **blip**, per axis: a stretch of one label of at most `flickerN` processed frames whose two neighbours carry the **same** other label (A, B, A: the model left and came straight back). A short stretch between two different labels (A, B, C) is a transition and is not flagged. A stretch touching the start or end of the video is never a blip (its far side is unknown), the same rule as `findFlickers`. Consecutive blips (A, B, A, C, A) are each reported. `flickerN` counts **processed** frames, and the existing coarse-window warning (`COARSE_WINDOW_MS`) applies when `frame_stride` makes N frames span seconds. Every label change is still drawn as a segment border, so smooth transitions stay visible. **(my call)** |

## Data

### `inference_runs.axes`

Nullable JSON, Alembic migration, no backfill. `InferenceRunRead` gains
`task_type` (derived: `classification` when `axes` is set, else the model's)
and `axes`. `model_name` of a classification run is a summary such as
`Anatomy, Mode, Quality` so the history table needs no change beyond showing
it.

### Predictions JSON for classification

```json
{
  "task_type": "classification",
  "fps": 25.0,
  "frame_stride": 1,
  "axes": [
    {"category_id": 4, "name": "Anatomy", "classes": ["cecum", "ascending", "transverse"]},
    {"category_id": 7, "name": "Mode", "classes": ["white light", "NBI"]}
  ],
  "frames": {
    "1420": {
      "timestamp_ms": 56800,
      "axes": [
        {"class_id": 0, "confidence": 0.912, "probs": [0.912, 0.071, 0.017]},
        {"class_id": 1, "confidence": 0.998, "probs": [0.002, 0.998]}
      ]
    }
  }
}
```

`axes` in the frame is parallel to the header's `axes`. Probabilities are
rounded to three decimals. Size: about 60 bytes per frame and axis, so a
30-minute video at stride 1 and three axes is roughly 8 MB. This is the same
order as detection and is downloaded once and cached, as before.

## Backend

- `POST /inference/runs` accepts either `model_version_id` (detection or
  segmentation, unchanged) or `classifiers: [{model_version_id, name?, category_id?}]`.
  Exactly one of the two, otherwise 422. For `classifiers`: every model must
  be an Ultralytics classification model (422 otherwise), axis names unique
  (a missing `name` is inferred as above; 422 if it cannot be and none given). The existing 404/409/503
  behaviour is unchanged. The existing 422 for classification models on the
  `model_version_id` path stays.
- `GET /inference/runs/{id}/flags`, `PUT`, `POST commit`, `GET /inference/compare`
  and reels answer 409 "not available for classification runs" when the run
  has axes.
- Deleting a `ModelVersion` leaves the run readable (the snapshot in `axes`).

## ml-worker

- `ultralytics_classification_adapter.py` next to the existing inference
  adapter, behind the same `InferenceAdapter` Protocol. Takes a request that
  carries the axes (weights key, class names) instead of one model.
- Reads frames once with OpenCV through the sanctioned temp file, takes every
  `frame_stride`-th frame, applies the perturbation, runs each axis model, and
  writes `probs` from the model output.
- Calls the existing `_evict_*_models()` helpers before loading; loads all axis
  models for the run together (they are small) and unloads them when the run
  ends.
- Progress, failure handling and the output location
  (`inference/{run_id}/predictions.json`) are as for detection.
- *To confirm while planning (read the installed Ultralytics, do not assume):*
  the exact attribute that returns the full probability vector from a
  classification result, and that the class order equals `class_names`.

## Frontend

- **Run form** (`QcPage`): a switch between *Detect / segment* and *Classify*.
  *Classify* lists classification model versions only; the user adds axis rows
  (model select plus the inferred axis name, editable), up to the cap. The
  same video picker and `frame_stride`.
- **Run view** (`RunViewPage`), when the run is a classification run:
  - Badges over the video, one chip per axis at the top-left, stacked in a
    row and wrapping, each `label NN%`. Long names are truncated with the full
    text in a tooltip. Placed so they do not cover the detection overlay's
    own labels (classification runs have no boxes, so there is no overlap in
    practice). Design in the platform's existing dark style. **(my call)**
  - `AxisLanes`: one lane per axis under the player, each stretch of one label
    a coloured segment with its name; a fixed palette per class id; a
    playhead; click to seek. A per-axis header with the number of label
    changes and the time share of each class. Takes an optional `reference`
    prop per axis, unused here, so sub-project 3 can add the paired lane
    without restructuring.
  - Blip markers (white ticks) on each lane. The existing event navigation
    (next/previous, hotkeys) steps through the blips of **all axes merged
    into one timeline ordered by time**, not label changes; the axis of the
    current event is highlighted. **(my call)**
  - The flicker-window control from inspection is reused; the confidence and
    NMS sliders and the flags, A/B and reels panels are hidden.
- Pure functions in their own files, unit tested: run-length segmentation of a
  per-axis label sequence, blip detection, label lookup by time (nearest
  processed frame at or before the time, as for detections).

## Testing

Test-first, per CLAUDE.md.

- Backend (isolated database via `import app.db as db_module`): creating a
  classification run (happy path, two axes, same axis name twice, a DINOv3 version, non-classification
  model, axis not inferable, neither or both of `model_version_id` and
  `classifiers`); read-back of `axes`; the 409s for flags/compare/reels;
  `ModelVersion` deletion leaves the run viewable; the detection path
  unchanged.
- ml-worker (inside the container): the adapter with stubbed models for two
  axes, stride 1 and 5, JSON shape, probabilities summing to about 1, eviction
  before load, `failed` path.
- Frontend: segmentation and blip detection (including a blip at the very
  start or end of the video, and two blips in a row), time lookup, form
  behaviour, lanes rendering and seek.
- Before the work is called done, one real run in a real browser against the
  real stack with real classification models. If no real classification model
  exists yet, train a small one first through the Train screen; say so rather
  than fake it.

## Open items for the plan

- Confirm the Ultralytics classification output API (above).
- Real data seen while writing this: one classification model exists
  (Anatomy classes plus `outside_the_body`), and the taxonomy holds duplicate
  rows for some labels (`outside_the_body`, `good_quality`, `low_quality`
  appear twice, probably across taxonomy versions). The axis-name inference
  must deduplicate by label name. A real three-axis browser check needs two
  more classification models (mode, quality) trained first.
- Where the blip window default should sit; copy the value used for
  detections unless it makes no sense for per-frame labels.
