# Trainer-Agnostic Training Metrics Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Capture per-epoch history, per-class numbers, a confusion matrix and the trainer's own artifact files from every training run, and show them behind the models table's "Info" action in a way that looks identical whichever trainer produced them.

**Architecture:** The platform normalizes the *shape* of metrics (a headline number, a list of per-epoch points, per-class rows, a square matrix) and never the *key names* — the adapter hands over whatever its trainer calls things. History streams in during training through a widened `on_epoch` callback, so a run that dies mid-way keeps what it had. The trainer's own files (`results.csv`, plots, `args.yaml`) go to MinIO opaquely, deleted symmetrically with the `ModelVersion` that names them.

**Tech Stack:** Python 3.12, FastAPI, SQLAlchemy 2 (`Mapped`/`mapped_column`), Alembic, Celery, PostgreSQL JSONB, MinIO via `StorageService`, React 18 + TypeScript + Vite + Tailwind (dark only), Vitest + Testing Library, pytest.

**Spec:** `docs/superpowers/specs/2026-08-21-training-metrics-design.md`

## Global Constraints

- **Language:** English only in all committed content — code, comments, docstrings, UI copy. No Russian anywhere in the repository.
- **Object storage:** all binary media goes through `StorageService`. Never a direct filesystem path in domain code.
- **ml-worker's `StorageService` has only `download`/`upload`/`ensure_bucket`** — no `delete`. Deletion lives entirely in the backend.
- **Tests must never write to the real `endoscopy` database.** Use `import app.db as db_module` + `db_module.SessionLocal()`. Never `from app.db import SessionLocal`, which binds at import time and bypasses conftest's patching.
- **TDD:** every backend task and every frontend task with logic gets a failing test before the implementation.
- **UI theme:** dark only. Do not introduce light-background classes.
- **Git:** commit directly to `master` in the primary working directory. No branches, no worktrees.
- **API contract:** after any backend route/schema change, regenerate the committed OpenAPI document with `cd backend && PYTHONPATH=. uv run python scripts/export_openapi.py`, and verify with `git diff --stat openapi.json` that it actually changed. Never hand-edit anything under `frontend/src/shared/api/generated/`.
- **Deletion symmetry:** objects are deleted before the rows that name them; a missing object is logged and skipped, never allowed to block the endpoint.
- **ml-worker tests:** the image does not `COPY tests/`, and the host `.venv` lacks torch. Run them with `docker cp` + `docker compose exec`, using the interpreter at `/app/.venv/bin/python` (there is no `python` on the container's `PATH`).

---

### Task 1: Widen the adapter contract

**Files:**
- Modify: `ml-worker/app/training_adapter.py`
- Test: `ml-worker/tests/test_training_adapter.py`

**Interfaces:**
- Consumes: nothing.
- Produces: `on_epoch: Callable[[int, int, dict | None], None]`; `TrainingResult(weights_path, metrics, history, per_class, confusion, artifacts)` where `history: list[dict]`, `per_class: list[dict]`, `confusion: dict | None`, `artifacts: list[Path]`.

**Context for the implementer:** `TrainingAdapter` is deliberately shaped for hand-written PyTorch loops, not for Ultralytics — the reference platform trained three of its four models with plain `for epoch in ...` loops. The whole point of this task is that the widened contract stays implementable by such a loop. The existing `FakeLoopAdapter` in the test file is the guard on that property; keep it a plain loop.

- [ ] **Step 1: Write the failing test**

Add to `ml-worker/tests/test_training_adapter.py`. Note the existing `FakeLoopAdapter.train` must be updated to pass a third argument — do that as part of this step.

Change `FakeLoopAdapter.train`'s epoch call from `on_epoch(epoch, total)` to:

```python
            on_epoch(epoch, total, {"train/loss": 1.0 / epoch, "val/map50": 0.1 * epoch})
```

Update the two existing `on_epoch=lambda e, t: epochs.append((e, t))` call sites in this file to `on_epoch=lambda e, t, m=None: epochs.append((e, t))`.

Then add:

```python
class FakeSilentLoopAdapter:
    """A loop that computes no metrics -- the contract must accept None."""

    def train(self, request, on_log, on_epoch, should_stop):
        for epoch in range(1, request.config["epochs"] + 1):
            on_epoch(epoch, request.config["epochs"], None)
        return TrainingResult(weights_path=request.output_dir / "last.pt")


def test_adapter_reports_per_epoch_metrics(tmp_path):
    points: list[tuple[int, dict | None]] = []
    adapter: TrainingAdapter = FakeLoopAdapter()

    adapter.train(
        TrainingRequest(
            dataset_dir=tmp_path / "ds",
            task_type="detection",
            base_model="yolo11n.pt",
            config={"epochs": 2},
            output_dir=tmp_path,
        ),
        on_log=lambda line: None,
        on_epoch=lambda e, t, m: points.append((e, m)),
        should_stop=lambda: False,
    )

    assert [e for e, _ in points] == [1, 2]
    assert points[0][1] == {"train/loss": 1.0, "val/map50": 0.1}


def test_a_loop_that_computes_nothing_passes_none(tmp_path):
    points: list[dict | None] = []
    adapter: TrainingAdapter = FakeSilentLoopAdapter()

    adapter.train(
        TrainingRequest(
            dataset_dir=tmp_path / "ds",
            task_type="detection",
            base_model="yolo11n.pt",
            config={"epochs": 2},
            output_dir=tmp_path,
        ),
        on_log=lambda line: None,
        on_epoch=lambda e, t, m: points.append(m),
        should_stop=lambda: False,
    )

    assert points == [None, None]


def test_result_carries_optional_metric_collections(tmp_path):
    result = TrainingResult(weights_path=tmp_path / "best.pt")

    assert result.history == []
    assert result.per_class == []
    assert result.confusion is None
    assert result.artifacts == []

    filled = TrainingResult(
        weights_path=tmp_path / "best.pt",
        history=[{"epoch": 1, "loss": 0.5}],
        per_class=[{"class": "polyp", "mAP50": 0.7}],
        confusion={"labels": ["polyp", "background"], "matrix": [[5, 1], [2, 0]]},
        artifacts=[tmp_path / "results.csv"],
    )

    assert filled.confusion["labels"][-1] == "background"
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd /mnt/work-disk/Documents/Dev/endoscopy-platform
docker cp ml-worker/tests endoscopy-platform-ml-worker-1:/app/tests
docker compose exec -T ml-worker /app/.venv/bin/python -m pytest tests/test_training_adapter.py -v
```

Expected: FAIL — `TypeError: __init__() got an unexpected keyword argument 'history'`.

- [ ] **Step 3: Write minimal implementation**

In `ml-worker/app/training_adapter.py`, add `Any` to the typing import, then replace the `TrainingResult` dataclass and the `on_epoch` annotation:

```python
@dataclass
class TrainingResult:
    weights_path: Path
    metrics: dict = field(default_factory=dict)
    # Per-epoch points, [{"epoch": 1, <the trainer's own keys>}, ...].
    # Redundant with what on_epoch already delivered; it exists for a
    # trainer that can only produce its history at the end. If both are
    # non-empty this one wins -- it is the trainer's final word.
    history: list[dict] = field(default_factory=list)
    # [{"class": "polyp", <numbers>}, ...]. "class" is required; every
    # other key is the trainer's own.
    per_class: list[dict] = field(default_factory=list)
    # {"labels": [...], "matrix": [[int, ...], ...]}. For detection the
    # labels end with a literal "background": misses into background are
    # real data, not padding to trim.
    confusion: dict | None = None
    # Files the trainer wrote that the platform stores without parsing.
    artifacts: list[Path] = field(default_factory=list)
```

And in the `TrainingAdapter` Protocol:

```python
        on_epoch: Callable[[int, int, dict | None], None],
```

Extend the module docstring to say why names are not normalized:

```
The third argument to on_epoch is the trainer's own flat dict of metrics
for that epoch, or None if it computes none. Key names are deliberately
NOT normalized: mapping metrics/mAP50(B) and map50 onto one canonical
name is the schema-shaped-around-one-trainer this interface exists to
avoid. The platform understands the shape, never the vocabulary.
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
docker cp ml-worker/tests endoscopy-platform-ml-worker-1:/app/tests
docker cp ml-worker/app endoscopy-platform-ml-worker-1:/app/app
docker compose exec -T ml-worker /app/.venv/bin/python -m pytest tests/test_training_adapter.py -v
```

Expected: PASS, all tests including the two pre-existing ones.

- [ ] **Step 5: Commit**

```bash
git add ml-worker/app/training_adapter.py ml-worker/tests/test_training_adapter.py
git commit -m "feat: widen the training adapter contract for metrics"
```

---

### Task 2: Ultralytics adapter fills the new fields

**Files:**
- Modify: `ml-worker/app/ultralytics_yolo_adapter.py`
- Test: `ml-worker/tests/test_ultralytics_yolo_adapter.py`

**Interfaces:**
- Consumes: `TrainingResult(...)` and the three-argument `on_epoch` from Task 1.
- Produces: `UltralyticsYoloAdapter.train(...)` returning a `TrainingResult` whose `per_class`, `confusion` and `artifacts` are populated; module-level helpers `_per_class_rows(results) -> list[dict]`, `_confusion_from(results, task_type) -> dict | None`, `_collect_artifacts(output_dir) -> list[Path]`.

**Context for the implementer:** These facts were verified live in the container at ultralytics 8.4.123 — do not re-derive them:

- The confusion matrix is an **instance attribute** the validator sets (`self.metrics.confusion_matrix = self.confusion_matrix`, `ultralytics/models/yolo/detect/val.py:229`), which is why it is absent from `dir(DetMetrics)`. Reach it as `getattr(results, "confusion_matrix", None)`.
- `ConfusionMatrix.matrix` is `(nc+1, nc+1)` for detection/segmentation and `(nc, nc)` for classification; the extra row/column is `background`.
- **Do not use `ConfusionMatrix.summary()`.** It runs names through `re.sub(r"[^a-zA-Z0-9_]", "_", name)` and de-duplicates collisions, so `bad_preparation (colono)` becomes `bad_preparation__colono_`. Read the raw `.matrix` and `.names`.
- `results.summary()` returns per-class rows keyed `Class`, `Images`, `Instances`, `Box-P`, `Box-R`, `Box-F1`, `mAP50`, `mAP50-95`.
- The test file's `_FakeTrainer` has **no** `.metrics` attribute, so the per-epoch read must be defensive.

Every new block must be wrapped so that a shape change in a future Ultralytics release degrades to "this data is absent" rather than failing a training run that already produced weights. Weights are the valuable output.

- [ ] **Step 1: Write the failing test**

In `ml-worker/tests/test_ultralytics_yolo_adapter.py`, first update all five existing `on_epoch=lambda e, t: None` call sites to `on_epoch=lambda e, t, m=None: None`.

Then give `_FakeResults` per-class and confusion data, and add a fake matrix class:

```python
class _FakeConfusionMatrix:
    def __init__(self):
        import numpy as np

        self.names = {0: "polyp", 1: "erosion"}
        # (nc+1, nc+1): the trailing row/column is background.
        self.matrix = np.array([[8.0, 1.0, 2.0], [0.0, 5.0, 1.0], [3.0, 2.0, 0.0]])


class _FakeResults:
    results_dict = {"metrics/mAP50-95(B)": 0.42, "fitness": 0.5}
    confusion_matrix = _FakeConfusionMatrix()

    def summary(self):
        return [
            {"Class": "polyp", "Images": 10, "Instances": 12, "Box-P": 0.8, "mAP50": 0.7},
            {"Class": "erosion", "Images": 6, "Instances": 7, "Box-P": 0.6, "mAP50": 0.5},
        ]
```

Add these tests:

```python
def test_per_class_rows_keep_the_trainers_own_keys(tmp_path):
    from app.ultralytics_yolo_adapter import _per_class_rows

    rows = _per_class_rows(_FakeResults())

    assert rows[0]["class"] == "polyp"
    assert rows[0]["mAP50"] == 0.7
    assert rows[0]["Box-P"] == 0.8
    assert "Class" not in rows[0]


def test_confusion_matrix_appends_background_for_detection():
    from app.ultralytics_yolo_adapter import _confusion_from

    confusion = _confusion_from(_FakeResults(), "detection")

    assert confusion["labels"] == ["polyp", "erosion", "background"]
    assert confusion["matrix"] == [[8, 1, 2], [0, 5, 1], [3, 2, 0]]


def test_confusion_matrix_has_no_background_for_classification():
    from app.ultralytics_yolo_adapter import _confusion_from

    class _ClsResults:
        class confusion_matrix:
            import numpy as _np

            names = {0: "clean", 1: "dirty"}
            matrix = _np.array([[4.0, 1.0], [2.0, 6.0]])

    confusion = _confusion_from(_ClsResults(), "classification")

    assert confusion["labels"] == ["clean", "dirty"]
    assert confusion["matrix"] == [[4, 1], [2, 6]]


def test_confusion_is_none_when_the_trainer_supplies_none():
    from app.ultralytics_yolo_adapter import _confusion_from

    class _Bare:
        pass

    assert _confusion_from(_Bare(), "detection") is None


def test_artifacts_collect_known_extensions_and_skip_large_files(tmp_path):
    from app.ultralytics_yolo_adapter import _collect_artifacts

    run = tmp_path / "run"
    (run / "weights").mkdir(parents=True)
    (run / "results.csv").write_text("epoch,loss\n1,0.5\n")
    (run / "args.yaml").write_text("epochs: 1\n")
    (run / "confusion_matrix.png").write_bytes(b"\x89PNG fake")
    (run / "weights" / "best.pt").write_bytes(b"weights are not artifacts")
    (run / "huge.png").write_bytes(b"x" * (11 * 1024 * 1024))

    names = sorted(p.name for p in _collect_artifacts(tmp_path))

    assert names == ["args.yaml", "confusion_matrix.png", "results.csv"]


def test_train_reports_metrics_per_epoch_and_returns_collections(tmp_path):
    points: list[tuple[int, dict | None]] = []
    weights_dir = tmp_path / "out" / "run" / "weights"
    fake_yolo = _make_fake_yolo(
        epochs=2,
        weights_dir=weights_dir,
        log_lines_via_print=[],
        log_lines_via_logger=[],
    )
    (tmp_path / "out").mkdir(exist_ok=True)
    (tmp_path / "out" / "results.csv").write_text("epoch,loss\n1,0.5\n")

    adapter = UltralyticsYoloAdapter()
    request = TrainingRequest(
        dataset_dir=tmp_path / "ds",
        task_type="detection",
        base_model="yolo11n.pt",
        config={"epochs": 2},
        output_dir=tmp_path / "out",
    )

    with mock.patch("app.ultralytics_yolo_adapter.YOLO", fake_yolo):
        result = adapter.train(
            request,
            on_log=lambda line: None,
            on_epoch=lambda e, t, m: points.append((e, m)),
            should_stop=lambda: False,
        )

    # The fake trainer has no .metrics attribute, so the adapter must
    # degrade to None rather than raising.
    assert [e for e, _ in points] == [1, 2]
    assert result.per_class[0]["class"] == "polyp"
    assert result.confusion["labels"][-1] == "background"
    assert [p.name for p in result.artifacts] == ["results.csv"]
```

If the existing test file does not already import `mock` and `UltralyticsYoloAdapter`/`TrainingRequest`, add those imports.

- [ ] **Step 2: Run test to verify it fails**

```bash
docker cp ml-worker/tests endoscopy-platform-ml-worker-1:/app/tests
docker compose exec -T ml-worker /app/.venv/bin/python -m pytest tests/test_ultralytics_yolo_adapter.py -v
```

Expected: FAIL — `ImportError: cannot import name '_per_class_rows'`.

- [ ] **Step 3: Write minimal implementation**

Add to `ml-worker/app/ultralytics_yolo_adapter.py`, above the class:

```python
# Files the trainer writes that are worth keeping but not worth parsing.
# The size cap keeps a forgotten checkpoint from riding along as an
# "artifact"; weights already have their own upload path.
_ARTIFACT_SUFFIXES = {".csv", ".yaml", ".png", ".jpg", ".json"}
_ARTIFACT_MAX_BYTES = 10 * 1024 * 1024


def _per_class_rows(results) -> list[dict]:
    """Per-class numbers in the trainer's own vocabulary.

    Only the `Class` key is renamed, to the `class` key the platform
    requires; every other column stays exactly as Ultralytics named it,
    because normalizing names is what makes a schema fit one trainer.
    """
    summary = getattr(results, "summary", None)
    if not callable(summary):
        return []
    try:
        rows = summary()
    except Exception:  # noqa: BLE001 -- metrics must never fail a finished run
        return []
    out = []
    for row in rows or []:
        if not isinstance(row, dict):
            continue
        converted = {"class": str(row.get("Class", ""))}
        for key, value in row.items():
            if key != "Class" and isinstance(value, (int, float)):
                converted[str(key)] = float(value)
        out.append(converted)
    return out


def _confusion_from(results, task_type: str) -> dict | None:
    """The confusion matrix as plain numbers plus honest class names.

    Read off `.matrix`/`.names` rather than ConfusionMatrix.summary(),
    which sanitizes names through [^a-zA-Z0-9_] -> _ and de-duplicates
    collisions -- lossy for display, since a real label like
    "bad_preparation (colono)" would come back mangled.

    Detection and segmentation matrices are (nc+1, nc+1); the trailing
    row/column counts predictions against background, which is kept as an
    explicit label because misses into background are real data.
    """
    matrix_holder = getattr(results, "confusion_matrix", None)
    if matrix_holder is None:
        return None
    try:
        raw = matrix_holder.matrix
        names = matrix_holder.names
        labels = [str(names[key]) for key in sorted(names)]
        if len(raw) == len(labels) + 1:
            labels = [*labels, "background"]
        return {
            "labels": labels,
            "matrix": [[int(round(float(cell))) for cell in row] for row in raw],
        }
    except Exception:  # noqa: BLE001 -- metrics must never fail a finished run
        return None


def _collect_artifacts(output_dir: Path) -> list[Path]:
    """The trainer's own files, stored without being parsed."""
    if not output_dir.exists():
        return []
    found = []
    for path in sorted(output_dir.rglob("*")):
        if not path.is_file() or path.suffix.lower() not in _ARTIFACT_SUFFIXES:
            continue
        if path.stat().st_size > _ARTIFACT_MAX_BYTES:
            continue
        found.append(path)
    return found
```

In `_on_epoch_end`, replace the `on_epoch(epoch, total_epochs)` call with:

```python
            # trainer.metrics is a flat dict of this epoch's validation
            # numbers. Read defensively: it is absent before the first
            # validation runs, and its shape is not a contract.
            epoch_metrics = getattr(trainer, "metrics", None)
            on_epoch(
                epoch,
                total_epochs,
                {str(k): float(v) for k, v in epoch_metrics.items() if isinstance(v, (int, float))}
                if isinstance(epoch_metrics, dict)
                else None,
            )
```

And replace the final `return TrainingResult(...)` with:

```python
        return TrainingResult(
            weights_path=weights_path,
            metrics=metrics,
            per_class=_per_class_rows(results),
            confusion=_confusion_from(results, request.task_type),
            artifacts=_collect_artifacts(request.output_dir),
        )
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
docker cp ml-worker/tests endoscopy-platform-ml-worker-1:/app/tests
docker cp ml-worker/app endoscopy-platform-ml-worker-1:/app/app
docker compose exec -T ml-worker /app/.venv/bin/python -m pytest tests/test_ultralytics_yolo_adapter.py -v
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add ml-worker/app/ultralytics_yolo_adapter.py ml-worker/tests/test_ultralytics_yolo_adapter.py
git commit -m "feat: capture per-class, confusion and artifacts from Ultralytics"
```

---

### Task 3: Schema columns and migration

**Files:**
- Modify: `backend/app/training/models.py`
- Modify: `ml-worker/app/models.py`
- Create: `backend/alembic/versions/<generated>_add_training_metrics_columns.py`
- Test: `backend/tests/test_training_models.py`

**Interfaces:**
- Consumes: nothing.
- Produces: `TrainingRun.metrics_history: list`; `ModelVersion.per_class_metrics: list`, `ModelVersion.confusion_matrix: dict | None`, `ModelVersion.artifact_keys: list`.

**Context for the implementer:** `ml-worker/app/models.py` carries its own copy of these ORM classes — the worker writes to the same tables through a separate declarative base. Both copies must gain the columns or the worker will fail to write them. The current migration head is `b1c2d3e4f5a6`.

History lives on `TrainingRun` rather than `ModelVersion` on purpose: a run that fails at epoch 12 has no `ModelVersion` at all, and those 12 points are the most valuable thing it left behind.

Do not widen the existing `metrics` column into a nested object — it is already read by the models table and the frontend, and changing its shape silently breaks a working reader.

- [ ] **Step 1: Write the failing test**

Add to `backend/tests/test_training_models.py`:

```python
def test_training_run_carries_metrics_history():
    run = TrainingRun(
        dataset_id=1,
        adapter="ultralytics_yolo",
        base_model="yolo11n.pt",
        task_type=TaskType.DETECTION,
        total_epochs=3,
        created_by_id=1,
        metrics_history=[{"epoch": 1, "train/loss": 0.5}],
    )

    assert run.metrics_history[0]["epoch"] == 1


def test_model_version_carries_per_class_confusion_and_artifacts():
    version = ModelVersion(
        training_run_id=1,
        name="yolo11n-run1",
        task_type=TaskType.DETECTION,
        storage_key="models/1/best.pt",
        per_class_metrics=[{"class": "polyp", "mAP50": 0.7}],
        confusion_matrix={"labels": ["polyp", "background"], "matrix": [[5, 1], [2, 0]]},
        artifact_keys=["models/1/artifacts/results.csv"],
    )

    assert version.per_class_metrics[0]["class"] == "polyp"
    assert version.confusion_matrix["labels"][-1] == "background"
    assert version.artifact_keys == ["models/1/artifacts/results.csv"]
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd /mnt/work-disk/Documents/Dev/endoscopy-platform/backend
uv run pytest tests/test_training_models.py -v
```

Expected: FAIL — `TypeError: 'metrics_history' is an invalid keyword argument for TrainingRun`.

- [ ] **Step 3: Write minimal implementation**

In `backend/app/training/models.py`, add to `TrainingRun`, after `metrics`:

```python
    # Per-epoch points, appended as training runs. Lives on the run rather
    # than the model because a run that dies at epoch 12 has no
    # ModelVersion at all, and those 12 points are what it left behind.
    metrics_history: Mapped[list] = mapped_column(JSON, default=list)
```

And to `ModelVersion`, after `metrics`:

```python
    # Per-class rows in the trainer's own vocabulary, [{"class": ...}, ...].
    per_class_metrics: Mapped[list] = mapped_column(JSON, default=list)
    # {"labels": [...], "matrix": [[int, ...]]} -- numbers, not a picture,
    # so a trainer that ships no PNG renders the same as one that does.
    confusion_matrix: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    # Keys of the trainer's own files in object storage. Deleted with this
    # row -- see delete_model_version.
    artifact_keys: Mapped[list] = mapped_column(JSON, default=list)
```

Mirror all four columns into the matching classes in `ml-worker/app/models.py`, keeping that file's existing import style.

- [ ] **Step 4: Run test to verify it passes**

```bash
cd /mnt/work-disk/Documents/Dev/endoscopy-platform/backend
uv run pytest tests/test_training_models.py -v
```

Expected: PASS.

- [ ] **Step 5: Generate and review the migration**

```bash
cd /mnt/work-disk/Documents/Dev/endoscopy-platform/backend
uv run alembic revision --autogenerate -m "add training metrics columns"
```

Open the generated file. It must add exactly four columns and nothing else — autogenerate sometimes emits unrelated drift. Delete anything that is not one of the four `op.add_column` calls. Because existing rows must not be null for the non-nullable list columns, each needs a server default at creation and then removal, so edit `upgrade()` to read:

```python
def upgrade() -> None:
    op.add_column(
        "training_runs",
        sa.Column("metrics_history", sa.JSON(), nullable=False, server_default="[]"),
    )
    op.add_column(
        "model_versions",
        sa.Column("per_class_metrics", sa.JSON(), nullable=False, server_default="[]"),
    )
    op.add_column("model_versions", sa.Column("confusion_matrix", sa.JSON(), nullable=True))
    op.add_column(
        "model_versions",
        sa.Column("artifact_keys", sa.JSON(), nullable=False, server_default="[]"),
    )
    # The server default existed only to backfill existing rows; the
    # application always supplies a value.
    op.alter_column("training_runs", "metrics_history", server_default=None)
    op.alter_column("model_versions", "per_class_metrics", server_default=None)
    op.alter_column("model_versions", "artifact_keys", server_default=None)


def downgrade() -> None:
    op.drop_column("model_versions", "artifact_keys")
    op.drop_column("model_versions", "confusion_matrix")
    op.drop_column("model_versions", "per_class_metrics")
    op.drop_column("training_runs", "metrics_history")
```

- [ ] **Step 6: Apply the migration and verify the columns exist**

```bash
cd /mnt/work-disk/Documents/Dev/endoscopy-platform/backend
uv run alembic upgrade head
docker compose exec -T postgres psql -U endoscopy -c "\d model_versions" | grep -E "per_class_metrics|confusion_matrix|artifact_keys"
docker compose exec -T postgres psql -U endoscopy -c "\d training_runs" | grep metrics_history
```

Expected: all four columns listed.

- [ ] **Step 7: Commit**

```bash
cd /mnt/work-disk/Documents/Dev/endoscopy-platform
git add backend/app/training/models.py ml-worker/app/models.py backend/alembic/versions/ backend/tests/test_training_models.py
git commit -m "feat: add training metrics columns"
```

---

### Task 4: The worker persists history, collections and artifacts

**Files:**
- Modify: `ml-worker/app/tasks.py:710-880`
- Test: `ml-worker/tests/test_tasks_training.py`

**Interfaces:**
- Consumes: the three-argument `on_epoch` and widened `TrainingResult` (Tasks 1–2); the four columns (Task 3).
- Produces: `models/<run_id>/artifacts/<filename>` storage keys recorded in `ModelVersion.artifact_keys`.

**Context for the implementer — read this before writing code.** `_LogBuffer` holds a `threading.Lock` for a real reason: `_ForwardingLogHandler.emit()` can call back from a DataLoader or callback thread, and a SQLAlchemy `Session` is not thread-safe. `_on_epoch` already commits that same session, and the history append happens inside it.

**Do not introduce a second, independent lock.** Two locks around one session is a deadlock waiting to happen. Route the history write through the buffer's existing lock by giving `_LogBuffer` an explicit method for it, as below.

- [ ] **Step 1: Write the failing test**

In `ml-worker/tests/test_tasks_training.py`, update the two existing stub adapters' `on_epoch(epoch, total)` calls to `on_epoch(epoch, total, {"train/loss": 0.5})`, then add:

```python
def test_history_accumulates_during_training(session, make_job_and_run):
    class _ReportingAdapter:
        def train(self, request, on_log, on_epoch, should_stop):
            for epoch in (1, 2, 3):
                on_epoch(epoch, 3, {"train/loss": 1.0 / epoch})
            weights = request.output_dir / "best.pt"
            weights.write_bytes(b"w")
            artifact = request.output_dir / "results.csv"
            artifact.write_text("epoch,loss\n")
            return TrainingResult(
                weights_path=weights,
                metrics={"fitness": 0.5},
                per_class=[{"class": "polyp", "mAP50": 0.7}],
                confusion={"labels": ["polyp", "background"], "matrix": [[4, 1], [0, 2]]},
                artifacts=[artifact],
            )

    job, run = make_job_and_run()
    model_train(job.id, adapter=_ReportingAdapter())
    session.refresh(run)

    assert [p["epoch"] for p in run.metrics_history] == [1, 2, 3]
    assert run.metrics_history[0]["train/loss"] == 1.0

    version = session.query(ModelVersion).filter_by(training_run_id=run.id).one()
    assert version.per_class_metrics[0]["class"] == "polyp"
    assert version.confusion_matrix["labels"][-1] == "background"
    assert version.artifact_keys == [f"models/{run.id}/artifacts/results.csv"]


def test_a_silent_adapter_leaves_history_empty(session, make_job_and_run):
    class _SilentAdapter:
        def train(self, request, on_log, on_epoch, should_stop):
            on_epoch(1, 1, None)
            weights = request.output_dir / "best.pt"
            weights.write_bytes(b"w")
            return TrainingResult(weights_path=weights)

    job, run = make_job_and_run()
    model_train(job.id, adapter=_SilentAdapter())
    session.refresh(run)

    # Not [{"epoch": 1}] -- a point with no metrics would render a chart
    # with no series.
    assert run.metrics_history == []


def test_history_survives_a_run_that_fails_midway(session, make_job_and_run):
    class _CrashingAdapter:
        def train(self, request, on_log, on_epoch, should_stop):
            on_epoch(1, 5, {"train/loss": 0.9})
            on_epoch(2, 5, {"train/loss": 0.7})
            raise RuntimeError("CUDA out of memory")

    job, run = make_job_and_run()
    model_train(job.id, adapter=_CrashingAdapter())
    session.refresh(run)

    assert run.status == TrainingRunStatus.FAILED
    assert [p["epoch"] for p in run.metrics_history] == [1, 2]
```

If `make_job_and_run` does not already exist as a fixture in this file, build the `Job`/`TrainingRun` rows inline exactly as the existing tests in this file do — read them first and follow that pattern rather than inventing a new one.

- [ ] **Step 2: Run test to verify it fails**

```bash
cd /mnt/work-disk/Documents/Dev/endoscopy-platform
docker cp ml-worker/tests endoscopy-platform-ml-worker-1:/app/tests
docker compose exec -T ml-worker /app/.venv/bin/python -m pytest tests/test_tasks_training.py -v
```

Expected: FAIL — `TypeError: _on_epoch() takes 2 positional arguments but 3 were given`.

- [ ] **Step 3: Write minimal implementation**

Add a method to `_LogBuffer`, after `flush()`:

```python
    def append_history(self, point: dict) -> None:
        """Append one per-epoch point under this buffer's lock.

        Deliberately a method here rather than a separate helper with its
        own lock: the state needing protection is this session, and two
        independent locks around one session is a deadlock waiting to
        happen. Reassigns rather than mutating in place -- SQLAlchemy does
        not track in-place mutation of a plain JSON column.
        """
        with self._lock:
            self._run.metrics_history = [*(self._run.metrics_history or []), point]
            self._session.commit()
```

Change `_on_epoch`'s signature and body:

```python
    def _on_epoch(epoch: int, total: int, metrics: dict | None = None) -> None:
        buffer.flush()
        run.current_epoch = epoch
        run.total_epochs = total
        job.progress = int((epoch / total) * 100) if total else 0
        _record_vram_usage(job)
        session.commit()
        # A trainer that computes nothing contributes no point at all --
        # not {"epoch": n} with no values, which would render a chart with
        # no series.
        if metrics:
            buffer.append_history({"epoch": epoch, **metrics})
```

In the success path, upload the artifacts inside the `with tempfile.TemporaryDirectory()` block, immediately after the weights upload (they live in the temp directory and vanish when it closes):

```python
            artifact_keys = []
            for artifact in result.artifacts:
                artifact_path = Path(artifact)
                if not artifact_path.exists():
                    continue
                artifact_key = f"models/{run.id}/artifacts/{artifact_path.name}"
                storage.upload(
                    artifact_key,
                    artifact_path.read_bytes(),
                    "application/octet-stream",
                )
                artifact_keys.append(artifact_key)
```

Extend the `ModelVersion(...)` construction with:

```python
            per_class_metrics=result.per_class,
            confusion_matrix=result.confusion,
            artifact_keys=artifact_keys,
```

And after `run.metrics = result.metrics`, honour the spec's precedence rule:

```python
        # A trainer that fills history only at the end wins over what
        # on_epoch accumulated: it is that trainer's final word.
        if result.history:
            run.metrics_history = result.history
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
docker cp ml-worker/tests endoscopy-platform-ml-worker-1:/app/tests
docker cp ml-worker/app endoscopy-platform-ml-worker-1:/app/app
docker compose exec -T ml-worker /app/.venv/bin/python -m pytest tests/test_tasks_training.py -v
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add ml-worker/app/tasks.py ml-worker/tests/test_tasks_training.py
git commit -m "feat: persist training history, collections and artifacts"
```

---

### Task 5: Symmetric deletion of artifacts

**Files:**
- Modify: `backend/app/training/service.py` (`delete_model_version`)
- Modify: `backend/app/datasets/router.py` (the `delete_dataset` cascade)
- Test: `backend/tests/test_training_api.py`

**Interfaces:**
- Consumes: `ModelVersion.artifact_keys` (Task 3).
- Produces: `delete_model_version(session, storage, version_id)` — same signature, now deleting artifacts too.

**Context for the implementer:** This is the failure mode commit `857760d` already paid for once — 174 MB of orphaned export archives accumulated because nothing deleted them. Follow that commit's established shape exactly: objects are deleted **before** the rows that name them, so a storage failure leaves a recoverable record rather than orphaned bytes; and a missing object is logged and skipped, so an object already gone by other means cannot wedge the endpoint.

Read `backend/app/datasets/router.py`'s `delete_dataset` first. It already deletes model versions as part of its cascade — find where, and route it through the same helper instead of deleting rows directly.

- [ ] **Step 1: Write the failing test**

Add to `backend/tests/test_training_api.py`:

```python
def test_deleting_a_model_version_removes_its_artifacts():
    session = db_module.SessionLocal()
    storage = _FakeStorage(objects={
        "models/9/best.pt": b"w",
        "models/9/artifacts/results.csv": b"epoch,loss\n",
        "models/9/artifacts/confusion_matrix.png": b"png",
    })
    version = _make_version(
        session,
        storage_key="models/9/best.pt",
        artifact_keys=[
            "models/9/artifacts/results.csv",
            "models/9/artifacts/confusion_matrix.png",
        ],
    )

    service.delete_model_version(session, storage, version.id)

    assert storage.objects == {}
    assert session.get(ModelVersion, version.id) is None
    session.close()


def test_a_missing_artifact_does_not_block_the_delete():
    session = db_module.SessionLocal()
    storage = _FakeStorage(objects={"models/9/best.pt": b"w"})
    version = _make_version(
        session,
        storage_key="models/9/best.pt",
        artifact_keys=["models/9/artifacts/gone.csv"],
    )

    service.delete_model_version(session, storage, version.id)

    assert session.get(ModelVersion, version.id) is None
    session.close()
```

`_FakeStorage` is a small stand-in whose `delete` raises `KeyError` for an absent key:

```python
class _FakeStorage:
    def __init__(self, objects):
        self.objects = dict(objects)

    def delete(self, key):
        del self.objects[key]

    def url_for(self, key):
        return f"https://example.invalid/{key}"
```

Write `_make_version` to insert a `ModelVersion` (with a parent `TrainingRun`) following the row-building pattern already used in this file — read it first.

- [ ] **Step 2: Run test to verify it fails**

```bash
cd /mnt/work-disk/Documents/Dev/endoscopy-platform/backend
uv run pytest tests/test_training_api.py -k artifact -v
```

Expected: FAIL — the artifact objects survive in `storage.objects`.

- [ ] **Step 3: Write minimal implementation**

In `backend/app/training/service.py`, add `import logging` and a module logger if absent, then replace `delete_model_version`:

```python
def delete_model_version(session: Session, storage: StorageService, version_id: int) -> None:
    """Delete a model version and every object that names it.

    Objects go before the row, matching delete_dataset: a storage failure
    then leaves a recoverable version rather than orphaned bytes. A
    missing object is logged and skipped rather than blocking the delete
    -- 174 MB of orphaned export archives accumulated exactly this way
    before 857760d.
    """
    version = get_model_version(session, version_id)
    for key in [*(version.artifact_keys or []), version.storage_key]:
        try:
            storage.delete(key)
        except Exception:  # noqa: BLE001 -- a missing object must not block the delete
            logger.warning("delete_model_version: could not remove %s", key)
    session.delete(version)
    session.commit()
```

In `backend/app/datasets/router.py`'s `delete_dataset`, ensure every `ModelVersion` it removes goes through this same path rather than a bare row delete, so artifacts cannot leak through the cascade.

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd /mnt/work-disk/Documents/Dev/endoscopy-platform/backend
uv run pytest tests/test_training_api.py -v
```

Expected: PASS, including the pre-existing deletion tests.

- [ ] **Step 5: Commit**

```bash
cd /mnt/work-disk/Documents/Dev/endoscopy-platform
git add backend/app/training/service.py backend/app/datasets/router.py backend/tests/test_training_api.py
git commit -m "fix: delete a model version's artifacts along with its weights"
```

---

### Task 6: Metrics and artifact-download endpoints

**Files:**
- Modify: `backend/app/training/schemas.py`
- Modify: `backend/app/training/service.py`
- Modify: `backend/app/training/router.py`
- Modify: `openapi.json` (regenerated, not hand-edited)
- Test: `backend/tests/test_training_api.py`

**Interfaces:**
- Consumes: the four columns (Task 3).
- Produces: `GET /training/models/{version_id}/metrics` → `ModelMetricsRead`; `GET /training/models/{version_id}/artifacts/{index}` → `{"download_url": str}`.

**Context for the implementer:** Keep this off `ModelVersionRead`. The models list is polled, and a 180-class confusion matrix is roughly 130 KB per row — the same reasoning that keeps `log_text` out of `TrainingRunRead`.

Artifacts are addressed by **index into `artifact_keys`**, never by filename, so a storage key from the database never appears in a URL where it could be edited to reach another object.

- [ ] **Step 1: Write the failing test**

Add to `backend/tests/test_training_api.py`:

```python
def test_metrics_endpoint_returns_every_collection(client):
    session = db_module.SessionLocal()
    version = _make_version(
        session,
        storage_key="models/11/best.pt",
        artifact_keys=["models/11/artifacts/results.csv"],
        per_class_metrics=[{"class": "polyp", "mAP50": 0.7}],
        confusion_matrix={"labels": ["polyp", "background"], "matrix": [[4, 1], [0, 2]]},
        history=[{"epoch": 1, "train/loss": 0.5}],
    )
    version_id = version.id
    session.close()

    body = client.get(f"/training/models/{version_id}/metrics").json()

    assert body["history"] == [{"epoch": 1, "train/loss": 0.5}]
    assert body["per_class"][0]["class"] == "polyp"
    assert body["confusion"]["labels"][-1] == "background"
    assert body["artifacts"] == [{"name": "results.csv", "index": 0}]


def test_metrics_endpoint_returns_empty_collections_not_404(client):
    session = db_module.SessionLocal()
    version = _make_version(session, storage_key="models/12/best.pt")
    version_id = version.id
    session.close()

    response = client.get(f"/training/models/{version_id}/metrics")

    assert response.status_code == 200
    assert response.json()["per_class"] == []
    assert response.json()["confusion"] is None


def test_artifact_download_returns_a_url(client):
    session = db_module.SessionLocal()
    version = _make_version(
        session,
        storage_key="models/13/best.pt",
        artifact_keys=["models/13/artifacts/results.csv"],
    )
    version_id = version.id
    session.close()

    body = client.get(f"/training/models/{version_id}/artifacts/0").json()

    assert "results.csv" in body["download_url"]


def test_an_out_of_range_artifact_index_is_404(client):
    session = db_module.SessionLocal()
    version = _make_version(session, storage_key="models/14/best.pt")
    version_id = version.id
    session.close()

    assert client.get(f"/training/models/{version_id}/artifacts/7").status_code == 404
```

Extend `_make_version` from Task 5 to accept `per_class_metrics`, `confusion_matrix` and a `history` argument it writes onto the parent `TrainingRun.metrics_history`.

- [ ] **Step 2: Run test to verify it fails**

```bash
cd /mnt/work-disk/Documents/Dev/endoscopy-platform/backend
uv run pytest tests/test_training_api.py -k "metrics_endpoint or artifact_download or out_of_range" -v
```

Expected: FAIL with 404 — the routes do not exist.

- [ ] **Step 3: Write minimal implementation**

In `backend/app/training/schemas.py`:

```python
class ArtifactRead(BaseModel):
    """One trainer-written file, addressed by index rather than by key so
    a storage key never travels in a URL."""

    name: str
    index: int


class ModelMetricsRead(BaseModel):
    """Everything the Info panel draws, in one request.

    Deliberately not folded into ModelVersionRead: the models list is
    polled, and a 180-class confusion matrix is ~130 KB per row -- the
    same reason log_text is not part of TrainingRunRead.
    """

    metrics: dict
    history: list[dict]
    per_class: list[dict]
    confusion: dict | None
    artifacts: list[ArtifactRead]
```

In `backend/app/training/service.py`:

```python
def get_model_metrics(session: Session, version_id: int) -> dict:
    """Assemble the Info panel's payload. History comes from the run,
    since it belongs to the attempt rather than to the weights."""
    version = get_model_version(session, version_id)
    run = session.get(TrainingRun, version.training_run_id)
    return {
        "metrics": version.metrics or {},
        "history": (run.metrics_history or []) if run else [],
        "per_class": version.per_class_metrics or [],
        "confusion": version.confusion_matrix,
        "artifacts": [
            {"name": key.rsplit("/", 1)[-1], "index": index}
            for index, key in enumerate(version.artifact_keys or [])
        ],
    }


def get_artifact_key(session: Session, version_id: int, index: int) -> str:
    version = get_model_version(session, version_id)
    keys = version.artifact_keys or []
    if index < 0 or index >= len(keys):
        raise ArtifactNotFound(f"Artifact {index} not found on model version {version_id}")
    return keys[index]
```

Add the exception alongside the module's existing ones:

```python
class ArtifactNotFound(Exception):
    pass
```

In `backend/app/training/router.py`:

```python
@router.get("/models/{version_id}/metrics", response_model=ModelMetricsRead)
def read_model_metrics(
    version_id: int,
    session: Session = Depends(get_session),
):
    try:
        return service.get_model_metrics(session, version_id)
    except service.ModelVersionNotFound as exc:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(exc))


@router.get("/models/{version_id}/artifacts/{index}", response_model=ModelDownloadRead)
def download_artifact(
    version_id: int,
    index: int,
    session: Session = Depends(get_session),
    storage: StorageService = Depends(get_storage_service),
):
    try:
        key = service.get_artifact_key(session, version_id, index)
    except (service.ModelVersionNotFound, service.ArtifactNotFound) as exc:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(exc))
    return {"download_url": storage.url_for(key)}
```

Add `ModelMetricsRead` to the router's schema imports.

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd /mnt/work-disk/Documents/Dev/endoscopy-platform/backend
uv run pytest tests/test_training_api.py -v
```

Expected: PASS.

- [ ] **Step 5: Regenerate the API contract**

```bash
cd /mnt/work-disk/Documents/Dev/endoscopy-platform/backend
PYTHONPATH=. uv run python scripts/export_openapi.py
cd /mnt/work-disk/Documents/Dev/endoscopy-platform
git diff --stat openapi.json
```

Expected: `openapi.json` shows as changed. If it does not, the export did not pick up the new routes — stop and investigate rather than continuing.

- [ ] **Step 6: Commit**

```bash
git add backend/app/training/ backend/tests/test_training_api.py openapi.json
git commit -m "feat: expose model metrics and artifact downloads"
```

---

### Task 7: The training-curve chart

**Files:**
- Create: `frontend/src/features/training/MetricsChart.tsx`
- Test: `frontend/src/features/training/MetricsChart.test.tsx`

**Interfaces:**
- Consumes: `history: Array<Record<string, number>>` (each point has an `epoch` key).
- Produces: `<MetricsChart history={...} />`.

**Context for the implementer:** Inline SVG, no charting library — `package.json` has none today and one panel does not justify adding a dependency someone must then keep updated.

Ultralytics emits about ten series at once (three losses, four metrics, three learning rates), which is unreadable on one axis. So: series are toggleable from the legend, and any key containing `loss` is drawn against a second, right-hand Y axis. Both axes are scaled from the data, never hardcoded.

The component must contain no metric name specific to any trainer. Series names come from the keys present in the data.

- [ ] **Step 1: Write the failing test**

```tsx
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import { MetricsChart } from "./MetricsChart";

const history = [
  { epoch: 1, "train/loss": 1.0, "metrics/mAP50(B)": 0.2 },
  { epoch: 2, "train/loss": 0.6, "metrics/mAP50(B)": 0.5 },
  { epoch: 3, "train/loss": 0.4, "metrics/mAP50(B)": 0.7 },
];

describe("MetricsChart", () => {
  it("draws one series per metric key, epoch excluded", () => {
    render(<MetricsChart history={history} />);

    expect(screen.getByRole("button", { name: /train\/loss/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /metrics\/mAP50\(B\)/ })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^epoch$/ })).not.toBeInTheDocument();
    expect(document.querySelectorAll("path[data-series]")).toHaveLength(2);
  });

  it("hides a series when its legend entry is toggled off", async () => {
    render(<MetricsChart history={history} />);

    await userEvent.click(screen.getByRole("button", { name: /train\/loss/ }));

    expect(document.querySelectorAll("path[data-series]")).toHaveLength(1);
  });

  it("renders series it has never seen before", () => {
    render(<MetricsChart history={[{ epoch: 1, "rtdetr/custom_score": 0.3 }]} />);

    expect(screen.getByRole("button", { name: /rtdetr\/custom_score/ })).toBeInTheDocument();
  });

  it("renders nothing when there is no history", () => {
    const { container } = render(<MetricsChart history={[]} />);

    expect(container).toBeEmptyDOMElement();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd /mnt/work-disk/Documents/Dev/endoscopy-platform/frontend
npm test -- MetricsChart
```

Expected: FAIL — cannot resolve `./MetricsChart`.

- [ ] **Step 3: Write minimal implementation**

Create `frontend/src/features/training/MetricsChart.tsx`. Requirements the implementation must satisfy:

- Return `null` when `history` is empty.
- Derive series keys as every key except `epoch` seen across all points, in first-seen order. Never a hardcoded list.
- Split into two scales: keys whose lowercase name includes `loss` use a right-hand axis, everything else the left. Compute each axis's min/max from its own series' values.
- Render each series as `<path data-series={key} …>` with a distinct stroke colour cycled from a small palette.
- Render the legend as `<button>` per series, toggling that series' visibility in component state; a hidden series renders no `path`.
- Points with a missing key are skipped in that series' line rather than treated as zero — a trainer that starts reporting a metric at epoch 5 must not appear to drop to zero for epochs 1–4.
- Label the X axis with epoch numbers and both Y axes with their computed range.
- Dark theme only: use the same `text-gray-*` / `border-gray-*` families as `ModelVersionsTable.tsx`. No light backgrounds.

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd /mnt/work-disk/Documents/Dev/endoscopy-platform/frontend
npm test -- MetricsChart
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cd /mnt/work-disk/Documents/Dev/endoscopy-platform
git add frontend/src/features/training/MetricsChart.tsx frontend/src/features/training/MetricsChart.test.tsx
git commit -m "feat: add the training-curve chart"
```

---

### Task 8: The confusion matrix

**Files:**
- Create: `frontend/src/features/training/ConfusionMatrix.tsx`
- Test: `frontend/src/features/training/ConfusionMatrix.test.tsx`

**Interfaces:**
- Consumes: `confusion: { labels: string[]; matrix: number[][] } | null`.
- Produces: `<ConfusionMatrix confusion={...} />`.

**Context for the implementer:** Drawn from numbers, not from a trainer's PNG — that is what makes RT-DETR and ConvNeXt render identically to YOLO.

The real taxonomy here runs to roughly 180 labels, and a 180×180 grid is physically unreadable, so the component defaults to the top N (12) rows by total instance count with a "show all" toggle.

- [ ] **Step 1: Write the failing test**

```tsx
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import { ConfusionMatrix } from "./ConfusionMatrix";

const confusion = {
  labels: ["polyp", "erosion", "background"],
  matrix: [
    [8, 1, 2],
    [0, 5, 1],
    [3, 2, 0],
  ],
};

describe("ConfusionMatrix", () => {
  it("renders a cell per matrix entry", () => {
    render(<ConfusionMatrix confusion={confusion} />);

    expect(document.querySelectorAll("[data-cell]")).toHaveLength(9);
    expect(screen.getAllByText("polyp").length).toBeGreaterThan(0);
    expect(screen.getAllByText("background").length).toBeGreaterThan(0);
  });

  it("renders nothing when there is no matrix", () => {
    const { container } = render(<ConfusionMatrix confusion={null} />);

    expect(container).toBeEmptyDOMElement();
  });

  it("limits a large matrix until show-all is clicked", async () => {
    const labels = Array.from({ length: 20 }, (_, i) => `class_${i}`);
    const matrix = labels.map((_, row) => labels.map((__, col) => row + col));

    render(<ConfusionMatrix confusion={{ labels, matrix }} />);
    expect(document.querySelectorAll("[data-cell]").length).toBeLessThan(400);

    await userEvent.click(screen.getByRole("button", { name: /show all/i }));

    expect(document.querySelectorAll("[data-cell]")).toHaveLength(400);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd /mnt/work-disk/Documents/Dev/endoscopy-platform/frontend
npm test -- ConfusionMatrix
```

Expected: FAIL — cannot resolve `./ConfusionMatrix`.

- [ ] **Step 3: Write minimal implementation**

Create `frontend/src/features/training/ConfusionMatrix.tsx`. Requirements:

- Return `null` when `confusion` is null or its matrix is empty.
- Render a grid of `<div data-cell>` (or SVG `<rect data-cell>`) — one per entry — with the cell's background opacity scaled by `value / max(matrix)`, so the diagonal reads at a glance.
- Show the numeric value inside each cell, and label both axes with the class names. Make clear which axis is predicted and which is actual.
- When `labels.length > 12`, show only the 12 rows/columns with the highest row totals, plus a "Show all" button that reveals the rest. `background`, when present, is always kept — it is where detection misses go.
- The grid must scroll inside its own container rather than forcing the page to scroll horizontally.
- Dark theme only, matching the existing table's colour families.

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd /mnt/work-disk/Documents/Dev/endoscopy-platform/frontend
npm test -- ConfusionMatrix
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cd /mnt/work-disk/Documents/Dev/endoscopy-platform
git add frontend/src/features/training/ConfusionMatrix.tsx frontend/src/features/training/ConfusionMatrix.test.tsx
git commit -m "feat: add the confusion matrix component"
```

---

### Task 9: The Info panel, wired into the models table

**Files:**
- Create: `frontend/src/features/training/ModelInfoPanel.tsx`
- Create: `frontend/src/features/training/ModelInfoPanel.test.tsx`
- Modify: `frontend/src/features/training/ModelVersionsTable.tsx`
- Modify: `frontend/src/features/training/ModelVersionsTable.test.tsx`
- Modify: `frontend/src/features/training/TrainPage.tsx`

**Interfaces:**
- Consumes: `GET /training/models/{id}/metrics` (Task 6); `<MetricsChart>` (Task 7); `<ConfusionMatrix>` (Task 8).
- Produces: `<ModelInfoPanel versionId={number} onClose={() => void} />`; `ModelVersionsTable` gains an `onInfo: (id: number) => void` prop.

**Context for the implementer:** The UI/UX spec (`docs/specs/2026-07-23-platform-ui-ux-design.md`, line 291) specifies the models table's actions as **Info, Download, Delete**. Download and Delete exist; this is Info's definition. Read that spec section before starting, per CLAUDE.md.

The panel renders in the right-hand column of `/train`, where `TrainRunPanel` already lives — deliberately not a modal, because training may be running underneath and its live log and progress must stay visible.

**Every block whose data is absent is omitted entirely** — no dash, no error, no empty frame. That property is what makes the screen look the same for every trainer, and the "unknown trainer" test below is the guard on it.

Use `apiClient` from `frontend/src/shared/api/client.ts`. Never a hand-rolled `fetch()`.

- [ ] **Step 1: Write the failing test**

```tsx
import { render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach } from "vitest";

import { ModelInfoPanel } from "./ModelInfoPanel";
import { apiClient } from "../../shared/api/client";

vi.mock("../../shared/api/client", () => ({
  apiClient: { GET: vi.fn() },
}));

const full = {
  metrics: { "metrics/mAP50(B)": 0.65 },
  history: [
    { epoch: 1, "train/loss": 1.0 },
    { epoch: 2, "train/loss": 0.6 },
  ],
  per_class: [{ class: "polyp", mAP50: 0.7, "Box-P": 0.8 }],
  confusion: { labels: ["polyp", "background"], matrix: [[4, 1], [0, 2]] },
  artifacts: [{ name: "results.csv", index: 0 }],
};

describe("ModelInfoPanel", () => {
  beforeEach(() => vi.mocked(apiClient.GET).mockReset());

  it("renders every block when the trainer supplied everything", async () => {
    vi.mocked(apiClient.GET).mockResolvedValue({ data: full });

    render(<ModelInfoPanel versionId={1} onClose={() => {}} />);

    await waitFor(() => expect(screen.getByText("polyp")).toBeInTheDocument());
    expect(document.querySelectorAll("path[data-series]").length).toBeGreaterThan(0);
    expect(document.querySelectorAll("[data-cell]").length).toBe(4);
    expect(screen.getByText("results.csv")).toBeInTheDocument();
  });

  it("omits blocks the trainer did not supply, without erroring", async () => {
    vi.mocked(apiClient.GET).mockResolvedValue({
      data: { metrics: {}, history: [], per_class: [], confusion: null, artifacts: [] },
    });

    render(<ModelInfoPanel versionId={1} onClose={() => {}} />);

    await waitFor(() => expect(screen.queryByText(/loading/i)).not.toBeInTheDocument());
    expect(document.querySelectorAll("path[data-series]")).toHaveLength(0);
    expect(document.querySelectorAll("[data-cell]")).toHaveLength(0);
    expect(screen.queryByText(/error/i)).not.toBeInTheDocument();
  });

  it("renders a trainer whose metric names it has never seen", async () => {
    vi.mocked(apiClient.GET).mockResolvedValue({
      data: {
        metrics: { custom_fitness: 0.4 },
        history: [{ epoch: 1, "rtdetr/ap_50": 0.3 }],
        per_class: [{ class: "polyp", ap_50: 0.31 }],
        confusion: { labels: ["polyp"], matrix: [[3]] },
        artifacts: [],
      },
    });

    render(<ModelInfoPanel versionId={1} onClose={() => {}} />);

    await waitFor(() => expect(screen.getByText("polyp")).toBeInTheDocument());
    expect(screen.getByRole("button", { name: /rtdetr\/ap_50/ })).toBeInTheDocument();
    expect(screen.getByText(/ap_50/)).toBeInTheDocument();
  });
});
```

Add to `ModelVersionsTable.test.tsx`:

```tsx
  it("calls onInfo with the version id", async () => {
    const onInfo = vi.fn();
    render(
      <ModelVersionsTable
        versions={[baseVersion]}
        onDownload={() => {}}
        onDelete={() => {}}
        onInfo={onInfo}
      />,
    );

    await userEvent.click(screen.getByRole("button", { name: /info/i }));

    expect(onInfo).toHaveBeenCalledWith(baseVersion.id);
  });
```

Reuse whatever fixture the existing tests in that file already build, rather than inventing `baseVersion` if one is present.

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd /mnt/work-disk/Documents/Dev/endoscopy-platform/frontend
npm test -- ModelInfoPanel ModelVersionsTable
```

Expected: FAIL — cannot resolve `./ModelInfoPanel`; no Info button.

- [ ] **Step 3: Write minimal implementation**

Create `frontend/src/features/training/ModelInfoPanel.tsx`, fetching `/training/models/{versionId}/metrics` via `apiClient` on mount and whenever `versionId` changes. Render, top to bottom, each block omitted when its data is empty:

1. Header: version name/task/headline metric, plus a close control calling `onClose`.
2. `<MetricsChart history={data.history} />` — omit the whole section when `history` is empty.
3. `<ConfusionMatrix confusion={data.confusion} />` — omit when null.
4. Per-class table: columns derived from the union of keys across `per_class` rows (`class` first, then the rest in first-seen order), sortable by clicking a numeric column header. Never a hardcoded column list.
5. Artifacts: one row per entry, each a link that requests `/training/models/{versionId}/artifacts/{index}` and opens the returned `download_url` — mirroring how `TrainPage` already handles model downloads.

Show a "Loading…" state while the request is in flight, and a short message if it fails. Dark theme only.

Then add the Info button to `ModelVersionsTable.tsx` — placed before Download in the actions cell, styled like the existing Download button — and add `onInfo` to its props interface.

In `TrainPage.tsx`, hold `selectedVersionId` state, pass `onInfo={setSelectedVersionId}` to the table, and render `<ModelInfoPanel>` in the right-hand column when it is set, with `onClose={() => setSelectedVersionId(null)}`. The running-training panel keeps priority: when a run is active, the info panel renders below it rather than replacing it.

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd /mnt/work-disk/Documents/Dev/endoscopy-platform/frontend
npm test -- ModelInfoPanel ModelVersionsTable TrainPage
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cd /mnt/work-disk/Documents/Dev/endoscopy-platform
git add frontend/src/features/training/
git commit -m "feat: add the model Info panel to the train screen"
```

---

### Task 10: Full-suite check and real verification

**Files:**
- Modify: `ROADMAP.md`

**Interfaces:**
- Consumes: everything above.
- Produces: a deviation-log entry and a verified feature.

**Context for the implementer:** Per CLAUDE.md, 16 backend failures and a red `npm run build` **predate this work** — see `reference_pre_existing_red_tests`. Do not chase them as regressions from this plan. Establish which failures are pre-existing by comparing against `git stash`-ed state if unsure.

This project has repeatedly shipped defects that passed every test — a 64 MB `/dev/shm` starving the DataLoader, an image that never contained the training code, an export that wrote six classes where the screen showed one. Green tests are not the finish line here.

- [ ] **Step 1: Run every affected suite**

```bash
cd /mnt/work-disk/Documents/Dev/endoscopy-platform/backend
uv run pytest tests/test_training_api.py tests/test_training_models.py tests/test_training_service.py -v

cd /mnt/work-disk/Documents/Dev/endoscopy-platform
docker cp ml-worker/tests endoscopy-platform-ml-worker-1:/app/tests
docker cp ml-worker/app endoscopy-platform-ml-worker-1:/app/app
docker compose exec -T ml-worker /app/.venv/bin/python -m pytest tests/test_training_adapter.py tests/test_ultralytics_yolo_adapter.py tests/test_tasks_training.py -v

cd /mnt/work-disk/Documents/Dev/endoscopy-platform/frontend
npm test
```

Expected: PASS, excluding the documented pre-existing failures.

- [ ] **Step 2: Rebuild the ml-worker image**

The container has been running `docker cp`-ed code. The image itself must contain the new adapter, or the next real run trains with the old one — a mistake this project has made before.

```bash
cd /mnt/work-disk/Documents/Dev/endoscopy-platform
docker compose build ml-worker
docker compose up -d ml-worker
docker compose exec -T ml-worker /app/.venv/bin/python -c \
  "from app.training_adapter import TrainingResult; print(TrainingResult.__dataclass_fields__.keys())"
```

Expected: the printed keys include `history`, `per_class`, `confusion`, `artifacts`.

- [ ] **Step 3: Run one short real training run**

Start the stack per CLAUDE.md, log in through the browser, and train for 3 epochs on a small existing dataset. Then open Info on the resulting model and confirm against what Ultralytics itself wrote:

- the curve shows 3 points and the loss series descends;
- the confusion matrix's labels match the dataset's classes, with `background` last;
- the per-class table's numbers match the final epoch's printed table in the raw log;
- each artifact downloads and opens (`results.csv` in particular).

- [ ] **Step 4: Verify deletion symmetry for real**

```bash
docker compose exec -T minio mc ls --recursive local/endoscopy/models/ 2>/dev/null || \
  echo "use the MinIO console at :9001 to list models/ instead"
```

Note the artifact objects for the run, delete that model version through the UI, and list again. Expected: both the weights and every `models/<id>/artifacts/*` object are gone.

- [ ] **Step 5: Record the outcome in ROADMAP.md**

Add a phase entry following the existing format, covering: what was built, the decision that names are never normalized and why the reference platform's hand-written loops settled it, the `on_epoch` widening and its thread-safety constraint, and — honestly — anything that did not work or was not verified.

- [ ] **Step 6: Commit**

```bash
git add ROADMAP.md
git commit -m "docs: record trainer-agnostic training metrics in the roadmap"
```

---

## Self-Review

**Spec coverage:** Component 1 (adapter contract) → Task 1. Component 2 (Ultralytics adapter) → Task 2. Component 3 (persistence) → Tasks 3–4, with deletion symmetry in Task 5. Component 4 (API) → Task 6. Component 5 (the screen) → Tasks 7–9. Testing section → distributed across every task, with the real-verification requirement in Task 10. The spec's `None`-history rule is tested in Task 4; its `TrainingResult.history` precedence rule is implemented in Task 4 step 3.

**Type consistency:** `history`/`per_class`/`confusion`/`artifacts` are named identically from `TrainingResult` (Task 1) through the worker (Task 4) to the API payload (Task 6), where `per_class` maps to `ModelVersion.per_class_metrics` and `confusion` to `confusion_matrix` — a deliberate rename, since the columns needed non-colliding names, and both directions are spelled out in Tasks 3, 4 and 6.

**Known ordering constraint:** Tasks 1 and 2 change call signatures that existing tests use, so both update those call sites in the same commit; the suite is never left red between tasks.
