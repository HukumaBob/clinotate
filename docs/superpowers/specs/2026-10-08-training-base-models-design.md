# Training: base-model catalog and fine-tuning from a ModelVersion

Date: 2026-10-08. Extends [2026-08-19-train-screen-design.md](2026-08-19-train-screen-design.md);
the screen layout approved there (tabs by family, config form left, live
status right, model-versions table below) is unchanged.

## Problem

The Train screen's "Base model" field is a hardcoded list of three weights
(`yolo11n.pt`, `yolo11s.pt`, `yolo11m.pt`) that ignores the dataset's task
type. The worker silently rewrites the name to `-seg` / `-cls` for
segmentation and classification datasets, so the UI shows a name that is not
what is trained. There is no `l` or `x` size, and a trained `ModelVersion`
cannot be used as a starting point, which is what the QC loop (flag frames →
"Send to training" → extended dataset) exists to feed.

The tool trains on endoscopic findings where the question is subtle surface
pattern (adenoma vs hyperplastic polyp, HGD vs LGD), so model size
(speed/accuracy) matters, and so does continuing from a model already
trained on earlier data.

## Scope

In this iteration (YOLO11 only):

- **A. Task-aware base-model choice:** sizes n/s/m/l/x for detection,
  segmentation (`-seg`) and classification (`-cls`), listed under their real
  weight names.
- **B. Fine-tuning from a `ModelVersion`:** a trained version of the same task
  type and adapter can be selected as the starting point.
- **C. Real verification of segmentation and classification training.** Both
  paths exist in code but have never produced a kept `ModelVersion`. Done as
  a check at the end, not as separate development.

Out of scope, deliberately: other architectures (RT-DETR, ConvNeXt, DINOv2,
YOLOv8/26) — the second adapter arrives with RT-DETR, not before; uploading
arbitrary `.pt` files; a persistent cache of pretrained weights; free-text
weight names; run comparison; VRAM estimation.

## Decisions

1. **The catalog lives in the backend** (`backend/app/training/catalog.py`),
   keyed by adapter name. The adapter lives in `ml-worker`, which the backend
   cannot import; the worker receives an already-resolved weights name. A
   future adapter adds a table entry, not a form change.
2. **Fine-tuning is a nullable FK**, `TrainingRun.base_model_version_id`, not
   an encoded string. `base_model` stays a human-readable label (weights name,
   or the parent's name). The FK gives lineage and lets deletion be guarded.
3. **`l` and `x` are shown with a note, not blocked.** The GPU is 8 GB and
   this host has hard-rebooted under VRAM pressure; the note
   ("may not fit in 8 GB") is carried in the catalog entry (API-visible), the
   decision stays with the person.

## Backend

**Catalog.** For `ultralytics_yolo` and each `TaskType`, five pretrained
entries `yolo11{n,s,m,l,x}` with the task suffix applied (`yolo11s-seg.pt`).
Entry fields: `kind` (`pretrained` | `model_version`), `weights`, `label`,
`family`, `size`, `note` (set for `l`/`x`), `model_version_id` (versions only).
Confirmed against ultralytics 8.4.123 in the ml-worker image: every
size × task weight name exists.

**`GET /training/base-models?dataset_id=N`.** Pretrained entries for the
dataset's task type, plus every `ModelVersion` with the same `task_type`
trained by the same adapter (note: metric and date). Unknown dataset → 404.

**`POST /training/runs`.** Add optional `base_model_version_id`. Exactly one of
`base_model` / `base_model_version_id` is required, otherwise 422. A
pretrained name must be in the catalog for the dataset's task type (arbitrary
strings → 422); legacy names such as `yolo11s.pt` on a segmentation dataset
are accepted and normalised to `yolo11s-seg.pt`. A version must match the
dataset's task type and the adapter, otherwise 422 with a readable message.

**Data model.** `training_runs.base_model_version_id` (nullable FK to
`model_versions`) with an Alembic migration. `TrainingRunRead` and
`ModelVersionRead` expose it so the table can show lineage.

**Deletion.** `delete_model_version` returns 409 only when a run fine-tuned
from the version is still PENDING/RUNNING (naming the run) or still owns a
model version (naming that version). Stale child runs (failed, stopped, or
succeeded without a version) never block: their `base_model_version_id` is
set to NULL before the delete, and their `base_model` string keeps the
parent's name as lineage. Without this, a failed fine-tune would make its
parent, and through `delete_dataset` the dataset, permanently undeletable,
since no endpoint deletes training runs.

## ml-worker

- `ml-worker/app/models.py` mirrors the new column (the worker keeps its own
  copy of the models; the migration lives in the backend only).
- `model_train`: when `base_model_version_id` is set, download the parent's
  `.pt` from MinIO into the run's temporary `workdir` and pass that path as
  `TrainingRequest.base_model`. A missing parent or missing file fails the run
  with a readable error rather than an Ultralytics "file not found".
- `UltralyticsYoloAdapter` / `weights_for_task`: a local path is returned
  untouched (no task suffix appended). The `TrainingAdapter` interface does
  not change.
- New version naming for fine-tuning: `<parent name>-ft-run<id>`; unchanged
  for pretrained starts.
- Class-set mismatch with the parent is handled by Ultralytics (matching
  layers transferred, head re-initialised); we only guarantee its message
  reaches the raw run log.

## Frontend

All inside the already-approved layout; no new screen or interaction model.

- `TrainConfigForm`: remove `BASE_MODELS`. Fetch the catalog when the selected
  dataset changes and reset the selection (it may be incompatible with the new
  task type). One `<select>` with two `<optgroup>`s — "Pretrained (YOLO11)"
  and "Your models (fine-tune)" (the latter only when non-empty). Real weight
  names; `note` rendered beside `l`/`x`. Disabled until a dataset is chosen;
  an error is shown if the catalog request fails.
- Static hint under the field when a version is selected: matching layers are
  kept; if the class set differs, the head is re-initialised (see the log).
  Not computed client-side — dataset schemas do not expose class names, and
  the hint does not justify adding that.
- `onSubmit` sends exactly one of `baseModel` / `baseModelVersionId`.
- `ModelVersionsTable`: a "Base" column — weights name for pretrained starts,
  "↳ parent name" for fine-tunes. A 409 on Delete shows the server's message.
- `openapi.json` regenerated after backend changes; client code uses
  `apiClient`, nothing hand-edited under `generated/`.

## Testing and verification

TDD throughout; backend tests use `db_module.SessionLocal()`, never
`from app.db import SessionLocal`.

- **Backend:** catalog shape per task type (suffixes, notes on l/x); catalog
  endpoint filtering and 404; run creation rules (exactly-one, catalog check,
  legacy-name normalisation, task/adapter mismatch → 422, FK persisted);
  delete-version 409 with and without children; migration on a clean DB.
- **ml-worker** (docker cp + exec workflow): `model_train` with a stub adapter
  — parent weights downloaded and path passed through; missing parent → FAILED
  with message; `weights_for_task` leaves paths alone; fine-tune naming.
- **Frontend:** catalog fetch on dataset change and selection reset; groups and
  l/x notes; hint only for versions; submit payload; lineage column; 409 text.
- **Live:** rebuild the ml-worker image (docker cp does not deploy) and apply
  the migration; in a real browser (`manualcheck@example.com`) drive the form
  for detection, segmentation and classification datasets; run one short
  YOLO11-n training each for segmentation and classification (few epochs,
  small batch/imgsz) and one fine-tune from a resulting version; confirm
  versions, metrics, confusion matrix and lineage render. `l`/`x` are not run
  live. Afterwards remove every row and MinIO prefix these runs created from
  the real `endoscopy` DB (sweeping all tables, backed up to scratchpad
  first). Dev servers and ports are not touched without asking.
- **ROADMAP:** new phase entry with deviations found and the real
  verification status of segmentation and classification.

## Risks

- A real `l`/`x` run on 8 GB may exhaust VRAM; the note warns, nothing
  prevents it, and it is unverified.
- Pretrained weights are still downloaded from GitHub at run start (network
  was reachable from the container when checked); no cache is added here.
- Existing known gap, not addressed: a worker that dies mid-run leaves the
  `TrainingRun` RUNNING forever.
