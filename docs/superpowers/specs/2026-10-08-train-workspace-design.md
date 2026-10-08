# Train screen as an experiment workspace

Date: 2026-10-08. Supersedes the Train section of
[2026-07-23-platform-ui-ux-design.md](../../specs/2026-07-23-platform-ui-ux-design.md)
(approved there only "at a rough/draft level") and the screen section of
[2026-08-19-train-screen-design.md](2026-08-19-train-screen-design.md). Builds
on [2026-10-08-training-base-models-design.md](2026-10-08-training-base-models-design.md)
(catalog, fine-tuning), whose backend and data model it assumes.

## Problem

The Train screen is a launcher plus a log. Observed on the running screen:

- The raw log gets most of the space and is unreadable (ANSI codes such as
  `▫[K` and one line per progress-bar step), while the thing the screen exists
  for, trained models and their quality, is squeezed into a short strip.
- The form has five unexplained fields; "Advanced" holds only image size.
  `POST /training/runs` already accepts an `advanced` dict, but the UI sends `{}`.
- A dataset is chosen by name alone ("009"): no task type, frame counts or
  classes.
- A finished run leaves a status badge and a log; its configuration, duration
  and final metrics are not shown anywhere together.
- Runs cannot be compared, named, annotated, repeated with a change or deleted.
  The stated purpose of the tool is to compare architectures and settings on
  subtle endoscopic findings (adenoma vs hyperplastic polyp, HGD vs LGD) and to
  fine-tune from earlier models as the QC loop adds data.

## Goals

An experiment workspace: choose a dataset, see its history of runs, launch a
new run with explained settings and presets, watch it live, and compare runs
side by side. YOLO11 is the only adapter now; the design must not need
rework when a second adapter (RT-DETR) arrives.

## Decisions

1. **Comparison is scoped to one dataset.** mAP, top-1 and confusion matrices
   are only comparable on the same validation split and class set. The
   workspace is organised around a dataset; runs on other datasets are never
   offered for comparison (including a dataset extended from QC: that is a new
   dataset).
2. **The settings schema is owned by the backend,** per adapter, next to the
   base-model catalog. The form is rendered generically from it; a new adapter
   ships its own schema and the screen does not change.
3. **Per-class metrics and the confusion matrix are facts of the run,** not of
   its weights. They are copied onto `TrainingRun` so that deleting a model does
   not erase the experiment record. Deleting a *run* is a separate, explicit
   action.
4. **Curated settings plus presets,** not every Ultralytics key and not a free
   `key=value` field.
5. **Layout:** dataset on the left, tabs on the right, a pinned strip for the
   active run. Page scrolls as a whole; nested scrolling only for the log and
   the class list.

## Settings schema

`backend/app/training/params.py`, keyed by adapter name (`ultralytics_yolo`).
A field: `key`, `label`, `group`, `type` (`int` | `float` | `bool` | `choice`),
`default`, `min`, `max`, `step`, `choices`, `help` (one or two sentences),
`tasks` (task types it applies to). Names and defaults below were read from
ultralytics 8.4.123 (`cfg/default.yaml`).

| Group | Fields (default) |
|---|---|
| Basic | `epochs` (50), `batch` (8), `imgsz` (640, step 32), `patience` (100), `seed` (0) |
| Optimization | `optimizer` (auto / SGD / Adam / AdamW), `lr0` (0.01), `lrf` (0.01), `cos_lr` (false), `weight_decay` (0.0005), `warmup_epochs` (3.0) |
| Augmentation | `hsv_h` (0.015), `hsv_s` (0.7), `hsv_v` (0.4), `degrees` (0), `translate` (0.1), `scale` (0.5), `fliplr` (0.5), `flipud` (0), `mosaic` (1.0), `close_mosaic` (10), `mixup` (0); segmentation only: `copy_paste` (0); classification only: `erasing` (0.4), `auto_augment`, `dropout` (0) |
| Fine-tuning | `freeze` (empty = none; first N layers) |
| System | `cache` (false / ram / disk), `workers` (8), `amp` (true), `deterministic` (true) |

Not exposed: loss gains (`box`/`cls`/`dfl`), `shear`, `perspective`, `bgr`,
`cutmix`, `compile`, `fraction`, `single_cls`, `nbs`, `rect`, `resume`,
`pretrained`, `data`, `project`, `name`, `exist_ok`. The last five would let a
request redirect the trainer, so they are not in the schema and are rejected.

**Presets** are data in the same schema: a named set of field values that
only fills the form, after which every field stays editable.

| Preset | Values (starting points; the user tunes them) |
|---|---|
| Quick check | `epochs` 3, `batch` 4 |
| Standard | schema defaults |
| Fine detail | `imgsz` 800, `batch` 4, `hsv_h` 0.005, `hsv_s` 0.3, `hsv_v` 0.2, `mosaic` 0.5, `scale` 0.3, `close_mosaic` 15 — larger frame, gentler colour jitter so mucosal colour cues are not erased |
| Fine-tune | `epochs` 30, `freeze` 10, `optimizer` AdamW, `lr0` 0.0005, `warmup_epochs` 1 |

The two non-default presets are guesses, not clinical knowledge. Note for the
help text of `lr0`/`momentum`: Ultralytics' `optimizer: auto` chooses the
optimizer and learning rate itself, so `lr0` has effect only with an explicit
optimizer (to be verified against the installed version while implementing).

## Data model and API

- `training_runs`: `name` (nullable str), `note` (nullable text),
  `per_class_metrics` (JSON), `confusion_matrix` (JSON, nullable). The
  migration backfills the last two from existing `model_versions`. The worker
  writes them to both the run and the version.
- `POST /training/runs`: `dataset_id`, `base_model` xor `base_model_version_id`,
  `name?`, `note?`, `settings: {key: value}`. Settings are validated against
  the schema for the dataset's task type: unknown key, out-of-range value or a
  key not applicable to the task → 422. `epochs`/`batch`/`imgsz`/`advanced` are
  folded into `settings` (the only client is this frontend).
- `GET /training/settings-schema?dataset_id=N`: groups, fields and presets for
  that dataset's task type.
- `PATCH /training/runs/{id}`: `name`, `note`.
- `DELETE /training/runs/{id}`: 409 if the run is active or owns a model
  version; otherwise removes the row. Deleting a model keeps its run in the
  history.
- `GET /training/runs?dataset_id=&status=&limit=`; `TrainingRunRead` gains
  `name`, `note`, `model_version_id` (the version the run produced, or null).
- `GET /training/runs/{id}/metrics`: history, final metrics, per-class and
  confusion read from the run. `/training/models/{id}/metrics` stays and
  delegates.
- A run stuck in RUNNING is closed by the existing second Stop (force-stop).

## Worker

The adapter passes the validated `settings` to `model.train(...)`. The stored
log stays raw. Existing behaviour (cooperative stop at epoch boundaries, one
run at a time) is unchanged. The run's history already streams to the database
each epoch; the screen uses it for a live curve.

## Screen

Dark theme only, Tailwind, existing components reused where they exist
(`MetricsChart`, `ConfusionMatrix`, `ArtifactGallery`).

**Sizing rules.** The page scrolls as a whole. Left rail fixed (~300 px). Forms
capped (~720 px); tables full width; charts have a fixed aspect and a minimum
height (~280 px); the log has a minimum height rather than absorbing leftover
space.

**State in the URL**, e.g. `/train?dataset=496&tab=runs&run=268&compare=268,406`,
so refresh and links keep context.

**Active-run strip.** Shown on any tab while a run is pending/running:
`▶ #407 · yolo11s · epoch 14/50 · mAP50 0.61 · [Stop]`; click opens its details
(switching dataset if needed). Stop keeps its explanation that it takes effect
at an epoch boundary.

**Left rail: dataset.** A select (name, task type, frame count; datasets
without an export are disabled with the reason), and a card: task type, frames
per train/val/test, classes with instance counts (scrollable), an
"export it on the Dataset screen" warning when missing, and the number of runs.
All from `GET /datasets` (`item_count`, `split_counts`, `balance_metrics`,
`exported`); no new request.

**Tab "Runs".** The history of this dataset: checkbox, #, name (note beneath,
muted), base (`yolo11n.pt` or `↳ parent`), key settings in one line
(`640 · b4 · 50 ep · freeze 10`), status, headline metric (best in the column
emphasised), duration, date, actions: open, **repeat with changes** (copies
the run's base and settings into the form), delete (arm/confirm). Selecting
two or three rows enables "Compare".

**Tab "New run".** Base model (catalog, with the existing VRAM note and
fine-tune hint), name, note, preset buttons, then the settings groups
(Basic open, the rest collapsed). Each field: label, input, range, one-line
help, a "changed" marker and reset-to-default. A sticky "What will run" panel
lists dataset, task, base and only the settings that differ from the defaults,
with the Start button.

**Run details** (reached from the table), sub-tabs:
- *Overview:* name and note editable in place; configuration grouped with
  non-default values highlighted; final metrics; curve; live progress for an
  active run; actions (repeat with changes, download model, delete run).
- *Metrics:* curves, per-class table, confusion matrix.
- *Log:* cleaned (ANSI sequences removed, progress-bar steps folded into one
  updating line), follows the tail unless the reader scrolled up.
- *Model:* weights, artifacts, download, delete model.

**Compare** (two or three runs of one dataset): configuration differences
(only rows that differ), overlaid curves with a metric selector (default the
headline metric), a final-metrics table (best emphasised, delta against the
first), a per-class table run × class with deltas, confusion matrices side by
side and, for exactly two runs, a "difference B − A" toggle. Tables are built
from the union of metric keys, never a hardcoded vocabulary. Each section has
a short caption of what it shows.

**Empty and error states** are written copy, not blanks: no runs yet, dataset
not exported, settings schema failed to load, run deleted while open.

## Delivery: three plans

1. **Launch:** settings schema, presets, run name/note, new `POST` body,
   `GET /training/settings-schema`, the "New run" tab and the dataset card.
2. **History:** runs table, run details, live curve, log cleaning, delete and
   repeat-with-changes, run-level metrics, copying per-class/confusion onto
   runs (with backfill), URL state, the page shell.
3. **Compare:** the whole compare view.

Each plan ships working, testable software; 1 and 2 are useful without 3.

## Testing and verification

TDD per CLAUDE.md. Backend: schema validation (unknown key, range, task
applicability, forbidden keys, presets only reference real fields), run
create/patch/delete rules, run-level metrics, migration backfill. Worker:
settings reach `train()`, per-class and confusion written to the run.
Frontend: schema-driven form (changed marker, reset, preset fill, repeat with
changes), table (sorting, best emphasis, selection limits), log cleaning
(ANSI, `\r`), URL state round-trip, compare tables and the difference matrix.
Live: a real browser pass over every tab at 1920×1080 and a narrow viewport,
real short runs at size n as in the previous phase, then clean the real DB and
MinIO of anything created.

## Out of scope

Other architectures (second adapter), run scheduling or queues, an estimated
VRAM calculator, hyperparameter search, exporting reports, comparing runs
across datasets, a free-form `key=value` field.

## Open items for the plans

- Where the carriage-return progress updates are lost (worker stream versus
  display) decides whether log folding is purely a display concern.
- Whether `optimizer: auto` really ignores `lr0` in the installed version.
- The exact numbers in the "Fine detail" and "Fine-tune" presets.
