# Train screen and the `training` module

Date: 2026-08-19
Status: approved

Follows [2026-08-18-dataset-export-design.md](2026-08-18-dataset-export-design.md),
which made a `Dataset` produce a real archive on disk. Something has to
train on it.

Four decisions were settled during an earlier brainstorming session and are
recorded in ROADMAP.md's Phase 2b entry of 2026-08-18; this spec builds on
them rather than reopening them:

- the training log stays **raw**, because the reference platform trained
  with four different stacks and no common output format exists to parse;
- **one working YOLO trainer**, behind an interface shaped for hand-rolled
  PyTorch loops rather than only Ultralytics; no stub second adapter;
- training runs as a **`Job`**, like every other long operation here;
- the GPU risk on this host is **known and accepted by the user** — the
  reference platform trained successfully on this same machine, so the
  hardware is not the suspect and further driver-level investigation was
  explicitly ruled out.

## Problem

A dataset can be assembled, balanced, and exported. From there the user
leaves the platform: weights are trained elsewhere, by hand, and nothing
records what was trained on what. The Train screen closes that gap —
start a run against a saved dataset, watch it, and keep the weights it
produced.

Three questions were open when this spec began. Each is answered below at
the point where it bites.

## The log lives in Postgres

Progress in this stack already flows one way: `ml-worker` updates a `Job`
row, the frontend polls it. A log is the same shape, only bigger — a
stream of lines rather than one integer.

`TrainingRun.log_text` is a text column the worker appends to, flushed
once every ~2 seconds or ~20 lines rather than per line. At that rate a
multi-hour run costs roughly 30 single-row UPDATEs per minute, which is
nothing for Postgres, and the same column serves both the live view and
the history — a finished run's log is still there to read.

The alternatives were weighed and rejected. A Redis list is faster and
lighter on the database, but its contents vanish with the key, so the
history would need a database copy anyway — Redis plus Postgres rather
than Postgres alone. Object storage suits a final artifact but not a live
stream, since an object cannot be appended to, only rewritten whole.

The log is **not** returned by the status endpoint. Over an hour it grows
to megabytes, and shipping all of it every two seconds is waste; it has
its own endpoint that returns only the tail past a caller-supplied
offset.

## Two entities, not one

A training run and a set of weights are different things, and the failure
case proves it: a run that dies in epoch three has a log, an error, and a
config worth seeing in the history table, but no weights at all.

**`TrainingRun`** is the process.

| column | type | notes |
|---|---|---|
| `id` | PK | |
| `dataset_id` | FK → `datasets.id` | what it trained on |
| `job_id` | FK → `jobs.id` | ties into the shared job machinery |
| `adapter` | str | `"ultralytics_yolo"` — which `TrainingAdapter` ran |
| `base_model` | str | e.g. `yolo11n.pt` |
| `task_type` | enum | reuses `datasets.models.TaskType` |
| `config` | JSONB | epochs, batch, imgsz, advanced knobs |
| `status` | enum | `pending / running / succeeded / failed / stopped` |
| `stop_requested` | bool | cooperative cancellation flag |
| `log_text` | Text | raw log, appended in chunks |
| `metrics` | JSONB | final metrics, written once at the end |
| `current_epoch`, `total_epochs` | int | drives the progress bar |
| `error` | str \| None | |
| `created_by_id`, `created_at`, `started_at`, `finished_at` | | as on `Job` |

**`ModelVersion`** is the artifact, created only when a run reaches
`succeeded` or `stopped`: `id`, `training_run_id` (FK), `name`,
`task_type`, `storage_key`, `metrics`, `is_active`, `created_at`.

Folding both into one row was considered. It collapses under its own
NULLs: `is_active` is meaningless on a failed attempt, `storage_key` is
absent, and every consumer — starting with the Results screen's model
picker — would have to filter for "actually has weights" to learn what
kind of row it was looking at. Separating them means Results reads
`ModelVersion` and never learns that training exists.

`ModelVersion` drops three fields sketched in the design spec.
`base_model_id` and `dataset_id` are reachable through `training_run`.
`mlflow_run_id` is omitted because MLflow is not wired up in this phase —
adding the column later is cheaper than guessing its format now.

`TrainingRun.status` deliberately duplicates `Job.status`. `Job` has no
`stopped`, and widening an enum shared by every job type to serve one of
them is worse than a neighbouring enum.

A new `JobType.MODEL_TRAIN` and one Alembic migration covering both
tables.

## Training runs inside `ml-worker`, and Stop is cooperative

`ml-worker` runs `--pool=solo` — one task at a time, because CUDA cannot
be re-initialised in a forked child. Training joins that queue rather
than getting a container of its own, and two consequences follow that the
UI has to tell the truth about.

**Annotation stops while training runs.** SAM2/SAM3 predict and track
jobs queue behind the run and wait, for however many hours it lasts. On a
single-GPU host this is the honest trade: a separate `training-worker`
would give real parallelism, but it would put two consumers on one 8 GB
card, and `WORKER_VRAM_FRACTION = 0.8` was calculated for one. That is
the configuration this host has already hard-rebooted under. A queued job
showing `pending` is a visible cost; a host reset is not.

**Stop cannot be immediate.** A `solo` worker runs its task in the main
thread, so `revoke(terminate=True)` means SIGTERM to the whole container.
Instead `POST /training/runs/{id}/stop` sets `stop_requested`, and the
adapter checks it at each epoch boundary. The UI says so in as many
words — "stops after the current epoch" — rather than implying a button
that bites instantly.

A stopped run keeps its weights: Ultralytics has already written
`last.pt` by the epoch boundary. Such a run produces a real
`ModelVersion` and is recorded as `stopped`, not `failed`.

## The adapter interface is shaped for hand-written loops

The reference platform trained RT-DETRv2, DINOv2 and ConvNeXt with
hand-written PyTorch loops and only YOLO with Ultralytics. An interface
modelled on `YOLO.train()` would not fit three of those four, so the
interface hands control *to* the adapter and receives callbacks back:

```python
# ml-worker/app/training_adapter.py
@dataclass
class TrainingRequest:
    dataset_dir: Path        # the unpacked export
    task_type: str
    base_model: str
    config: dict
    output_dir: Path

@dataclass
class TrainingResult:
    weights_path: Path
    metrics: dict

class TrainingAdapter(Protocol):
    def train(
        self,
        request: TrainingRequest,
        on_log: Callable[[str], None],         # one raw line
        on_epoch: Callable[[int, int], None],  # (epoch, total)
        should_stop: Callable[[], bool],       # polled at epoch boundaries
    ) -> TrainingResult: ...
```

A hand-written loop calls these from inside its own `for epoch in ...`;
Ultralytics calls them from `on_train_epoch_end`. Both fit without
contortion. `should_stop` is a pull rather than a push because the worker
cannot interrupt someone else's loop from outside — but the loop can ask.

`UltralyticsYoloAdapter` implements it over `YOLO(base_model).train(...)`,
subscribing to `on_train_epoch_end` for epochs, capturing stdout for raw
lines, and setting `trainer.stop = True` when `should_stop()` returns
true. `ultralytics` is added to `ml-worker/pyproject.toml`, where it is
not yet a dependency.

The worker task `model_train(job_id)` follows the shape of the existing
tasks: download the dataset's export archive from MinIO into a temporary
directory, unpack, call the adapter, upload the weights back, create the
`ModelVersion`. Log lines accumulate in a buffer and flush on the cadence
above; `should_stop` reads `stop_requested` from the database at each
epoch boundary.

Training therefore requires an **already-exported** dataset. Rather than
inventing a second path that exports on demand, the dataset picker lists
only datasets with a finished archive, and says "export it first" for the
rest.

## API

All under `/training`, following the existing routers' shape.

| method | path | purpose |
|---|---|---|
| `POST` | `/training/runs` | create `TrainingRun` + `Job`, `send_task("model_train")`; body: `dataset_id`, `base_model`, `config` |
| `GET` | `/training/runs` | history list, filterable by status |
| `GET` | `/training/runs/{id}` | status, epoch, metrics — what the right column polls |
| `GET` | `/training/runs/{id}/log` | tail past `offset`, returns the new offset |
| `POST` | `/training/runs/{id}/stop` | sets `stop_requested`; 409 unless the run is `running` |
| `GET` | `/training/models` | `ModelVersion` list for the table and, later, Results |
| `GET` | `/training/models/{id}/download` | presigned URL for the weights |
| `DELETE` | `/training/models/{id}` | delete the version and its object |

`POST /training/runs` validates that the dataset exists and is exported,
that `epochs` and `batch` are within sane bounds, and **refuses with 409
when a run is already `running`**. Under `--pool=solo` a second run would
merely queue, but a refusal explains itself where a silent `pending` does
not.

`openapi.json` must be regenerated afterwards
(`cd backend && PYTHONPATH=. uv run python scripts/export_openapi.py`) or
the frontend's `generate-api` hook will not see the new types.

## The screen

`frontend/src/features/training/TrainPage.tsx`, route `/train`, a header
entry between Datasets and Settings. The layout is the one already
approved in the UI/UX spec:

- **Tabs by model family.** One for now — YOLO. The tab strip exists
  without pretending there are others; the second appears with the second
  adapter.
- **Left column, the config form:** Dataset (exported ones only), Base
  model, Epochs, Batch, a collapsed "Advanced" section, "Start training".
- **Right column, live status:** status badge, an epoch progress bar,
  "Epoch 7 / 50", a monospace log pane that follows the tail, and "Stop"
  while running — labelled so its epoch-boundary delay is not a surprise.
- **Below, the `ModelVersion` table:** name, type, headline metric,
  actions Info / Download / Delete.

Polling runs on one 2-second tick that fetches status and the log tail
together, and stops once the run reaches a terminal status.

## Testing

TDD per CLAUDE.md, layer by layer:

- **backend** — service tests for run creation, the second-`running`
  refusal, the unexported-dataset refusal, `stop_requested`, and
  `ModelVersion` creation; router tests through `TestClient`.
- **ml-worker** — adapter tests against a fake trainer, asserting that
  `on_log`/`on_epoch` fire and that `should_stop` genuinely ends the run;
  task tests with the adapter mocked, following the existing
  `test_tasks_*.py`. These run via `docker cp` plus
  `docker compose exec` — the image does not copy `tests/`, and the host
  `.venv` has no torch.
- **frontend** — `TrainPage` against a mocked `apiClient`: form render,
  polling, Stop appearing while running.
- **a real browser pass against the running stack.** This project has
  three times shipped bugs that every unit test passed over.

## Out of scope

MLflow tracking, a second adapter, parsing the log into metric charts,
and resuming an interrupted run.
