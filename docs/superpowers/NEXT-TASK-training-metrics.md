# Task brief: trainer-agnostic training metrics

**Status:** DONE (2026-08-21), except the real training run and the MinIO
deletion check, which need GPU and destructive-delete access. Written
2026-08-20 at the end of the session that built the Train screen.

- Design: [specs/2026-08-21-training-metrics-design.md](specs/2026-08-21-training-metrics-design.md)
- Plan: [plans/2026-08-21-training-metrics.md](plans/2026-08-21-training-metrics.md)
- Outcome and what remains unverified: ROADMAP.md, "Phase 2b:
  Trainer-agnostic training metrics".

Kept as the problem statement the design argues from. Do not start new work
from this file.

**Start by invoking `superpowers:brainstorming`.** This is architectural
work — a new persisted artifact, a widened adapter contract, new API
surface and a new screen — so it takes the full path: questions, then a
design doc in `docs/superpowers/specs/`, then `superpowers:writing-plans`.
Do not start coding from this file; it is the problem statement, not the
design.

## What the user asked for

> "В YOLO эти метрики очень здорово собираются. Надо бы иметь к ним доступ
> из таблицы. Когда будем использовать что-то другое (DETR и тд) — у них
> будет другой метод сбора метрик. Но для пользователя это должно быть все
> равно."

And, on scope: *"не надо минимум — мы не спешим, делаем как следует."* So
this is not a "just upload results.csv" task. Design the abstraction
properly the first time.

## Where things stand

The Train screen shipped 2026-08-20 (ROADMAP Phase 2b, commits `566ee3b`
onward). Training works end to end against the real stack: detection,
segmentation and classification all train, weights land in MinIO, the raw
log streams live to the screen.

**What is captured today:** `ml-worker/app/ultralytics_yolo_adapter.py`
takes `results.results_dict` at the end of a run and keeps the numeric
entries. That dict reaches `TrainingRun.metrics` and is copied onto
`ModelVersion.metrics` (both plain JSONB columns). The models table on
`/train` shows exactly one number from it — mAP50 for detection, top-1
accuracy for classification.

Real examples from the user's own runs:

```json
{"metrics/precision(B)": 0.767, "metrics/recall(B)": 0.538,
 "metrics/mAP50(B)": 0.657, "metrics/mAP50-95(B)": 0.446, "fitness": 0.446}

{"metrics/accuracy_top1": 0.989, "metrics/accuracy_top5": 1.0, "fitness": 0.995}
```

**What is thrown away.** Ultralytics writes a full run directory that
lives in a `tempfile.TemporaryDirectory` and is deleted when the task
returns. Only `weights/best.pt` is uploaded. Lost every run:

- `results.csv` — per-epoch history (losses, metrics, learning rate)
- `confusion_matrix.png` / `confusion_matrix_normalized.png`
- PR / F1 / P / R curves
- `results.png`, `labels.jpg`
- `args.yaml`

The metrics objects also expose more than `results_dict`: `DetMetrics` has
`class_result` (per-class), `maps`, `curves_results`, `to_json()`;
`ClassifyMetrics` has `curves_results`, `to_json()`. Verified live in the
container at ultralytics 8.4.123.

## The design question that matters

Do **not** add a `map50` column, or an epochs table shaped like YOLO's CSV.
The reference platform trained with four different stacks (Ultralytics for
YOLO plus hand-written PyTorch loops for RT-DETRv2, DINOv2 and ConvNeXt —
see `medical_segmentation/utils/` in the sibling `segmentation` project),
and RT-DETR is explicitly planned here. A schema shaped around one
trainer's output will be rewritten by the second one.

The training **log** already faced this exact question and was
deliberately kept raw, for exactly this reason (ROADMAP Phase 2b,
2026-08-18). Metrics deserve a consistent answer, whatever that turns out
to be.

A starting hypothesis, to argue with rather than implement blindly — the
line probably falls between:

- **what the platform understands**: a small vocabulary every trainer can
  fill — one headline metric plus its label, and a per-epoch history as a
  list of `{epoch, ...values}` points. The adapter translates into it.
- **what the platform stores opaquely**: the trainer's own artifacts
  (`results.csv`, plots, `to_json()` output) in MinIO, attached to the
  `ModelVersion`, displayable and downloadable without the platform
  parsing them.
- **what the user sees**: one screen that looks the same regardless of
  trainer — headline metric in the table (already there), and behind the
  existing "Info" action a training curve, a confusion matrix and
  per-class numbers when the trainer supplied them; whatever is missing is
  simply absent, not an error.

Whether the headline/history vocabulary is worth having at all, versus
storing everything opaquely and letting the UI render what it recognises,
is a real question — settle it in brainstorming, do not assume the above.

## Things you must not break

- `TrainingAdapter` (`ml-worker/app/training_adapter.py`) is shaped for
  **hand-written PyTorch loops**, not for Ultralytics: `train(request,
  on_log, on_epoch, should_stop)`. `should_stop` is a pull, polled at epoch
  boundaries, because ml-worker runs `--pool=solo` and
  `revoke(terminate=True)` would SIGTERM the container. Any widening of the
  contract must stay implementable by a plain `for epoch in ...` loop.
- `_LogBuffer` in `ml-worker/app/tasks.py` holds a `threading.Lock` because
  `_ForwardingLogHandler.emit()` can call `on_log` from a non-training
  thread and a SQLAlchemy `Session` is not thread-safe. If a new callback
  writes to the database, it needs the same protection.
- Everything binary goes through `StorageService`. Note the ml-worker copy
  has only `download`/`upload`/`ensure_bucket` — no `delete`.
- **Deleting must stay symmetric.** `delete_model_version` removes the
  storage object before the row, and `delete_dataset` now does the same for
  export archives (`857760d`) after 174 MB of orphans accumulated. New
  artifacts must be deleted with their `ModelVersion`, or they will leak the
  same way.
- **Tests must not write to the real `endoscopy` database.** Use
  `import app.db as db_module` + `db_module.SessionLocal()`; the
  import-time form bypasses conftest's patching. See CLAUDE.md — this rule
  exists because nine files violated it and littered production.

## Useful context

- Spec for the Train screen: `docs/superpowers/specs/2026-08-19-train-screen-design.md`
- Plan: `docs/superpowers/plans/2026-08-19-train-screen.md`
- ROADMAP "Phase 2b: Train screen — DONE (2026-08-20)" carries the full
  deviation log, including why the log is raw and why training shares
  ml-worker's solo queue.
- The UI/UX spec (`docs/specs/2026-07-23-platform-ui-ux-design.md`)
  describes the Train screen's models table with an "Info" action that has
  never been implemented — this task is the natural place to define it.
  Read that spec before designing the screen, per CLAUDE.md.
- The GPU here is one RTX 2070 shared with the desktop and an active
  `ollama` service; the host has hard-rebooted under GPU pressure before.
  Nothing in this task should need the GPU beyond an ordinary short
  training run.

## Verification expectations

The user runs the real checks himself and has caught several defects that
passed every test — a 64 MB `/dev/shm` starving the DataLoader, an image
that never contained the training code, an export that wrote six classes
where the screen showed one. Give him something concrete to click, and
state plainly what was and was not verified.
