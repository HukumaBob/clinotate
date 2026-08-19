# Train Screen Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Train a YOLO model on an exported dataset from a `/train` screen, watching its raw log live and keeping the resulting weights.

**Architecture:** A new `backend/app/training/` module owns two entities — `TrainingRun` (the process: config, raw log, status) and `ModelVersion` (the artifact: weights in MinIO). Training is a `Job` executed by the existing `ml-worker` on its solo GPU queue, behind a `TrainingAdapter` interface shaped for hand-written PyTorch loops. The log is appended to a Postgres column in chunks and served by an offset endpoint; Stop is cooperative, checked at epoch boundaries.

**Tech Stack:** FastAPI, SQLAlchemy, Alembic, Celery + Redis, MinIO, Ultralytics, React/Vite, Vitest, pytest.

**Spec:** [docs/superpowers/specs/2026-08-19-train-screen-design.md](../specs/2026-08-19-train-screen-design.md)

## Global Constraints

- **English only** in all committed content — code, comments, docstrings, UI copy. No Russian anywhere.
- **Dark theme only.** Tailwind uses the `class` dark-mode strategy; never introduce light-background classes.
- **All binary media through `StorageService`** (`backend/app/storage.py`, `ml-worker/app/storage.py`). The one sanctioned exception is transient `tempfile.NamedTemporaryFile` use where a library needs a real path.
- **TDD:** every backend task and every frontend task with logic gets a failing test before the implementation.
- **No hand-rolled `fetch()`** in frontend application code — use `apiClient` from `frontend/src/shared/api/client.ts`.
- **Never hand-edit** anything under `frontend/src/shared/api/generated/`.
- **Work directly on `master`.** No feature branches, no worktrees.
- **After any backend schema/route change**, regenerate the committed OpenAPI document:
  `cd backend && PYTHONPATH=. uv run python scripts/export_openapi.py`
  and verify with `git diff --stat openapi.json` that it actually changed.
- **ml-worker tests do not run on the host** — the image does not `COPY tests/`, and the host `.venv` has no torch. Use `docker cp` plus `docker compose exec`.
- **Two model files must stay in sync:** `backend/app/*/models.py` and `ml-worker/app/models.py` are independent copies of the same tables. A new table used by the worker must be declared in both.

## File Structure

**Backend — new module `backend/app/training/`:**
- `models.py` — `TrainingRun`, `ModelVersion`, `TrainingRunStatus`
- `schemas.py` — Pydantic request/response shapes
- `service.py` — run creation, validation, stop, `ModelVersion` queries
- `router.py` — the `/training` endpoints
- `__init__.py`

**Backend — modified:**
- `backend/app/jobs/models.py` — add `JobType.MODEL_TRAIN`
- `backend/app/main.py` — register the training router
- `backend/alembic/versions/<rev>_add_training_tables.py` — new tables + enum value

**ml-worker — new:**
- `ml-worker/app/training_adapter.py` — `TrainingRequest`, `TrainingResult`, `TrainingAdapter` protocol
- `ml-worker/app/ultralytics_yolo_adapter.py` — the one working adapter
- `ml-worker/tests/test_training_adapter.py`, `ml-worker/tests/test_tasks_training.py`

**ml-worker — modified:**
- `ml-worker/app/models.py` — `TrainingRun`, `ModelVersion` copies
- `ml-worker/app/tasks.py` — the `model_train` task
- `ml-worker/pyproject.toml` — add `ultralytics`

**Frontend — new `frontend/src/features/training/`:**
- `TrainPage.tsx` — layout, tab strip, polling orchestration
- `TrainConfigForm.tsx` — left column
- `TrainRunPanel.tsx` — right column (status, progress, log pane, Stop)
- `ModelVersionsTable.tsx` — the bottom table
- one `.test.tsx` beside each

**Frontend — modified:**
- `frontend/src/app/App.tsx` — the `/train` route
- `frontend/src/app/AppHeader.tsx` — the nav entry

Split by responsibility rather than by layer: the config form, the live panel and the versions table poll different endpoints and change for different reasons.

---

### Task 1: Database schema and job type

**Files:**
- Create: `backend/app/training/__init__.py`
- Create: `backend/app/training/models.py`
- Modify: `backend/app/jobs/models.py:18` (add enum member)
- Create: `backend/alembic/versions/b1c2d3e4f5a6_add_training_tables.py`
- Test: `backend/tests/training/test_models.py`

**Interfaces:**
- Consumes: `app.db.Base`, `app.datasets.models.TaskType`
- Produces: `TrainingRun`, `ModelVersion`, `TrainingRunStatus` (enum with members `PENDING`, `RUNNING`, `SUCCEEDED`, `FAILED`, `STOPPED`), `JobType.MODEL_TRAIN`

- [ ] **Step 1: Write the failing test**

Create `backend/tests/training/__init__.py` (empty) and `backend/tests/training/test_models.py`:

```python
from app.datasets.models import TaskType
from app.jobs.models import JobType
from app.training.models import ModelVersion, TrainingRun, TrainingRunStatus


def test_model_train_job_type_exists():
    assert JobType.MODEL_TRAIN.value == "model_train"


def test_training_run_defaults(db_session, seeded_dataset, seeded_user):
    run = TrainingRun(
        dataset_id=seeded_dataset.id,
        job_id=None,
        adapter="ultralytics_yolo",
        base_model="yolo11n.pt",
        task_type=TaskType.DETECTION,
        config={"epochs": 10, "batch": 8},
        total_epochs=10,
        created_by_id=seeded_user.id,
    )
    db_session.add(run)
    db_session.commit()
    db_session.refresh(run)

    assert run.status == TrainingRunStatus.PENDING
    assert run.stop_requested is False
    assert run.log_text == ""
    assert run.current_epoch == 0
    assert run.metrics == {}


def test_model_version_links_to_run(db_session, seeded_dataset, seeded_user):
    run = TrainingRun(
        dataset_id=seeded_dataset.id,
        adapter="ultralytics_yolo",
        base_model="yolo11n.pt",
        task_type=TaskType.DETECTION,
        config={},
        total_epochs=1,
        created_by_id=seeded_user.id,
    )
    db_session.add(run)
    db_session.commit()

    version = ModelVersion(
        training_run_id=run.id,
        name="run-1-best",
        task_type=TaskType.DETECTION,
        storage_key="models/1/best.pt",
        metrics={"mAP50": 0.71},
    )
    db_session.add(version)
    db_session.commit()
    db_session.refresh(version)

    assert version.is_active is False
    assert version.training_run_id == run.id
```

Check `backend/tests/conftest.py` for the existing fixture names. If `db_session`, `seeded_dataset` or `seeded_user` do not exist under those names, use the equivalents that are there rather than adding new fixtures.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && uv run pytest tests/training/test_models.py -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'app.training'`

- [ ] **Step 3: Add the job type**

In `backend/app/jobs/models.py`, add to `JobType`:

```python
    MODEL_TRAIN = "model_train"
```

- [ ] **Step 4: Write the models**

Create `backend/app/training/__init__.py` (empty) and `backend/app/training/models.py`:

```python
import enum
from datetime import datetime, timezone

from sqlalchemy import (
    JSON,
    Boolean,
    DateTime,
    Enum,
    ForeignKey,
    Integer,
    String,
    Text,
)
from sqlalchemy.orm import Mapped, mapped_column

from app.datasets.models import TaskType
from app.db import Base


class TrainingRunStatus(str, enum.Enum):
    """Deliberately parallel to JobStatus rather than reusing it: a run can
    end as STOPPED, which is neither success nor failure, and widening an
    enum shared by every job type to serve one of them is worse than a
    neighbouring enum."""

    PENDING = "pending"
    RUNNING = "running"
    SUCCEEDED = "succeeded"
    FAILED = "failed"
    STOPPED = "stopped"


class TrainingRun(Base):
    """One attempt at training, successful or not.

    Kept separate from ModelVersion because a run that dies in epoch three
    still belongs in the history table while having no weights at all.
    """

    __tablename__ = "training_runs"

    id: Mapped[int] = mapped_column(primary_key=True)
    dataset_id: Mapped[int] = mapped_column(ForeignKey("datasets.id"))
    job_id: Mapped[int | None] = mapped_column(ForeignKey("jobs.id"), nullable=True)
    adapter: Mapped[str] = mapped_column(String(100))
    base_model: Mapped[str] = mapped_column(String(200))
    task_type: Mapped[TaskType] = mapped_column(Enum(TaskType))
    config: Mapped[dict] = mapped_column(JSON, default=dict)
    status: Mapped[TrainingRunStatus] = mapped_column(
        Enum(TrainingRunStatus), default=TrainingRunStatus.PENDING
    )
    stop_requested: Mapped[bool] = mapped_column(Boolean, default=False)
    # Appended in chunks by the worker (~2s or ~20 lines), never per line.
    log_text: Mapped[str] = mapped_column(Text, default="")
    metrics: Mapped[dict] = mapped_column(JSON, default=dict)
    current_epoch: Mapped[int] = mapped_column(Integer, default=0)
    total_epochs: Mapped[int] = mapped_column(Integer)
    error: Mapped[str | None] = mapped_column(String(2000), nullable=True)
    created_by_id: Mapped[int] = mapped_column(ForeignKey("users.id"))
    started_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    finished_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=lambda: datetime.now(timezone.utc)
    )


class ModelVersion(Base):
    """Trained weights worth keeping. Created only when a run reaches
    SUCCEEDED or STOPPED -- the Results screen reads this table and never
    needs to know that training exists."""

    __tablename__ = "model_versions"

    id: Mapped[int] = mapped_column(primary_key=True)
    training_run_id: Mapped[int] = mapped_column(ForeignKey("training_runs.id", ondelete="CASCADE"))
    name: Mapped[str] = mapped_column(String(200))
    task_type: Mapped[TaskType] = mapped_column(Enum(TaskType))
    storage_key: Mapped[str] = mapped_column(String(500))
    metrics: Mapped[dict] = mapped_column(JSON, default=dict)
    is_active: Mapped[bool] = mapped_column(Boolean, default=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=lambda: datetime.now(timezone.utc)
    )
```

- [ ] **Step 5: Import the models so Alembic autogenerate sees them**

Check how `backend/alembic/env.py` collects metadata (grep for `datasets.models` in it and in `backend/app/db.py`). Add the `app.training.models` import in the same place the other modules are imported, following whatever pattern is already there.

- [ ] **Step 6: Write the migration**

Create `backend/alembic/versions/b1c2d3e4f5a6_add_training_tables.py`. Confirm the current head first with `cd backend && uv run alembic heads` and set `down_revision` to it (it should be `9a1b2c3d4e5f`, the dataset_export job type):

```python
"""add training tables

Revision ID: b1c2d3e4f5a6
Revises: 9a1b2c3d4e5f
Create Date: 2026-08-19 00:00:00.000000

"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = 'b1c2d3e4f5a6'
down_revision: Union[str, Sequence[str], None] = '9a1b2c3d4e5f'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    # Postgres enums store the member NAME, not its Python value -- the
    # jobtype column already contains uppercase names like DATASET_EXPORT,
    # so the new value must match that case.
    op.execute("ALTER TYPE jobtype ADD VALUE IF NOT EXISTS 'MODEL_TRAIN'")

    trainingrunstatus = sa.Enum(
        'PENDING', 'RUNNING', 'SUCCEEDED', 'FAILED', 'STOPPED',
        name='trainingrunstatus',
    )
    trainingrunstatus.create(op.get_bind(), checkfirst=True)

    op.create_table(
        'training_runs',
        sa.Column('id', sa.Integer(), nullable=False),
        sa.Column('dataset_id', sa.Integer(), nullable=False),
        sa.Column('job_id', sa.Integer(), nullable=True),
        sa.Column('adapter', sa.String(length=100), nullable=False),
        sa.Column('base_model', sa.String(length=200), nullable=False),
        sa.Column('task_type', sa.Enum('DETECTION', 'SEGMENTATION', 'CLASSIFICATION', name='tasktype'), nullable=False),
        sa.Column('config', sa.JSON(), nullable=False),
        sa.Column('status', trainingrunstatus, nullable=False),
        sa.Column('stop_requested', sa.Boolean(), nullable=False),
        sa.Column('log_text', sa.Text(), nullable=False),
        sa.Column('metrics', sa.JSON(), nullable=False),
        sa.Column('current_epoch', sa.Integer(), nullable=False),
        sa.Column('total_epochs', sa.Integer(), nullable=False),
        sa.Column('error', sa.String(length=2000), nullable=True),
        sa.Column('created_by_id', sa.Integer(), nullable=False),
        sa.Column('started_at', sa.DateTime(timezone=True), nullable=True),
        sa.Column('finished_at', sa.DateTime(timezone=True), nullable=True),
        sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(['dataset_id'], ['datasets.id'], ),
        sa.ForeignKeyConstraint(['job_id'], ['jobs.id'], ),
        sa.ForeignKeyConstraint(['created_by_id'], ['users.id'], ),
        sa.PrimaryKeyConstraint('id'),
    )

    op.create_table(
        'model_versions',
        sa.Column('id', sa.Integer(), nullable=False),
        sa.Column('training_run_id', sa.Integer(), nullable=False),
        sa.Column('name', sa.String(length=200), nullable=False),
        sa.Column('task_type', sa.Enum('DETECTION', 'SEGMENTATION', 'CLASSIFICATION', name='tasktype'), nullable=False),
        sa.Column('storage_key', sa.String(length=500), nullable=False),
        sa.Column('metrics', sa.JSON(), nullable=False),
        sa.Column('is_active', sa.Boolean(), nullable=False),
        sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(['training_run_id'], ['training_runs.id'], ondelete='CASCADE'),
        sa.PrimaryKeyConstraint('id'),
    )


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_table('model_versions')
    op.drop_table('training_runs')
    sa.Enum(name='trainingrunstatus').drop(op.get_bind(), checkfirst=True)
    # Postgres cannot drop a value from an enum type; leaving MODEL_TRAIN is
    # harmless because no row will reference it after a downgrade.
```

Note: `tasktype` already exists from the datasets migration, so the two `sa.Enum(...)` column declarations above must **not** create it. If the migration fails with "type tasktype already exists", pass `create_type=False` via `postgresql.ENUM(..., name='tasktype', create_type=False)` for both columns.

- [ ] **Step 7: Apply the migration**

Run: `cd backend && uv run alembic upgrade head`
Expected: no error; `docker compose exec postgres psql -U endoscopy -c "\d training_runs"` shows the table.

- [ ] **Step 8: Run the tests**

Run: `cd backend && uv run pytest tests/training/test_models.py -v`
Expected: PASS (3 tests)

- [ ] **Step 9: Commit**

```bash
git add backend/app/training/ backend/app/jobs/models.py backend/alembic/versions/b1c2d3e4f5a6_add_training_tables.py backend/tests/training/
git commit -m "feat: add TrainingRun and ModelVersion tables"
```

---

### Task 2: Service layer — creating, validating, and stopping runs

**Files:**
- Create: `backend/app/training/service.py`
- Create: `backend/app/training/schemas.py`
- Test: `backend/tests/training/test_service.py`

**Interfaces:**
- Consumes: `TrainingRun`, `ModelVersion`, `TrainingRunStatus` (Task 1); `app.jobs.models.Job`, `JobType`, `JobStatus`; `app.celery_app.celery_app`
- Produces:
  - `find_export_job(session, dataset_id) -> Job | None`
  - `create_training_run(session, *, dataset_id, base_model, config, created_by) -> TrainingRun`
  - `request_stop(session, run_id) -> TrainingRun`
  - `list_runs(session, status=None) -> list[TrainingRun]`
  - `list_model_versions(session) -> list[ModelVersion]`
  - `delete_model_version(session, storage, version_id) -> None`
  - exceptions `DatasetNotExported`, `RunAlreadyActive`, `RunNotStoppable`
  - schemas `TrainingRunCreate`, `TrainingRunRead`, `TrainingLogRead`, `ModelVersionRead`

- [ ] **Step 1: Write the failing test**

Create `backend/tests/training/test_service.py`:

```python
import pytest

from app.jobs.models import Job, JobStatus, JobType
from app.training.models import TrainingRun, TrainingRunStatus
from app.training.service import (
    DatasetNotExported,
    RunAlreadyActive,
    RunNotStoppable,
    create_training_run,
    request_stop,
)


def _succeeded_export(session, dataset_id, user):
    job = Job(
        job_type=JobType.DATASET_EXPORT,
        status=JobStatus.SUCCEEDED,
        payload={"dataset_id": dataset_id},
        result_ref=f"exports/{dataset_id}/dataset.zip",
        created_by_id=user.id,
    )
    session.add(job)
    session.commit()
    return job


def test_create_run_requires_an_exported_dataset(db_session, seeded_dataset, seeded_user):
    with pytest.raises(DatasetNotExported):
        create_training_run(
            db_session,
            dataset_id=seeded_dataset.id,
            base_model="yolo11n.pt",
            config={"epochs": 10, "batch": 8},
            created_by=seeded_user,
        )


def test_create_run_succeeds_when_export_exists(db_session, seeded_dataset, seeded_user, monkeypatch):
    sent = []
    monkeypatch.setattr(
        "app.training.service.celery_app.send_task",
        lambda name, args=None, **kw: sent.append((name, args)),
    )
    _succeeded_export(db_session, seeded_dataset.id, seeded_user)

    run = create_training_run(
        db_session,
        dataset_id=seeded_dataset.id,
        base_model="yolo11n.pt",
        config={"epochs": 10, "batch": 8},
        created_by=seeded_user,
    )

    assert run.status == TrainingRunStatus.PENDING
    assert run.total_epochs == 10
    assert run.adapter == "ultralytics_yolo"
    assert run.job_id is not None
    assert sent == [("model_train", [run.job_id])]


def test_create_run_refuses_a_second_active_run(db_session, seeded_dataset, seeded_user, monkeypatch):
    monkeypatch.setattr("app.training.service.celery_app.send_task", lambda *a, **kw: None)
    _succeeded_export(db_session, seeded_dataset.id, seeded_user)
    create_training_run(
        db_session,
        dataset_id=seeded_dataset.id,
        base_model="yolo11n.pt",
        config={"epochs": 1, "batch": 8},
        created_by=seeded_user,
    )

    with pytest.raises(RunAlreadyActive):
        create_training_run(
            db_session,
            dataset_id=seeded_dataset.id,
            base_model="yolo11n.pt",
            config={"epochs": 1, "batch": 8},
            created_by=seeded_user,
        )


def test_request_stop_sets_the_flag(db_session, seeded_dataset, seeded_user):
    run = TrainingRun(
        dataset_id=seeded_dataset.id,
        adapter="ultralytics_yolo",
        base_model="yolo11n.pt",
        task_type=seeded_dataset.task_type,
        config={},
        status=TrainingRunStatus.RUNNING,
        total_epochs=5,
        created_by_id=seeded_user.id,
    )
    db_session.add(run)
    db_session.commit()

    stopped = request_stop(db_session, run.id)

    assert stopped.stop_requested is True
    # Still RUNNING -- the worker decides when it actually ends.
    assert stopped.status == TrainingRunStatus.RUNNING


def test_request_stop_rejects_a_finished_run(db_session, seeded_dataset, seeded_user):
    run = TrainingRun(
        dataset_id=seeded_dataset.id,
        adapter="ultralytics_yolo",
        base_model="yolo11n.pt",
        task_type=seeded_dataset.task_type,
        config={},
        status=TrainingRunStatus.SUCCEEDED,
        total_epochs=5,
        created_by_id=seeded_user.id,
    )
    db_session.add(run)
    db_session.commit()

    with pytest.raises(RunNotStoppable):
        request_stop(db_session, run.id)
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && uv run pytest tests/training/test_service.py -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'app.training.service'`

- [ ] **Step 3: Write the schemas**

Create `backend/app/training/schemas.py`:

```python
from datetime import datetime

from pydantic import BaseModel, ConfigDict, Field

from app.datasets.models import TaskType
from app.training.models import TrainingRunStatus


class TrainingRunCreate(BaseModel):
    dataset_id: int
    base_model: str = Field(min_length=1, max_length=200)
    # Bounded rather than free-form: an accidental 100000-epoch run would
    # hold this single-GPU host's only worker for days.
    epochs: int = Field(ge=1, le=1000)
    batch: int = Field(ge=1, le=256)
    imgsz: int = Field(default=640, ge=32, le=4096)
    advanced: dict = Field(default_factory=dict)


class TrainingRunRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    dataset_id: int
    job_id: int | None
    adapter: str
    base_model: str
    task_type: TaskType
    config: dict
    status: TrainingRunStatus
    stop_requested: bool
    metrics: dict
    current_epoch: int
    total_epochs: int
    error: str | None
    created_at: datetime
    started_at: datetime | None
    finished_at: datetime | None


class TrainingLogRead(BaseModel):
    """The log tail past a caller-supplied offset. Never bundled into
    TrainingRunRead: over an hour log_text grows to megabytes, and the
    status is polled every two seconds."""

    text: str
    offset: int
    status: TrainingRunStatus


class ModelVersionRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    training_run_id: int
    name: str
    task_type: TaskType
    metrics: dict
    is_active: bool
    created_at: datetime


class ModelDownloadRead(BaseModel):
    download_url: str
```

- [ ] **Step 4: Write the service**

Create `backend/app/training/service.py`:

```python
"""Create, inspect and stop training runs.

A run is a Job like every other long operation here, executed by
ml-worker. What makes it different is the stop path: ml-worker runs
--pool=solo, so revoke(terminate=True) would SIGTERM the whole container.
Stopping is therefore a flag the adapter polls at epoch boundaries.
"""

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.auth.models import User
from app.celery_app import celery_app
from app.datasets.models import Dataset
from app.jobs.models import Job, JobStatus, JobType
from app.storage import StorageService
from app.training.models import ModelVersion, TrainingRun, TrainingRunStatus

ADAPTER_NAME = "ultralytics_yolo"

ACTIVE_STATUSES = (TrainingRunStatus.PENDING, TrainingRunStatus.RUNNING)


class DatasetNotExported(Exception):
    """The dataset has no finished export archive to train on."""


class RunAlreadyActive(Exception):
    """Another run is pending or running; ml-worker handles one at a time."""


class RunNotStoppable(Exception):
    """The run has already reached a terminal status."""


class TrainingRunNotFound(Exception):
    """No such run."""


class ModelVersionNotFound(Exception):
    """No such model version."""


def find_export_job(session: Session, dataset_id: int) -> Job | None:
    """The most recent succeeded export for this dataset, or None.

    The archive's location lives in Job.result_ref rather than on Dataset,
    so "is this dataset trainable?" is a job lookup, not a column read.
    """
    candidates = session.scalars(
        select(Job)
        .where(
            Job.job_type == JobType.DATASET_EXPORT,
            Job.status == JobStatus.SUCCEEDED,
            Job.result_ref.is_not(None),
        )
        .order_by(Job.id.desc())
    )
    for job in candidates:
        if job.payload.get("dataset_id") == dataset_id:
            return job
    return None


def create_training_run(
    session: Session,
    *,
    dataset_id: int,
    base_model: str,
    config: dict,
    created_by: User,
) -> TrainingRun:
    dataset = session.get(Dataset, dataset_id)
    if dataset is None:
        raise DatasetNotExported(f"Dataset {dataset_id} not found")

    export_job = find_export_job(session, dataset_id)
    if export_job is None:
        raise DatasetNotExported(
            f"Dataset {dataset_id} has no finished export; export it before training"
        )

    active = session.scalars(
        select(TrainingRun).where(TrainingRun.status.in_(ACTIVE_STATUSES))
    ).first()
    if active is not None:
        # Under --pool=solo a second run would merely queue, but a refusal
        # explains itself where a silent "pending" does not.
        raise RunAlreadyActive(f"Training run {active.id} is still active")

    run = TrainingRun(
        dataset_id=dataset_id,
        adapter=ADAPTER_NAME,
        base_model=base_model,
        task_type=dataset.task_type,
        config=config,
        total_epochs=int(config.get("epochs", 1)),
        created_by_id=created_by.id,
    )
    session.add(run)
    session.commit()
    session.refresh(run)

    job = Job(
        job_type=JobType.MODEL_TRAIN,
        status=JobStatus.PENDING,
        payload={
            "training_run_id": run.id,
            "export_key": export_job.result_ref,
        },
        created_by_id=created_by.id,
    )
    session.add(job)
    session.commit()
    session.refresh(job)

    run.job_id = job.id
    session.commit()
    session.refresh(run)

    # Default "celery" queue -- ml-worker consumes it, unlike the transcode
    # worker's video_transcode queue.
    celery_app.send_task("model_train", args=[job.id])
    return run


def get_run(session: Session, run_id: int) -> TrainingRun:
    run = session.get(TrainingRun, run_id)
    if run is None:
        raise TrainingRunNotFound(f"Training run {run_id} not found")
    return run


def request_stop(session: Session, run_id: int) -> TrainingRun:
    run = get_run(session, run_id)
    if run.status not in ACTIVE_STATUSES:
        raise RunNotStoppable(f"Training run {run_id} is {run.status.value}")

    run.stop_requested = True
    session.commit()
    session.refresh(run)
    return run


def list_runs(session: Session, status: TrainingRunStatus | None = None) -> list[TrainingRun]:
    statement = select(TrainingRun).order_by(TrainingRun.id.desc())
    if status is not None:
        statement = statement.where(TrainingRun.status == status)
    return list(session.scalars(statement))


def read_log(session: Session, run_id: int, offset: int) -> tuple[str, int, TrainingRunStatus]:
    run = get_run(session, run_id)
    text = run.log_text or ""
    if offset < 0 or offset > len(text):
        offset = 0
    tail = text[offset:]
    return tail, len(text), run.status


def list_model_versions(session: Session) -> list[ModelVersion]:
    return list(session.scalars(select(ModelVersion).order_by(ModelVersion.id.desc())))


def get_model_version(session: Session, version_id: int) -> ModelVersion:
    version = session.get(ModelVersion, version_id)
    if version is None:
        raise ModelVersionNotFound(f"Model version {version_id} not found")
    return version


def delete_model_version(session: Session, storage: StorageService, version_id: int) -> None:
    version = get_model_version(session, version_id)
    storage.delete(version.storage_key)
    session.delete(version)
    session.commit()
```

Note on `find_export_job`: it filters in Python rather than with a JSON-path query because no such query pattern exists in this codebase yet. Export jobs are few, and correctness beats a clever `payload->>` cast that nothing else here uses. If the export-job table ever grows large enough for this to matter, add an indexed column rather than a JSON-path filter.

- [ ] **Step 5: Run the tests**

Run: `cd backend && uv run pytest tests/training/test_service.py -v`
Expected: PASS (5 tests)

- [ ] **Step 6: Commit**

```bash
git add backend/app/training/service.py backend/app/training/schemas.py backend/tests/training/test_service.py
git commit -m "feat: add training run service with export and concurrency guards"
```

---

### Task 3: The `/training` API

**Files:**
- Create: `backend/app/training/router.py`
- Modify: `backend/app/main.py:26` (register the router)
- Modify: `openapi.json` (regenerated)
- Test: `backend/tests/training/test_router.py`

**Interfaces:**
- Consumes: everything Task 2 produced
- Produces: the eight endpoints under `/training` listed in the spec

- [ ] **Step 1: Write the failing test**

Create `backend/tests/training/test_router.py`. Follow the auth-header pattern used in `backend/tests/datasets/test_router.py` (grep it for how it obtains a token — reuse that fixture rather than inventing one):

```python
from app.jobs.models import Job, JobStatus, JobType


def test_create_run_returns_409_without_export(client, auth_headers, seeded_dataset):
    response = client.post(
        "/training/runs",
        headers=auth_headers,
        json={
            "dataset_id": seeded_dataset.id,
            "base_model": "yolo11n.pt",
            "epochs": 10,
            "batch": 8,
        },
    )
    assert response.status_code == 409
    assert "export" in response.json()["detail"].lower()


def test_create_run_returns_202(client, auth_headers, seeded_dataset, db_session, seeded_user, monkeypatch):
    monkeypatch.setattr("app.training.service.celery_app.send_task", lambda *a, **kw: None)
    db_session.add(
        Job(
            job_type=JobType.DATASET_EXPORT,
            status=JobStatus.SUCCEEDED,
            payload={"dataset_id": seeded_dataset.id},
            result_ref=f"exports/{seeded_dataset.id}/dataset.zip",
            created_by_id=seeded_user.id,
        )
    )
    db_session.commit()

    response = client.post(
        "/training/runs",
        headers=auth_headers,
        json={
            "dataset_id": seeded_dataset.id,
            "base_model": "yolo11n.pt",
            "epochs": 10,
            "batch": 8,
        },
    )

    assert response.status_code == 202
    body = response.json()
    assert body["status"] == "pending"
    assert body["total_epochs"] == 10


def test_log_endpoint_returns_tail_past_offset(client, auth_headers, db_session, seeded_dataset, seeded_user):
    from app.training.models import TrainingRun, TrainingRunStatus

    run = TrainingRun(
        dataset_id=seeded_dataset.id,
        adapter="ultralytics_yolo",
        base_model="yolo11n.pt",
        task_type=seeded_dataset.task_type,
        config={},
        status=TrainingRunStatus.RUNNING,
        log_text="line one\nline two\n",
        total_epochs=3,
        created_by_id=seeded_user.id,
    )
    db_session.add(run)
    db_session.commit()

    response = client.get(
        f"/training/runs/{run.id}/log?offset=9", headers=auth_headers
    )

    assert response.status_code == 200
    body = response.json()
    assert body["text"] == "line two\n"
    assert body["offset"] == 18


def test_stop_returns_409_for_a_finished_run(client, auth_headers, db_session, seeded_dataset, seeded_user):
    from app.training.models import TrainingRun, TrainingRunStatus

    run = TrainingRun(
        dataset_id=seeded_dataset.id,
        adapter="ultralytics_yolo",
        base_model="yolo11n.pt",
        task_type=seeded_dataset.task_type,
        config={},
        status=TrainingRunStatus.SUCCEEDED,
        total_epochs=3,
        created_by_id=seeded_user.id,
    )
    db_session.add(run)
    db_session.commit()

    response = client.post(f"/training/runs/{run.id}/stop", headers=auth_headers)

    assert response.status_code == 409


def test_models_list_is_empty_initially(client, auth_headers):
    response = client.get("/training/models", headers=auth_headers)
    assert response.status_code == 200
    assert isinstance(response.json(), list)
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && uv run pytest tests/training/test_router.py -v`
Expected: FAIL — 404s, because `/training` is not registered.

- [ ] **Step 3: Write the router**

Create `backend/app/training/router.py`, following `backend/app/datasets/router.py` for the dependency names (`get_db`, the current-user dependency, `get_storage_service`) — grep it and copy the exact imports rather than guessing:

```python
from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy.orm import Session

from app.auth.models import User
from app.db import get_db
from app.storage import StorageService, get_storage_service
from app.training import service
from app.training.models import TrainingRunStatus
from app.training.schemas import (
    ModelDownloadRead,
    ModelVersionRead,
    TrainingLogRead,
    TrainingRunCreate,
    TrainingRunRead,
)

router = APIRouter(prefix="/training", tags=["training"])


@router.post("/runs", response_model=TrainingRunRead, status_code=status.HTTP_202_ACCEPTED)
def create_run(
    body: TrainingRunCreate,
    session: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    config = {
        "epochs": body.epochs,
        "batch": body.batch,
        "imgsz": body.imgsz,
        **body.advanced,
    }
    try:
        return service.create_training_run(
            session,
            dataset_id=body.dataset_id,
            base_model=body.base_model,
            config=config,
            created_by=current_user,
        )
    except service.DatasetNotExported as exc:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=str(exc))
    except service.RunAlreadyActive as exc:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=str(exc))


@router.get("/runs", response_model=list[TrainingRunRead])
def list_runs(
    run_status: TrainingRunStatus | None = Query(default=None, alias="status"),
    session: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    return service.list_runs(session, run_status)


@router.get("/runs/{run_id}", response_model=TrainingRunRead)
def get_run(
    run_id: int,
    session: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    try:
        return service.get_run(session, run_id)
    except service.TrainingRunNotFound as exc:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(exc))


@router.get("/runs/{run_id}/log", response_model=TrainingLogRead)
def read_log(
    run_id: int,
    offset: int = Query(default=0, ge=0),
    session: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    try:
        text, new_offset, run_status = service.read_log(session, run_id, offset)
    except service.TrainingRunNotFound as exc:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(exc))
    return {"text": text, "offset": new_offset, "status": run_status}


@router.post("/runs/{run_id}/stop", response_model=TrainingRunRead)
def stop_run(
    run_id: int,
    session: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    try:
        return service.request_stop(session, run_id)
    except service.TrainingRunNotFound as exc:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(exc))
    except service.RunNotStoppable as exc:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=str(exc))


@router.get("/models", response_model=list[ModelVersionRead])
def list_models(
    session: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    return service.list_model_versions(session)


@router.get("/models/{version_id}/download", response_model=ModelDownloadRead)
def download_model(
    version_id: int,
    session: Session = Depends(get_db),
    storage: StorageService = Depends(get_storage_service),
    current_user: User = Depends(get_current_user),
):
    try:
        version = service.get_model_version(session, version_id)
    except service.ModelVersionNotFound as exc:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(exc))
    return {"download_url": storage.url_for(version.storage_key)}


@router.delete("/models/{version_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_model(
    version_id: int,
    session: Session = Depends(get_db),
    storage: StorageService = Depends(get_storage_service),
    current_user: User = Depends(get_current_user),
):
    try:
        service.delete_model_version(session, storage, version_id)
    except service.ModelVersionNotFound as exc:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(exc))
```

`get_current_user` above is a placeholder for whatever the real dependency is called — take the exact name and import path from `backend/app/datasets/router.py`.

- [ ] **Step 4: Register the router**

In `backend/app/main.py`, next to the other `include_router` calls:

```python
from app.training.router import router as training_router
...
app.include_router(training_router)
```

- [ ] **Step 5: Run the tests**

Run: `cd backend && uv run pytest tests/training/ -v`
Expected: PASS (all tests from Tasks 1-3)

- [ ] **Step 6: Regenerate OpenAPI**

```bash
cd backend && PYTHONPATH=. uv run python scripts/export_openapi.py
git diff --stat openapi.json
```
Expected: `openapi.json` shows changes. If it does not, the router is not registered.

- [ ] **Step 7: Commit**

```bash
git add backend/app/training/router.py backend/app/main.py backend/tests/training/test_router.py openapi.json
git commit -m "feat: add /training API for runs, logs and model versions"
```

---

### Task 4: The `TrainingAdapter` interface and the Ultralytics adapter

**Files:**
- Create: `ml-worker/app/training_adapter.py`
- Create: `ml-worker/app/ultralytics_yolo_adapter.py`
- Modify: `ml-worker/pyproject.toml` (add `ultralytics`)
- Test: `ml-worker/tests/test_training_adapter.py`

**Interfaces:**
- Consumes: nothing from earlier tasks (this is worker-side and standalone)
- Produces:
  - `TrainingRequest(dataset_dir: Path, task_type: str, base_model: str, config: dict, output_dir: Path)`
  - `TrainingResult(weights_path: Path, metrics: dict)`
  - `TrainingAdapter` protocol with `train(request, on_log, on_epoch, should_stop) -> TrainingResult`
  - `UltralyticsYoloAdapter`

- [ ] **Step 1: Write the failing test**

Create `ml-worker/tests/test_training_adapter.py`. This tests the *contract* against a fake trainer — no GPU, no Ultralytics import:

```python
from pathlib import Path

from app.training_adapter import TrainingAdapter, TrainingRequest, TrainingResult


class FakeLoopAdapter:
    """Stands in for a hand-written PyTorch loop -- the shape the interface
    is designed for, not Ultralytics'."""

    def train(self, request, on_log, on_epoch, should_stop):
        total = request.config["epochs"]
        completed = 0
        for epoch in range(1, total + 1):
            on_log(f"epoch {epoch}/{total} loss 0.5")
            on_epoch(epoch, total)
            completed = epoch
            if should_stop():
                break
        return TrainingResult(
            weights_path=request.output_dir / "last.pt",
            metrics={"epochs_completed": completed},
        )


def test_adapter_reports_every_epoch_and_line(tmp_path):
    lines: list[str] = []
    epochs: list[tuple[int, int]] = []
    adapter: TrainingAdapter = FakeLoopAdapter()

    result = adapter.train(
        TrainingRequest(
            dataset_dir=tmp_path / "ds",
            task_type="detection",
            base_model="yolo11n.pt",
            config={"epochs": 3},
            output_dir=tmp_path,
        ),
        on_log=lines.append,
        on_epoch=lambda e, t: epochs.append((e, t)),
        should_stop=lambda: False,
    )

    assert epochs == [(1, 3), (2, 3), (3, 3)]
    assert len(lines) == 3
    assert result.metrics["epochs_completed"] == 3


def test_should_stop_ends_the_run_early(tmp_path):
    epochs: list[tuple[int, int]] = []
    adapter: TrainingAdapter = FakeLoopAdapter()

    result = adapter.train(
        TrainingRequest(
            dataset_dir=tmp_path / "ds",
            task_type="detection",
            base_model="yolo11n.pt",
            config={"epochs": 10},
            output_dir=tmp_path,
        ),
        on_log=lambda line: None,
        on_epoch=lambda e, t: epochs.append((e, t)),
        # True from the first boundary onwards.
        should_stop=lambda: True,
    )

    assert epochs == [(1, 10)]
    assert result.metrics["epochs_completed"] == 1
    # Stopped runs still yield weights -- the boundary is after a save.
    assert result.weights_path == tmp_path / "last.pt"
```

- [ ] **Step 2: Run test to verify it fails**

```bash
docker cp ml-worker/tests/test_training_adapter.py $(docker compose ps -q ml-worker):/app/tests/
docker compose exec ml-worker python -m pytest tests/test_training_adapter.py -v
```
Expected: FAIL with `ModuleNotFoundError: No module named 'app.training_adapter'`

- [ ] **Step 3: Write the interface**

Create `ml-worker/app/training_adapter.py`:

```python
"""The interface every trainer implements.

Shaped for hand-written PyTorch loops, not for Ultralytics. The reference
platform trained RT-DETRv2, DINOv2 and ConvNeXt with hand-rolled loops and
only YOLO with Ultralytics; an interface modelled on YOLO.train() would
not fit three of those four. So control is handed *to* the adapter, which
calls back as it goes.

should_stop is a pull rather than a push: the worker cannot interrupt
someone else's training loop from outside, but the loop can ask.
"""

from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable, Protocol


@dataclass
class TrainingRequest:
    dataset_dir: Path
    task_type: str
    base_model: str
    config: dict
    output_dir: Path


@dataclass
class TrainingResult:
    weights_path: Path
    metrics: dict = field(default_factory=dict)


class TrainingAdapter(Protocol):
    def train(
        self,
        request: TrainingRequest,
        on_log: Callable[[str], None],
        on_epoch: Callable[[int, int], None],
        should_stop: Callable[[], bool],
    ) -> TrainingResult:
        """Train to completion, or until should_stop() returns True at an
        epoch boundary. Raise on failure; the caller records it."""
        ...
```

- [ ] **Step 4: Run the tests**

```bash
docker cp ml-worker/app/training_adapter.py $(docker compose ps -q ml-worker):/app/app/
docker compose exec ml-worker python -m pytest tests/test_training_adapter.py -v
```
Expected: PASS (2 tests)

- [ ] **Step 5: Add the ultralytics dependency**

In `ml-worker/pyproject.toml`, add `"ultralytics"` to the dependencies list. Then rebuild:

```bash
docker compose build ml-worker && docker compose up -d ml-worker
docker compose exec ml-worker python -c "import ultralytics; print(ultralytics.__version__)"
```
Expected: a version string. If the build fails on a torch version conflict, pin `ultralytics` to a release compatible with the image's installed torch rather than letting it upgrade torch — the CUDA pair in this image is deliberately pinned (see ROADMAP).

- [ ] **Step 6: Write the Ultralytics adapter**

Create `ml-worker/app/ultralytics_yolo_adapter.py`:

```python
"""The one working trainer: Ultralytics YOLO behind TrainingAdapter.

Ultralytics owns its own loop, so the three callbacks are wired through
its callback registry and a stdout capture rather than being called
directly the way a hand-written loop would.
"""

import contextlib
import io
import threading
from pathlib import Path

from app.training_adapter import TrainingRequest, TrainingResult


class _LineForwardingStream(io.TextIOBase):
    """Collects written text and forwards complete lines to on_log.

    Ultralytics prints its progress table to stdout; the log is kept raw
    (a deliberate decision -- four different trainers, no common format to
    parse), so whole lines are forwarded verbatim.
    """

    def __init__(self, on_log):
        self._on_log = on_log
        self._buffer = ""
        self._lock = threading.Lock()

    def write(self, text: str) -> int:
        with self._lock:
            self._buffer += text
            while "\n" in self._buffer:
                line, self._buffer = self._buffer.split("\n", 1)
                if line.strip():
                    self._on_log(line)
        return len(text)

    def flush(self) -> None:
        with self._lock:
            if self._buffer.strip():
                self._on_log(self._buffer)
            self._buffer = ""


class UltralyticsYoloAdapter:
    name = "ultralytics_yolo"

    def train(self, request: TrainingRequest, on_log, on_epoch, should_stop) -> TrainingResult:
        from ultralytics import YOLO

        total_epochs = int(request.config.get("epochs", 1))
        model = YOLO(request.base_model)

        def _on_epoch_end(trainer):
            epoch = int(getattr(trainer, "epoch", 0)) + 1
            on_epoch(epoch, total_epochs)
            if should_stop():
                on_log(f"Stop requested; ending after epoch {epoch}.")
                # Ultralytics checks this flag at the top of its next
                # iteration -- weights for this epoch are already written.
                trainer.stop = True

        model.add_callback("on_train_epoch_end", _on_epoch_end)

        stream = _LineForwardingStream(on_log)
        with contextlib.redirect_stdout(stream), contextlib.redirect_stderr(stream):
            results = model.train(
                data=str(request.dataset_dir / "data.yaml"),
                epochs=total_epochs,
                batch=int(request.config.get("batch", 8)),
                imgsz=int(request.config.get("imgsz", 640)),
                project=str(request.output_dir),
                name="run",
                exist_ok=True,
            )
        stream.flush()

        weights_path = Path(request.output_dir) / "run" / "weights" / "best.pt"
        if not weights_path.exists():
            # A stopped run has last.pt but may not have best.pt.
            weights_path = Path(request.output_dir) / "run" / "weights" / "last.pt"

        metrics = {}
        results_dict = getattr(results, "results_dict", None)
        if isinstance(results_dict, dict):
            metrics = {str(k): v for k, v in results_dict.items() if isinstance(v, (int, float))}

        return TrainingResult(weights_path=weights_path, metrics=metrics)
```

The exported archive's layout determines the `data.yaml` path above. Before writing this, confirm it by reading `backend/app/worker/export_task.py` and `backend/app/datasets/export.py` — if the YOLO export writes its config under a different name or a nested directory, use the real path.

- [ ] **Step 7: Commit**

```bash
git add ml-worker/app/training_adapter.py ml-worker/app/ultralytics_yolo_adapter.py ml-worker/tests/test_training_adapter.py ml-worker/pyproject.toml ml-worker/uv.lock
git commit -m "feat: add TrainingAdapter interface and Ultralytics YOLO adapter"
```

---

### Task 5: The `model_train` worker task

**Files:**
- Modify: `ml-worker/app/models.py` (add `TrainingRun`, `ModelVersion`, `TrainingRunStatus`)
- Modify: `ml-worker/app/tasks.py` (add `model_train`)
- Test: `ml-worker/tests/test_tasks_training.py`

**Interfaces:**
- Consumes: `TrainingAdapter`, `TrainingRequest`, `TrainingResult` (Task 4); the `training_runs` / `model_versions` tables (Task 1); `Job.payload = {"training_run_id": int, "export_key": str}` (Task 2)
- Produces: Celery task `model_train(job_id: int, adapter=None)`; `LOG_FLUSH_SECONDS = 2.0`, `LOG_FLUSH_LINES = 20`

- [ ] **Step 1: Add the worker-side model copies**

`ml-worker/app/models.py` is an independent copy of the backend's tables. Append the same two models and the status enum defined in Task 1, adjusting only the imports to this module's own `Base`. Copy the column definitions verbatim from `backend/app/training/models.py`, including `TaskType` — check whether `ml-worker/app/models.py` already declares `TaskType`; if not, declare it there with the same three members (`DETECTION`, `SEGMENTATION`, `CLASSIFICATION`).

- [ ] **Step 2: Write the failing test**

Create `ml-worker/tests/test_tasks_training.py`. Follow `ml-worker/tests/test_tasks.py` for its session/fixture pattern — read it first and reuse the same fixtures:

```python
from pathlib import Path

from app.models import JobStatus, ModelVersion, TrainingRun, TrainingRunStatus
from app.training_adapter import TrainingResult


class StubAdapter:
    def __init__(self, *, stop_after=None):
        self.stop_after = stop_after
        self.saw_stop = False

    def train(self, request, on_log, on_epoch, should_stop):
        total = int(request.config["epochs"])
        completed = 0
        for epoch in range(1, total + 1):
            on_log(f"epoch {epoch}/{total}")
            on_epoch(epoch, total)
            completed = epoch
            if should_stop():
                self.saw_stop = True
                break
        weights = request.output_dir / "weights.pt"
        weights.parent.mkdir(parents=True, exist_ok=True)
        weights.write_bytes(b"fake-weights")
        return TrainingResult(weights_path=weights, metrics={"mAP50": 0.5})


def test_successful_run_creates_a_model_version(training_job, db_session, monkeypatch, fake_storage):
    from app import tasks

    adapter = StubAdapter()
    tasks.model_train(training_job.id, adapter=adapter)

    run = db_session.get(TrainingRun, training_job.payload["training_run_id"])
    assert run.status == TrainingRunStatus.SUCCEEDED
    assert run.current_epoch == run.total_epochs
    assert "epoch 1/2" in run.log_text
    assert run.metrics["mAP50"] == 0.5

    version = db_session.query(ModelVersion).filter_by(training_run_id=run.id).one()
    assert version.storage_key.endswith(".pt")

    job = db_session.get(tasks.Job, training_job.id)
    assert job.status == JobStatus.SUCCEEDED


def test_stop_requested_ends_as_stopped_and_still_keeps_weights(
    training_job, db_session, monkeypatch, fake_storage
):
    from app import tasks

    run = db_session.get(TrainingRun, training_job.payload["training_run_id"])
    run.stop_requested = True
    db_session.commit()

    tasks.model_train(training_job.id, adapter=StubAdapter())

    db_session.refresh(run)
    assert run.status == TrainingRunStatus.STOPPED
    assert run.current_epoch == 1
    # A stopped run is not a failed one: Ultralytics has already written
    # weights by the epoch boundary, so the version is real.
    assert db_session.query(ModelVersion).filter_by(training_run_id=run.id).count() == 1


def test_adapter_failure_marks_the_run_failed(training_job, db_session, fake_storage):
    from app import tasks

    class ExplodingAdapter:
        def train(self, request, on_log, on_epoch, should_stop):
            on_log("starting")
            raise RuntimeError("CUDA out of memory")

    tasks.model_train(training_job.id, adapter=ExplodingAdapter())

    run = db_session.get(TrainingRun, training_job.payload["training_run_id"])
    assert run.status == TrainingRunStatus.FAILED
    assert "CUDA out of memory" in run.error
    # The log written before the crash survives -- it is the only diagnostic.
    assert "starting" in run.log_text
    assert db_session.query(ModelVersion).filter_by(training_run_id=run.id).count() == 0
```

You will need a `training_job` fixture (a `Job` with `job_type=MODEL_TRAIN`, a `TrainingRun` with `total_epochs=2`, and `payload={"training_run_id": ..., "export_key": "exports/1/dataset.zip"}`) and a `fake_storage` fixture whose `download()` returns a minimal zip containing a `data.yaml`. Add both to `ml-worker/tests/conftest.py` following the fixtures already there.

- [ ] **Step 3: Run test to verify it fails**

```bash
docker cp ml-worker/tests/test_tasks_training.py $(docker compose ps -q ml-worker):/app/tests/
docker cp ml-worker/tests/conftest.py $(docker compose ps -q ml-worker):/app/tests/
docker compose exec ml-worker python -m pytest tests/test_tasks_training.py -v
```
Expected: FAIL with `AttributeError: module 'app.tasks' has no attribute 'model_train'`

- [ ] **Step 4: Write the task**

Append to `ml-worker/app/tasks.py`:

```python
LOG_FLUSH_SECONDS = 2.0
LOG_FLUSH_LINES = 20


class _LogBuffer:
    """Accumulates log lines and flushes them to TrainingRun.log_text.

    Flushed on a cadence rather than per line: a multi-hour run at ~30
    single-row UPDATEs per minute costs Postgres nothing, while one UPDATE
    per line would not.
    """

    def __init__(self, session, run, flush_seconds=LOG_FLUSH_SECONDS, flush_lines=LOG_FLUSH_LINES):
        self._session = session
        self._run = run
        self._lines: list[str] = []
        self._flush_seconds = flush_seconds
        self._flush_lines = flush_lines
        self._last_flush = time.monotonic()

    def add(self, line: str) -> None:
        self._lines.append(line)
        elapsed = time.monotonic() - self._last_flush
        if len(self._lines) >= self._flush_lines or elapsed >= self._flush_seconds:
            self.flush()

    def flush(self) -> None:
        if not self._lines:
            return
        chunk = "\n".join(self._lines) + "\n"
        self._run.log_text = (self._run.log_text or "") + chunk
        self._session.commit()
        self._lines = []
        self._last_flush = time.monotonic()


@celery_app.task(name="model_train")
def model_train(job_id: int, adapter=None) -> None:
    """Train a model on an exported dataset.

    Runs on this worker's solo pool, which means annotation jobs queue
    behind it -- the accepted cost of one GPU. Stopping is cooperative:
    revoke(terminate=True) on a solo worker would SIGTERM the container,
    so the adapter polls TrainingRun.stop_requested at epoch boundaries.
    """
    session = SessionLocal()
    job = session.get(Job, job_id)
    if job is None:
        session.close()
        return

    run = session.get(TrainingRun, job.payload["training_run_id"])
    if run is None:
        job.status = JobStatus.FAILED
        job.error = f"TrainingRun {job.payload.get('training_run_id')} not found"
        job.finished_at = datetime.now(timezone.utc)
        session.commit()
        session.close()
        return

    if adapter is None:
        from app.ultralytics_yolo_adapter import UltralyticsYoloAdapter

        adapter = UltralyticsYoloAdapter()

    job.status = JobStatus.RUNNING
    job.started_at = datetime.now(timezone.utc)
    run.status = TrainingRunStatus.RUNNING
    run.started_at = job.started_at
    session.commit()

    buffer = _LogBuffer(session, run)
    storage = get_storage_service()

    def _on_log(line: str) -> None:
        buffer.add(line)

    def _on_epoch(epoch: int, total: int) -> None:
        buffer.flush()
        run.current_epoch = epoch
        run.total_epochs = total
        job.progress = int((epoch / total) * 100) if total else 0
        _record_vram_usage(job)
        session.commit()

    def _should_stop() -> bool:
        session.refresh(run)
        return bool(run.stop_requested)

    try:
        with tempfile.TemporaryDirectory() as workdir:
            work = Path(workdir)
            dataset_dir = work / "dataset"
            dataset_dir.mkdir()
            output_dir = work / "output"
            output_dir.mkdir()

            archive_bytes = storage.download(job.payload["export_key"])
            archive_path = work / "dataset.zip"
            archive_path.write_bytes(archive_bytes)
            with zipfile.ZipFile(archive_path) as archive:
                archive.extractall(dataset_dir)

            result = adapter.train(
                TrainingRequest(
                    dataset_dir=dataset_dir,
                    task_type=run.task_type.value,
                    base_model=run.base_model,
                    config=run.config,
                    output_dir=output_dir,
                ),
                on_log=_on_log,
                on_epoch=_on_epoch,
                should_stop=_should_stop,
            )

            buffer.flush()

            storage_key = f"models/{run.id}/{Path(result.weights_path).name}"
            storage.upload(
                storage_key,
                Path(result.weights_path).read_bytes(),
                "application/octet-stream",
            )

        version = ModelVersion(
            training_run_id=run.id,
            name=f"{run.base_model.rsplit('.', 1)[0]}-run{run.id}",
            task_type=run.task_type,
            storage_key=storage_key,
            metrics=result.metrics,
        )
        session.add(version)

        run.status = (
            TrainingRunStatus.STOPPED if run.stop_requested else TrainingRunStatus.SUCCEEDED
        )
        run.metrics = result.metrics
        run.finished_at = datetime.now(timezone.utc)
        job.status = JobStatus.SUCCEEDED
        job.progress = 100
        job.result_ref = storage_key
        job.finished_at = run.finished_at
        session.commit()
    except Exception as exc:  # noqa: BLE001 -- recorded, not swallowed
        buffer.flush()
        run.status = TrainingRunStatus.FAILED
        run.error = str(exc)[:2000]
        run.finished_at = datetime.now(timezone.utc)
        job.status = JobStatus.FAILED
        job.error = str(exc)[:2000]
        job.finished_at = run.finished_at
        session.commit()
        raise
    finally:
        session.close()
```

Add the imports this needs at the top of `tasks.py`: `time`, `tempfile`, `zipfile`, `from pathlib import Path`, `from app.models import ModelVersion, TrainingRun, TrainingRunStatus`, and `from app.training_adapter import TrainingRequest`. Several (`datetime`, `timezone`, `SessionLocal`, `Job`, `JobStatus`, `get_storage_service`, `_record_vram_usage`) are already imported — check before adding duplicates.

The `raise` in the exception handler re-raises after recording, matching how the other tasks in this file surface failures to Celery. Verify that against the existing `run_sam2_track` handler and match whatever it does.

- [ ] **Step 5: Run the tests**

```bash
docker cp ml-worker/app/models.py ml-worker/app/tasks.py $(docker compose ps -q ml-worker):/app/app/
docker compose exec ml-worker python -m pytest tests/test_tasks_training.py -v
```
Expected: PASS (3 tests)

- [ ] **Step 6: Run the whole worker suite for regressions**

```bash
docker compose exec ml-worker python -m pytest tests/ -v
```
Expected: no new failures beyond the pre-existing ones recorded in ROADMAP.

- [ ] **Step 7: Commit**

```bash
git add ml-worker/app/models.py ml-worker/app/tasks.py ml-worker/tests/test_tasks_training.py ml-worker/tests/conftest.py
git commit -m "feat: add model_train worker task with chunked log flushing"
```

---

### Task 6: The config form

**Files:**
- Create: `frontend/src/features/training/TrainConfigForm.tsx`
- Test: `frontend/src/features/training/TrainConfigForm.test.tsx`

**Interfaces:**
- Consumes: `GET /datasets`, `GET /training/runs` (Task 3)
- Produces: `TrainConfigForm` with props
  `{ datasets: DatasetOption[]; disabled: boolean; onSubmit: (values: TrainConfigValues) => void }`
  where `DatasetOption = { id: number; name: string; exported: boolean }`
  and `TrainConfigValues = { datasetId: number; baseModel: string; epochs: number; batch: number; imgsz: number }`

- [ ] **Step 1: Write the failing test**

Create `frontend/src/features/training/TrainConfigForm.test.tsx`. Read `frontend/src/features/datasets/DatasetsTable.test.tsx` first and match its imports and render helpers:

```tsx
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { TrainConfigForm } from "./TrainConfigForm";

const datasets = [
  { id: 1, name: "polyps-v1", exported: true },
  { id: 2, name: "polyps-v2-draft", exported: false },
];

describe("TrainConfigForm", () => {
  it("marks datasets without an export as unselectable", () => {
    render(<TrainConfigForm datasets={datasets} disabled={false} onSubmit={vi.fn()} />);

    const notExported = screen.getByRole("option", { name: /polyps-v2-draft/ });
    expect(notExported).toBeDisabled();
    expect(notExported.textContent).toMatch(/export it first/i);
  });

  it("submits the entered configuration", () => {
    const onSubmit = vi.fn();
    render(<TrainConfigForm datasets={datasets} disabled={false} onSubmit={onSubmit} />);

    fireEvent.change(screen.getByLabelText(/dataset/i), { target: { value: "1" } });
    fireEvent.change(screen.getByLabelText(/epochs/i), { target: { value: "25" } });
    fireEvent.change(screen.getByLabelText(/batch/i), { target: { value: "16" } });
    fireEvent.click(screen.getByRole("button", { name: /start training/i }));

    expect(onSubmit).toHaveBeenCalledWith({
      datasetId: 1,
      baseModel: expect.any(String),
      epochs: 25,
      batch: 16,
      imgsz: 640,
    });
  });

  it("disables the start button while a run is active", () => {
    render(<TrainConfigForm datasets={datasets} disabled onSubmit={vi.fn()} />);

    expect(screen.getByRole("button", { name: /start training/i })).toBeDisabled();
  });

  it("keeps advanced settings collapsed until opened", () => {
    render(<TrainConfigForm datasets={datasets} disabled={false} onSubmit={vi.fn()} />);

    expect(screen.queryByLabelText(/image size/i)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /advanced/i }));
    expect(screen.getByLabelText(/image size/i)).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npm test -- TrainConfigForm`
Expected: FAIL — cannot resolve `./TrainConfigForm`

- [ ] **Step 3: Write the component**

Create `frontend/src/features/training/TrainConfigForm.tsx`. Match the styling of `frontend/src/features/datasets/` components — dark theme only, no light-background classes. The base-model select offers `yolo11n.pt`, `yolo11s.pt`, `yolo11m.pt`, with `yolo11n.pt` as the default. The "Advanced" section is a collapsed `<button>` toggling a panel that holds Image size (default 640). Non-exported datasets render as `<option disabled>` with "— export it first" appended to their label.

- [ ] **Step 4: Run the tests**

Run: `cd frontend && npm test -- TrainConfigForm`
Expected: PASS (4 tests)

- [ ] **Step 5: Commit**

```bash
git add frontend/src/features/training/TrainConfigForm.tsx frontend/src/features/training/TrainConfigForm.test.tsx
git commit -m "feat: add the Train screen config form"
```

---

### Task 7: The live run panel

**Files:**
- Create: `frontend/src/features/training/TrainRunPanel.tsx`
- Test: `frontend/src/features/training/TrainRunPanel.test.tsx`

**Interfaces:**
- Consumes: `TrainingRunRead` and `TrainingLogRead` shapes (Task 3)
- Produces: `TrainRunPanel` with props
  `{ run: TrainingRunRead | null; logText: string; onStop: () => void; stopPending: boolean }`

- [ ] **Step 1: Write the failing test**

Create `frontend/src/features/training/TrainRunPanel.test.tsx`:

```tsx
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { TrainRunPanel } from "./TrainRunPanel";

const runningRun = {
  id: 7,
  status: "running" as const,
  current_epoch: 3,
  total_epochs: 50,
  stop_requested: false,
  error: null,
  metrics: {},
};

describe("TrainRunPanel", () => {
  it("prompts to start a run when there is none", () => {
    render(<TrainRunPanel run={null} logText="" onStop={vi.fn()} stopPending={false} />);

    expect(screen.getByText(/no training run/i)).toBeInTheDocument();
  });

  it("shows progress by epoch and the raw log", () => {
    render(
      <TrainRunPanel
        run={runningRun}
        logText={"epoch 1/50 loss 0.9\nepoch 2/50 loss 0.7\n"}
        onStop={vi.fn()}
        stopPending={false}
      />,
    );

    expect(screen.getByText("Epoch 3 / 50")).toBeInTheDocument();
    expect(screen.getByText(/epoch 2\/50 loss 0.7/)).toBeInTheDocument();
    expect(screen.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "6");
  });

  it("says that stopping waits for the current epoch", () => {
    render(<TrainRunPanel run={runningRun} logText="" onStop={vi.fn()} stopPending={false} />);

    expect(screen.getByText(/after the current epoch/i)).toBeInTheDocument();
  });

  it("calls onStop when Stop is clicked", () => {
    const onStop = vi.fn();
    render(<TrainRunPanel run={runningRun} logText="" onStop={onStop} stopPending={false} />);

    fireEvent.click(screen.getByRole("button", { name: /^stop$/i }));

    expect(onStop).toHaveBeenCalledTimes(1);
  });

  it("reports that a stop is pending once requested", () => {
    render(
      <TrainRunPanel
        run={{ ...runningRun, stop_requested: true }}
        logText=""
        onStop={vi.fn()}
        stopPending
      />,
    );

    expect(screen.getByRole("button", { name: /stopping/i })).toBeDisabled();
  });

  it("hides Stop for a finished run and shows its error", () => {
    render(
      <TrainRunPanel
        run={{ ...runningRun, status: "failed", error: "CUDA out of memory" }}
        logText=""
        onStop={vi.fn()}
        stopPending={false}
      />,
    );

    expect(screen.queryByRole("button", { name: /stop/i })).not.toBeInTheDocument();
    expect(screen.getByText(/CUDA out of memory/)).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npm test -- TrainRunPanel`
Expected: FAIL — cannot resolve `./TrainRunPanel`

- [ ] **Step 3: Write the component**

Create `frontend/src/features/training/TrainRunPanel.tsx`:
- a status badge per `run.status`,
- a progress bar with `role="progressbar"` and `aria-valuenow` = `Math.round((current_epoch / total_epochs) * 100)`,
- the text `Epoch {current_epoch} / {total_epochs}`,
- a monospace `<pre>` in a scrollable container showing `logText`, scrolled to the bottom on update via a `ref` and `useEffect`,
- a Stop button shown only while `status` is `pending` or `running`, labelled "Stopping…" and disabled when `stopPending || run.stop_requested`, with the helper line "Stops after the current epoch finishes.",
- `run.error` rendered when present.

- [ ] **Step 4: Run the tests**

Run: `cd frontend && npm test -- TrainRunPanel`
Expected: PASS (6 tests)

- [ ] **Step 5: Commit**

```bash
git add frontend/src/features/training/TrainRunPanel.tsx frontend/src/features/training/TrainRunPanel.test.tsx
git commit -m "feat: add the live training run panel"
```

---

### Task 8: The model versions table

**Files:**
- Create: `frontend/src/features/training/ModelVersionsTable.tsx`
- Test: `frontend/src/features/training/ModelVersionsTable.test.tsx`

**Interfaces:**
- Consumes: `ModelVersionRead` (Task 3)
- Produces: `ModelVersionsTable` with props
  `{ versions: ModelVersionRead[]; onDownload: (id: number) => void; onDelete: (id: number) => void }`

- [ ] **Step 1: Write the failing test**

Create `frontend/src/features/training/ModelVersionsTable.test.tsx`:

```tsx
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { ModelVersionsTable } from "./ModelVersionsTable";

const versions = [
  {
    id: 4,
    training_run_id: 7,
    name: "yolo11n-run7",
    task_type: "detection" as const,
    metrics: { "metrics/mAP50(B)": 0.712 },
    is_active: false,
    created_at: "2026-08-19T10:00:00Z",
  },
];

describe("ModelVersionsTable", () => {
  it("shows an empty state with no versions", () => {
    render(<ModelVersionsTable versions={[]} onDownload={vi.fn()} onDelete={vi.fn()} />);

    expect(screen.getByText(/no trained models yet/i)).toBeInTheDocument();
  });

  it("renders the headline metric", () => {
    render(<ModelVersionsTable versions={versions} onDownload={vi.fn()} onDelete={vi.fn()} />);

    expect(screen.getByText("yolo11n-run7")).toBeInTheDocument();
    expect(screen.getByText("0.712")).toBeInTheDocument();
  });

  it("shows a dash when no mAP50 is recorded", () => {
    render(
      <ModelVersionsTable
        versions={[{ ...versions[0], metrics: {} }]}
        onDownload={vi.fn()}
        onDelete={vi.fn()}
      />,
    );

    expect(screen.getByText("—")).toBeInTheDocument();
  });

  it("calls the action handlers with the version id", () => {
    const onDownload = vi.fn();
    const onDelete = vi.fn();
    render(
      <ModelVersionsTable versions={versions} onDownload={onDownload} onDelete={onDelete} />,
    );

    fireEvent.click(screen.getByRole("button", { name: /download/i }));
    fireEvent.click(screen.getByRole("button", { name: /delete/i }));

    expect(onDownload).toHaveBeenCalledWith(4);
    expect(onDelete).toHaveBeenCalledWith(4);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npm test -- ModelVersionsTable`
Expected: FAIL — cannot resolve `./ModelVersionsTable`

- [ ] **Step 3: Write the component**

Create `frontend/src/features/training/ModelVersionsTable.tsx` with columns Name, Type, mAP50, Created, Actions. The headline metric reads `metrics["metrics/mAP50(B)"]` (Ultralytics' own key) falling back to `metrics["mAP50"]`, formatted to three decimals, or `—` when absent. Follow `frontend/src/features/datasets/DatasetsTable.tsx` for table styling and the empty state.

- [ ] **Step 4: Run the tests**

Run: `cd frontend && npm test -- ModelVersionsTable`
Expected: PASS (4 tests)

- [ ] **Step 5: Commit**

```bash
git add frontend/src/features/training/ModelVersionsTable.tsx frontend/src/features/training/ModelVersionsTable.test.tsx
git commit -m "feat: add the model versions table"
```

---

### Task 9: The Train page, polling, and the route

**Files:**
- Create: `frontend/src/features/training/TrainPage.tsx`
- Modify: `frontend/src/app/App.tsx:34` (add the route)
- Modify: `frontend/src/app/AppHeader.tsx` (add the nav entry)
- Test: `frontend/src/features/training/TrainPage.test.tsx`

**Interfaces:**
- Consumes: `TrainConfigForm` (Task 6), `TrainRunPanel` (Task 7), `ModelVersionsTable` (Task 8), the `/training` API (Task 3), `apiClient`
- Produces: the `/train` route

- [ ] **Step 1: Write the failing test**

Create `frontend/src/features/training/TrainPage.test.tsx`. Read an existing page test (`frontend/src/features/datasets/DatasetsPage.test.tsx`) for how `apiClient` is mocked and copy that setup exactly:

```tsx
import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { TrainPage } from "./TrainPage";

vi.mock("../../shared/api/client", () => ({
  apiClient: { GET: vi.fn(), POST: vi.fn(), DELETE: vi.fn() },
}));

const { apiClient } = await import("../../shared/api/client");

describe("TrainPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(apiClient.GET).mockImplementation(async (path: string) => {
      if (path === "/datasets") {
        return { data: [{ id: 1, name: "polyps-v1", task_type: "detection" }] };
      }
      if (path === "/training/runs") {
        return { data: [] };
      }
      if (path === "/training/models") {
        return { data: [] };
      }
      return { data: null };
    });
  });

  it("renders the YOLO tab and the config form", async () => {
    render(<TrainPage />);

    expect(await screen.findByRole("tab", { name: /yolo/i })).toBeInTheDocument();
    expect(await screen.findByRole("button", { name: /start training/i })).toBeInTheDocument();
  });

  it("shows the empty run state when no run exists", async () => {
    render(<TrainPage />);

    expect(await screen.findByText(/no training run/i)).toBeInTheDocument();
  });

  it("polls the log while a run is active", async () => {
    vi.useFakeTimers();
    vi.mocked(apiClient.GET).mockImplementation(async (path: string) => {
      if (path === "/datasets") return { data: [{ id: 1, name: "polyps-v1", task_type: "detection" }] };
      if (path === "/training/runs") {
        return {
          data: [
            {
              id: 7,
              status: "running",
              current_epoch: 1,
              total_epochs: 10,
              stop_requested: false,
              error: null,
              metrics: {},
            },
          ],
        };
      }
      if (path.startsWith("/training/runs/7/log")) {
        return { data: { text: "epoch 1/10\n", offset: 12, status: "running" } };
      }
      return { data: [] };
    });

    render(<TrainPage />);

    await waitFor(() =>
      expect(vi.mocked(apiClient.GET)).toHaveBeenCalledWith(
        expect.stringContaining("/training/runs/7/log"),
        expect.anything(),
      ),
    );
    vi.useRealTimers();
  });
});
```

Adjust the mock shape to whatever `apiClient` actually is — if it is `openapi-fetch`, calls take `(path, { params })` and return `{ data, error }`. Read the existing page test and match it; do not invent a different client shape.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npm test -- TrainPage`
Expected: FAIL — cannot resolve `./TrainPage`

- [ ] **Step 3: Write the page**

Create `frontend/src/features/training/TrainPage.tsx`:
- on mount, fetch `/datasets`, `/training/runs`, `/training/models`;
- derive each dataset's `exported` flag — the backend does not expose it, so add a small helper that treats a dataset as exported when a succeeded `DATASET_EXPORT` job exists for it. If `GET /jobs` supports filtering by type, use it; otherwise **add `exported: bool` to `DatasetRead` in the backend** and regenerate `openapi.json`. Prefer the second option: it is one column of derived data and avoids a second round trip per dataset.
- the active run is the first entry of `/training/runs` whose status is `pending` or `running`; otherwise show the most recent run;
- while a run is active, run a single 2-second interval that fetches `/training/runs/{id}` and `/training/runs/{id}/log?offset={offset}`, appending `text` to local state and storing the returned `offset`. Clear the interval once the status is terminal;
- `onSubmit` POSTs `/training/runs`, then refetches;
- `onStop` POSTs `/training/runs/{id}/stop`;
- `onDownload` GETs `/training/models/{id}/download` and opens `download_url`;
- `onDelete` DELETEs, then refetches the versions;
- a tab strip with a single "YOLO" tab, `role="tab"`, `aria-selected="true"`.

- [ ] **Step 4: Add the route and the nav entry**

In `frontend/src/app/App.tsx`, alongside the other routes:

```tsx
          <Route path="/train" element={<TrainPage />} />
```

with the matching import. In `frontend/src/app/AppHeader.tsx`, add a "Train" entry between Datasets and Settings, following the existing entries' shape. Check `AppHeader.test.tsx` — if it asserts the full list of nav items, update that assertion too.

- [ ] **Step 5: Run the tests**

Run: `cd frontend && npm test -- TrainPage AppHeader`
Expected: PASS

- [ ] **Step 6: Run the full frontend suite and build**

```bash
cd frontend && npm test && npm run build
```
Expected: no new failures beyond the pre-existing ones recorded in ROADMAP (`npm run build` is already red there — confirm the errors are the same ones, not new).

- [ ] **Step 7: Commit**

```bash
git add frontend/src/features/training/TrainPage.tsx frontend/src/features/training/TrainPage.test.tsx frontend/src/app/App.tsx frontend/src/app/AppHeader.tsx frontend/src/app/AppHeader.test.tsx
git commit -m "feat: add the Train screen with live run polling"
```

---

### Task 10: Real-browser verification and ROADMAP entry

This project has three times shipped bugs that every unit test passed over — CORS, auth persistence, a fresh-clone build failure — because `TestClient` sends no real `Origin` and frontend tests mock `apiClient` entirely. Nothing here is trusted until it has been clicked.

**Files:**
- Modify: `ROADMAP.md` (Phase 2b entry)

- [ ] **Step 1: Start the full stack**

```bash
docker compose up -d
cd backend && uv run uvicorn app.main:app --reload &
cd frontend && npm run dev &
```

Confirm `ml-worker` is up: `docker compose logs --tail=20 ml-worker`.

- [ ] **Step 2: Prepare a dataset**

Log in as `manualcheck@example.com`. Create a small dataset (a handful of sequences is enough) and run its export to completion — training refuses a dataset without a finished archive, which is itself worth confirming.

- [ ] **Step 3: Verify the refusal path first**

On `/train`, confirm a dataset with no export appears disabled with "export it first". Confirm the exported one is selectable.

- [ ] **Step 4: Start a short run**

Set epochs to 2 or 3 so this finishes in minutes. Click "Start training" and confirm:
- the status badge goes pending → running,
- raw log lines appear and keep appending,
- the log pane follows the tail,
- "Epoch N / M" advances and the progress bar moves,
- a browser refresh mid-run shows the log so far rather than an empty pane.

- [ ] **Step 5: Verify Stop on a second, longer run**

Start a run with 50 epochs, wait for epoch 2, click Stop. Confirm the button shows "Stopping…", the run ends within one epoch, its status is `stopped` (not `failed`), and a `ModelVersion` row appears in the table.

- [ ] **Step 6: Verify the artifact**

Download the weights from the table and confirm the file is a real `.pt` of plausible size. Delete a version and confirm the row disappears and the object is gone:

```bash
docker compose exec minio mc ls local/<bucket>/models/ 2>/dev/null || true
```

- [ ] **Step 7: Verify the accepted trade-off is visible, not silent**

While a run is going, open a sequence and start a SAM2 predict. Confirm the job sits at `pending` and completes after training ends — this is the documented cost of one GPU, and it should look like a queue rather than a hang.

- [ ] **Step 8: Record the outcome in ROADMAP**

Replace the `### Phase 2b: Train screen — DESIGN STARTED 2026-08-18, NOT IMPLEMENTED` heading with `— DONE (YYYY-MM-DD)`, add a one-line summary and a deviation log covering anything that differed from this plan. Note explicitly whether the GPU held up under a real training run, since the host's crash history is an open issue.

- [ ] **Step 9: Commit**

```bash
git add ROADMAP.md
git commit -m "docs: record the Train screen as implemented"
```

---

## Self-Review

**Spec coverage:** log in Postgres with chunked flush (Tasks 1, 5) and the offset endpoint (Tasks 2, 3); `TrainingRun` / `ModelVersion` split (Task 1); `ModelVersion` only on succeeded/stopped (Task 5); `JobType.MODEL_TRAIN` (Task 1); solo-queue execution and cooperative Stop (Tasks 2, 5, 7, 10 step 7); adapter interface shaped for hand-written loops (Task 4); Ultralytics adapter and dependency (Task 4); export-required rule (Tasks 2, 6, 9); second-run 409 (Tasks 2, 3); all eight endpoints (Task 3); screen layout, tabs, polling (Tasks 6-9); four test layers plus the browser pass (Tasks 1-10).

**Known soft spots the executor must resolve rather than guess:**
- the exact fixture names in `backend/tests/conftest.py` and `ml-worker/tests/conftest.py`;
- the current-user dependency's name in the backend routers;
- `apiClient`'s real call shape in frontend tests;
- the exported archive's internal layout, which determines the `data.yaml` path in Task 4;
- how `exported` reaches the frontend in Task 9 — the plan recommends a backend field over a second round trip.

Each is flagged inline at the point it matters, with instructions to read the existing code rather than invent a shape.
