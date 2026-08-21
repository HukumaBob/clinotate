# Trainer-agnostic training metrics — design

**Date:** 2026-08-21
**Status:** approved in brainstorming, not yet implemented
**Problem statement:** `docs/superpowers/NEXT-TASK-training-metrics.md`

## The problem

Training works end to end (ROADMAP Phase 2b, 2026-08-20), but almost
everything a trainer computes is thrown away. `UltralyticsYoloAdapter`
keeps the numeric entries of `results.results_dict` and nothing else; the
run directory Ultralytics writes lives in a `TemporaryDirectory` that is
deleted when the task returns. Lost every run: `results.csv` (per-epoch
history), the confusion matrices, the PR/F1/P/R curves, `args.yaml`. The
models table on `/train` shows exactly one number from what survives.

The user asked for access to these metrics from the table, and said
explicitly that a second trainer (RT-DETR and others) will collect them a
different way and that this must not matter to the user. Also, on scope:
"не надо минимум — мы не спешим, делаем как следует."

## What decided the design

The brief offered a hypothesis to argue with rather than implement: maybe
a small normalized vocabulary is worth having, maybe everything should be
stored opaquely. Reading the reference platform's other trainers settled
it.

`medical_segmentation/utils/rtdetrv2_trainer.py` and `convnext_trainer.py`
are hand-written loops, not Ultralytics. Both already do exactly what a
normalized vocabulary would need:

- RT-DETRv2 calls `evaluate_detection(...)` every epoch, accumulates
  `val_maps`, and ends with a flat dict of `mAP50` / `mAP50_95` /
  `precision` / `recall`.
- ConvNeXt calls `calculate_classification_metrics(...)` every epoch
  (precision/recall/F1 macro), builds a `confusion_matrix` from sklearn at
  the end, and analyzes per-class confusion.

So the same *shape* — a headline number, a per-epoch history, per-class
numbers, a confusion matrix — arose independently in three of the four
stacks. Only the key names differ. The abstraction is not being invented
to fit YOLO; it is being read off trainers that already exist.

That is why the platform normalizes the **shape** and never the **names**.
Mapping `metrics/mAP50(B)` and `map50` onto one canonical key is precisely
the schema-shaped-around-one-trainer that the brief warns about, and that
the raw training log already rejected for the same reason.

## Decisions

Four decisions, all approved during brainstorming:

1. **Hybrid storage.** A normalized core the platform understands
   (headline, per-epoch history, per-class numbers, confusion matrix as
   numbers) *plus* the trainer's own files stored opaquely in MinIO,
   displayable and downloadable without the platform parsing them.
2. **Confusion matrix as data, drawn by us.** RT-DETR and ConvNeXt produce
   no `confusion_matrix.png`; drawing from numbers gives every trainer the
   same picture. Ultralytics' PNGs still land in MinIO as downloadable
   artifacts.
3. **History arrives during training, through a widened `on_epoch`** —
   not collected at the end. A run that dies at epoch 12 keeps 12 points
   instead of nothing, and the curve is visible live during a multi-hour
   run.
4. **No charting library.** Two diagrams (lines, grid) are drawn as
   inline SVG. `package.json` has no charting dependency today and one
   panel does not justify adding one.

## Verified facts

Checked live in the running `ml-worker` container, ultralytics 8.4.123
(the host image runs its interpreter at `/app/.venv/bin/python`; there is
no `python` on `PATH`):

- `DetMetrics` exposes `class_result`, `maps`, `curves_results`,
  `summary()`, `to_json()`, `results_dict`.
- `ClassifyMetrics` exposes `curves_results`, `summary()`, `to_json()`,
  `results_dict`.
- The confusion matrix is an **instance attribute** set by the validator —
  `self.metrics.confusion_matrix = self.confusion_matrix` at
  `ultralytics/models/yolo/detect/val.py:229` — which is why it does not
  appear in `dir(DetMetrics)`.
- `ConfusionMatrix.matrix` is `(nc+1, nc+1)` for detection and `(nc, nc)`
  for classification; the extra row/column is `background`.
- **`ConfusionMatrix.summary()` is lossy for display.** It runs class
  names through `re.sub(r"[^a-zA-Z0-9_]", "_", name)` and de-duplicates
  collisions, so `bad_preparation (colono)` becomes
  `bad_preparation__colono_`. The adapter therefore reads the raw
  `.matrix` array plus `.names`, never `summary()`.

## Component 1: the adapter contract

`ml-worker/app/training_adapter.py`.

`on_epoch` gains an optional third argument:

```python
on_epoch: Callable[[int, int, dict | None], None]
```

The dict is flat, name → number, in the trainer's own key names. A loop
that computes nothing passes `None`. This stays trivially implementable by
a plain `for epoch in ...` loop, as the brief requires: the hand-written
trainers already compute this dict at the end of each epoch and would only
need to hand it over.

`TrainingResult` gains four optional fields:

```python
@dataclass
class TrainingResult:
    weights_path: Path
    metrics: dict = field(default_factory=dict)
    history: list[dict] = field(default_factory=list)
    per_class: list[dict] = field(default_factory=list)
    confusion: dict | None = None
    artifacts: list[Path] = field(default_factory=list)
```

- `history` — `[{"epoch": 1, <trainer's keys>}, ...]`. Redundant with what
  `on_epoch` already delivered; it exists for a trainer that can only
  produce history at the end. An adapter that reports per epoch leaves it
  empty. If both are non-empty, the one from `TrainingResult` replaces
  what `on_epoch` accumulated: it is the trainer's own final word, and a
  loop that fills both is asserting the end-of-run version is the correct
  one.
- `per_class` — `[{"class": "polyp", <numbers>}, ...]`. The `class` key is
  required; every other key is the trainer's own.
- `confusion` — `{"labels": [...], "matrix": [[int, ...], ...]}`. For
  detection, `labels` ends with the literal string `"background"`, kept
  explicitly rather than trimmed: misses into background are real data.
- `artifacts` — paths the worker uploads verbatim.

Backward compatibility: every field defaults to empty, so an adapter that
returns only `weights_path` and `metrics` still satisfies the contract.

## Component 2: the Ultralytics adapter

`ml-worker/app/ultralytics_yolo_adapter.py`.

- In the existing `on_train_epoch_end` callback, read `trainer.metrics`
  (a flat dict) and pass it as `on_epoch`'s third argument. The callback
  is already there for progress and stop-polling; no new callback is
  registered.
- After training, build `per_class` from `results.summary()`, renaming
  only its `Class` key to `class` and keeping every other key as-is.
- Build `confusion` from `results.confusion_matrix.matrix` and `.names`,
  appending `"background"` for non-classify tasks. Values are cast to
  `int` — the matrix is a float array of counts.
- Collect `artifacts` by walking `request.output_dir` for files with
  extensions `.csv`, `.yaml`, `.png`, `.jpg`, `.json`, each under a size
  cap (10 MB), so a forgotten checkpoint cannot ride along.

Every one of these is wrapped so that a shape change in a future
Ultralytics release degrades to "this block is absent" rather than failing
a completed training run. Weights are the valuable output; metrics are
not worth losing them over.

## Component 3: persistence

Three new columns, no new tables. An epochs table shaped like YOLO's CSV
is exactly what the brief rules out — its columns would need redefining
per trainer, while a JSONB list of points accepts any key set.

On `TrainingRun`:

```python
metrics_history: Mapped[list] = mapped_column(JSON, default=list)
```

History belongs to the *attempt*, not the model: a run that fails at epoch
12 has no `ModelVersion` at all, and those 12 points are the most valuable
thing left. Written during training from `_on_epoch`.

When the adapter passes `None`, `_on_epoch` appends nothing — not a point
carrying only `{"epoch": n}`. A trainer that reports no metrics leaves
`metrics_history` empty, and the curve block is therefore absent rather
than rendering a chart with no series.

On `ModelVersion`:

```python
per_class_metrics: Mapped[list] = mapped_column(JSON, default=list)
confusion_matrix: Mapped[dict | None] = mapped_column(JSON, nullable=True)
artifact_keys: Mapped[list] = mapped_column(JSON, default=list)
```

These describe the finished model and only exist at the end.

The existing `metrics` column is left alone. It is already read by the
models table and the frontend; widening it into a nested object would
silently change the shape of something that works. Separate columns break
no existing reader.

**Thread safety.** `_on_epoch` in `ml-worker/app/tasks.py` already commits
the session, and `_LogBuffer` holds a `threading.Lock` because
`_ForwardingLogHandler.emit()` can call back from a non-training thread
into a `Session` that is not thread-safe. The history append happens
inside `_on_epoch`, which must take the same lock as the buffer before
touching the session. The plan must not introduce a second, independent
lock: two locks around one session is a deadlock waiting to happen.
Simplest correct form is to route the history write through the existing
`_LogBuffer` lock, or to give the buffer an explicit method for it.

**Artifact upload.** `model_train` uploads each artifact to
`models/<run_id>/artifacts/<filename>`, alongside the weights already at
`models/<run_id>/`, and records the keys in `artifact_keys`. The
ml-worker's `StorageService` needs no `delete` — deletion lives entirely
in the backend.

**Deletion must stay symmetric.** This is the failure mode `857760d`
already paid for once, with 174 MB of orphaned export archives.
`delete_model_version` becomes: delete every `artifact_keys` object, then
the weights, then the row — objects before the rows that name them, so a
storage failure leaves a recoverable record rather than orphaned bytes; a
missing object is logged and skipped rather than blocking the endpoint.
`delete_dataset` cascades into `ModelVersion` and must go through the same
path, or the same leak returns in a new form.

## Component 4: API

Two new endpoints under the existing `/training` prefix.

```
GET /training/models/{version_id}/metrics            → ModelMetricsRead
GET /training/models/{version_id}/artifacts/{index}  → {download_url}
```

`ModelMetricsRead`:

```python
{
  "metrics": {...},
  "history": [{...}],
  "per_class": [{...}],
  "confusion": {"labels": [...], "matrix": [[...]]} | null,
  "artifacts": [{"name": "results.csv", "index": 0}, ...]
}
```

`history` is read from the version's `TrainingRun`.

Kept off `ModelVersionRead` for the same reason the log is kept off
`TrainingRunRead`: the models list is polled, and a 180-class confusion
matrix is ~130 KB per row. The panel fetches on open.

Artifacts are addressed by **index into `artifact_keys`**, not by
filename, so a storage key from the database never appears in a URL and
cannot be edited to reach another object. The endpoint resolves the index
and returns a presigned URL via `storage.url_for`, matching
`download_model`.

After these routes land, regenerate the committed `openapi.json`:
`cd backend && PYTHONPATH=. uv run python scripts/export_openapi.py`.

## Component 5: the screen

The UI/UX spec (`docs/specs/2026-07-23-platform-ui-ux-design.md`, line
291) describes the models table with actions **Info, Download, Delete**.
Download and Delete exist; Info never got implemented. This is its
definition — no new screen, no new route.

The panel opens in the right-hand column of `/train`, where
`TrainRunPanel` already lives, when a model row is clicked. Deliberately
not a modal: training may be running underneath, and its live log and
progress must stay visible.

Five blocks, top to bottom. **Any block whose data is absent is omitted
entirely** — no dash, no error, no empty frame. That is the property that
makes the screen trainer-agnostic.

1. **Header** — version name, task type, headline metric, reusing the
   existing `headlineScore` logic from `ModelVersionsTable.tsx`.
2. **Training curve** — inline SVG line chart from `history`. X is epoch;
   one series per key seen across the points. Ultralytics emits about ten
   at once (three losses, four metrics, three learning rates), so: series
   are toggleable from the legend, and losses are split onto a second Y
   axis by the heuristic "key contains `loss`".
3. **Confusion matrix** — inline SVG grid drawn from the numbers, cell
   background scaled by value, axes labelled, `background` last. A
   180-class grid is physically unreadable, so it defaults to the top N
   classes by instance count with a "show all" toggle.
4. **Per-class table** — columns derived from the keys present, not
   hardcoded; sortable by any numeric column.
5. **Artifacts** — flat list of filenames, each a download link.

The panel must contain no reference to Ultralytics or to any specific
metric name. When RT-DETR arrives with different key names, the same five
blocks render with different series labels and nothing changes here.

## Testing

Per CLAUDE.md, every backend and logic-bearing frontend task gets a
failing test first.

- **Adapter contract:** a fake adapter implementing the widened protocol
  as a plain `for epoch in ...` loop, asserting it satisfies the contract
  and that `on_epoch(..., None)` is accepted. This test is the guard on
  the brief's constraint that the contract stay implementable by
  hand-written loops.
- **ml-worker task:** `model_train` with a stub adapter that reports per
  epoch and returns all four new fields — assert history lands on the run
  as it goes, artifacts upload under the expected keys, and the columns
  are populated.
- **Failure path:** a stub adapter that raises at epoch 3 — assert the
  first two history points survive on the failed run.
- **Deletion symmetry:** delete a `ModelVersion` with artifacts, assert
  every object is gone; assert a missing object does not block the
  delete. Same for the `delete_dataset` cascade.
- **API:** shape of `ModelMetricsRead`; a version with no metrics returns
  empty collections rather than 404; an out-of-range artifact index is
  404.
- **Frontend:** each block renders from data and is absent when its data
  is; the panel is asserted against a fabricated non-Ultralytics metrics
  payload, which is the real test of trainer-agnosticism.

Tests must use `import app.db as db_module` + `db_module.SessionLocal()`,
never the import-time `from app.db import SessionLocal` form, which
bypasses conftest's patching and writes to the real `endoscopy` database.

## Verification

Unit tests cannot catch what this project has repeatedly been bitten by —
a 64 MB `/dev/shm` starving the DataLoader, an image that never contained
the training code, an export writing six classes where the screen showed
one. So, beyond green tests: run one short real training run on the actual
stack, open Info on the resulting model, and confirm the curve, matrix,
per-class table and artifact downloads against what Ultralytics wrote in
its own run directory. Report plainly what was and was not verified.

Note that the ml-worker image does not COPY `tests/`, so ml-worker tests
run via `docker cp` + `docker compose exec`.

The GPU is one RTX 2070 shared with the desktop and an active `ollama`
service, and this host has hard-rebooted under GPU pressure before.
Nothing here needs more than an ordinary short run.

## Out of scope

- Comparing two model versions side by side.
- Any RT-DETR adapter. This design makes one possible; writing one is a
  separate task.
- Charting library, light theme, per-class metrics for segmentation masks
  beyond what Ultralytics already reports.
