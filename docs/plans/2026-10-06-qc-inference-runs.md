# QC Inference Runs Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the unbuilt Results screen with a `QC` screen where a detect/segment model is run over a video as a job, the raw predictions are stored, and the result is viewed with a canvas overlay and a history table.

**Architecture:** A new backend module `app/inference/` (table `inference_runs`, REST API under `/inference`) mirrors `app/training/`. The run is executed by a new `inference_run` Celery task in `ml-worker` behind an `InferenceAdapter` Protocol with an Ultralytics implementation; it writes one predictions JSON to object storage. The frontend adds `features/qc/` and `entities/useInferenceRuns.ts` and draws the overlay on a canvas over a plain `<video>`.

**Tech Stack:** FastAPI, SQLAlchemy, Alembic, Celery, Ultralytics YOLO, OpenCV, MinIO (boto3), React, TanStack Query, openapi-fetch, Vitest.

**Spec:** [docs/specs/2026-10-06-qc-inference-runs-design.md](../specs/2026-10-06-qc-inference-runs-design.md). Task 1 amends it first, because planning surfaced six ambiguities (listed there).

## Global Constraints

- English only: code, comments, docstrings, UI copy, commit messages. No Russian in the repo.
- Work directly on `master`. No branches, no worktrees.
- Dark theme only; do not add light-background classes.
- All binary data goes through `StorageService`; the only sanctioned temp-file use is OpenCV needing a real path.
- Frontend API access goes through `apiClient`; never write an untyped `fetch()` against the API. (Fetching a presigned object-storage URL returned by the API is not an API call and is the one use of bare `fetch`.)
- Tests must never write to the real `endoscopy` database. Backend: `import app.db as db_module` and `db_module.SessionLocal()`, never `from app.db import SessionLocal`. `ml-worker` tests do use the dev database by design (see `ml-worker/tests/conftest.py`), so every fixture must delete what it creates.
- After any backend schema or route change, regenerate `openapi.json`: `cd backend && PYTHONPATH=. uv run python scripts/export_openapi.py`, then check `git diff --stat openapi.json`.
- `npm install` needs `--legacy-peer-deps`. Never hand-edit `frontend/src/shared/api/generated/`.
- ml-worker tests run inside the container: `docker compose up -d ml-worker`, `docker compose exec ml-worker rm -rf /app/tests`, `docker cp ml-worker/app endoscopy-platform-ml-worker-1:/app/app`, `docker cp ml-worker/tests endoscopy-platform-ml-worker-1:/app/tests`, then `docker compose exec ml-worker uv run pytest <path> -v`. Never start the transcode worker without `-Q video_transcode`.
- Every commit message ends with `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>` (second `-m`).
- Do not touch the port conflict on :5173 (another project's Vite holds it). Task 8 needs it and says what to ask.

## Review Focus

The spec implies these inputs but no happy-path test exercises them; each line has a test in the named task.

1. A video that cannot be opened or has no readable frames must end the run as `failed` with a message, never hang as `running` (Task 3, Task 4).
2. Deleting a run that is still `pending`/`running` must be refused (409), not orphan the worker's row (Task 2).
3. A run must stay readable and viewable after its `ModelVersion` is deleted (Task 1, Task 2).
4. `frame_stride` larger than the video must still process frame 0 and produce a valid document (Task 3).
5. Asking for predictions before the run has succeeded must be a 409, not a 500 or an empty link (Task 2).

## File Structure

Create:
- `backend/app/inference/__init__.py`, `models.py`, `schemas.py`, `service.py`, `router.py`
- `backend/alembic/versions/d3e4f5a6b7c8_add_inference_runs.py`
- `backend/tests/test_inference_api.py`
- `ml-worker/app/inference_adapter.py` (Protocol + dataclasses)
- `ml-worker/app/ultralytics_inference_adapter.py`
- `ml-worker/tests/test_ultralytics_inference_adapter.py`, `ml-worker/tests/test_tasks_inference.py`
- `frontend/src/entities/useInferenceRuns.ts`, `useModelVersions.ts`
- `frontend/src/features/qc/predictions.ts` (+test), `drawDetections.ts` (+test), `RunForm.tsx` (+test), `RunStatus.tsx` (+test), `RunsTable.tsx` (+test), `QcPage.tsx`, `RunViewPage.tsx`, `PredictionOverlay.tsx`

Modify:
- `backend/app/jobs/models.py` (`JobType.INFERENCE_RUN`), `backend/app/main.py` (router), `backend/tests/conftest.py` (seed fixture)
- `ml-worker/app/models.py`, `ml-worker/app/tasks.py`, `ml-worker/tests/conftest.py`
- `frontend/src/app/AppHeader.tsx` (+test), `frontend/src/app/App.tsx`
- `docs/specs/2026-10-06-qc-inference-runs-design.md`, `docs/specs/2026-07-23-platform-ui-ux-design.md`, `ROADMAP.md`, `openapi.json`

---

### Task 1: Amend the spec, add the table, migration and `JobType`

**Files:**
- Modify: `docs/specs/2026-10-06-qc-inference-runs-design.md`
- Create: `backend/app/inference/__init__.py`, `backend/app/inference/models.py`
- Create: `backend/alembic/versions/d3e4f5a6b7c8_add_inference_runs.py`
- Modify: `backend/app/jobs/models.py`, `backend/tests/conftest.py`
- Test: `backend/tests/test_inference_api.py` (first test only)

**Interfaces:**
- Produces: `app.inference.models.InferenceRun`, `InferenceRunStatus` (`PENDING`, `RUNNING`, `SUCCEEDED`, `FAILED`); `JobType.INFERENCE_RUN = "inference_run"`; the conftest fixture `committed_inference_rows` returning a `SimpleNamespace(user_id, video_id, playable_video_id, unplayable_video_id, detect_version_id, segment_version_id, classify_version_id)`.

- [ ] **Step 1: Amend the spec**

Apply these edits to `docs/specs/2026-10-06-qc-inference-runs-design.md`:

1. In `### Predictions JSON`, change `"task_type": "detect | segment"` to `"task_type": "detection | segmentation"` and add below the example: "`task_type` uses the `TaskType` enum values. `bbox` is `[x, y, w, h]` normalised to 0..1 with `(x, y)` the **top-left** corner."
2. In `### \`inference_runs\` table`, add `model_name` (copied from the model version at creation) to the column list and replace the sentence "the history shows the model name from the JSON" with "the history shows `model_name`, which is also copied at creation".
3. In `### API`, under `DELETE /runs/{id}` add: "Refused with 409 while the run is `pending` or `running`."
4. In `## Frontend`, replace the sentence about `requestVideoFrameCallback` with: "The overlay redraws from a `requestAnimationFrame` loop that draws only when the video time or the element size changed, which also covers paused and scrubbed states."
5. In `## Frontend` and `### /qc`, replace "drop zone" with "the existing `VideoUploadFlow` form (title, procedure, file input); drag-and-drop is not added in this sub-project."
6. In `## Open items for the implementation plan`, replace the first two bullets with: "- Resolved: an Alembic migration is needed (new `JobType` value and table), and `VideoReviewPlayer` is coupled to sequences and cropping, so the QC player is a new component." and keep the third bullet unchanged.

- [ ] **Step 2: Write the failing test and the seed fixture**

Append to `backend/tests/conftest.py`:

```python
@pytest.fixture
def committed_inference_rows():
    """Committed rows the inference API tests need, deleted afterwards.

    TestClient requests run on their own sessions, so rows seeded through
    the rolled-back `db_session` would be invisible to them. Everything
    here is deleted in teardown, children before parents.
    """
    from types import SimpleNamespace

    from app.auth.models import User, UserRole
    from app.datasets.models import Dataset, TaskType
    from app.inference.models import InferenceRun
    from app.jobs.models import Job
    from app.media.models import Video
    from app.training.models import ModelVersion, TrainingRun

    session = db_module.SessionLocal()
    user = User(email="inference-seed@example.com", hashed_password="x", role=UserRole.ADMIN)
    session.add(user)
    session.commit()
    dataset = Dataset(
        name="ds-inference-seed",
        task_type=TaskType.DETECTION,
        taxonomy_version=1,
        split_config={"train": 80, "val": 20},
        grouping_overrides={},
        excluded_label_ids=[],
        balance_metrics={},
        created_by_id=user.id,
    )
    session.add(dataset)
    session.commit()

    def _video(title: str, playable: bool | None) -> Video:
        video = Video(
            storage_key=f"videos/{title}.mp4",
            filename=f"{title}.mp4",
            title=title,
            fps=25.0,
            duration_seconds=10.0,
            size_bytes=1,
            checksum=title,
            browser_playable=playable,
        )
        session.add(video)
        return video

    playable = _video("inference-playable", True)
    unplayable = _video("inference-unplayable", False)

    def _version(task_type: TaskType) -> ModelVersion:
        run = TrainingRun(
            dataset_id=dataset.id,
            adapter="ultralytics_yolo",
            base_model="yolo11n.pt",
            task_type=task_type,
            config={},
            total_epochs=1,
            created_by_id=user.id,
        )
        session.add(run)
        session.commit()
        version = ModelVersion(
            training_run_id=run.id,
            name=f"seed-{task_type.value}",
            task_type=task_type,
            storage_key=f"models/{run.id}/best.pt",
        )
        session.add(version)
        return version

    detect = _version(TaskType.DETECTION)
    segment = _version(TaskType.SEGMENTATION)
    classify = _version(TaskType.CLASSIFICATION)
    session.commit()

    rows = SimpleNamespace(
        user_id=user.id,
        video_id=playable.id,
        playable_video_id=playable.id,
        unplayable_video_id=unplayable.id,
        detect_version_id=detect.id,
        segment_version_id=segment.id,
        classify_version_id=classify.id,
    )
    yield rows

    session.rollback()
    video_ids = [playable.id, unplayable.id]
    runs = session.query(InferenceRun).filter(InferenceRun.video_id.in_(video_ids)).all()
    job_ids = [run.job_id for run in runs if run.job_id is not None]
    session.query(InferenceRun).filter(InferenceRun.video_id.in_(video_ids)).delete(
        synchronize_session=False
    )
    if job_ids:
        session.query(Job).filter(Job.id.in_(job_ids)).delete(synchronize_session=False)
    versions = session.query(ModelVersion).filter(
        ModelVersion.id.in_([detect.id, segment.id, classify.id])
    )
    training_run_ids = [version.training_run_id for version in versions.all()]
    versions.delete(synchronize_session=False)
    session.query(TrainingRun).filter(TrainingRun.id.in_(training_run_ids)).delete(
        synchronize_session=False
    )
    session.query(Video).filter(Video.id.in_(video_ids)).delete(synchronize_session=False)
    session.query(Dataset).filter(Dataset.id == dataset.id).delete()
    session.query(User).filter(User.id == user.id).delete()
    session.commit()
    session.close()
```

Create `backend/tests/test_inference_api.py`:

```python
import app.db as db_module
import app.main  # noqa: F401 -- registers every model on Base.metadata
from fastapi.testclient import TestClient

from app.inference.models import InferenceRun, InferenceRunStatus
from app.main import app
from app.training.models import ModelVersion

client = TestClient(app)


def _register_and_login(email: str) -> dict[str, str]:
    client.post("/auth/register", json={"email": email, "password": "pass1234", "role": "admin"})
    response = client.post("/auth/login", json={"email": email, "password": "pass1234"})
    return {"Authorization": f"Bearer {response.json()['access_token']}"}


def test_a_run_survives_deletion_of_its_model_version(committed_inference_rows):
    """The overlay never needs the live ModelVersion: the run keeps its own
    model_name, and the FK is SET NULL rather than blocking or cascading."""
    rows = committed_inference_rows
    session = db_module.SessionLocal()
    try:
        run = InferenceRun(
            video_id=rows.video_id,
            model_version_id=rows.detect_version_id,
            model_name="seed-detection",
            frame_stride=1,
            status=InferenceRunStatus.SUCCEEDED,
            created_by_id=rows.user_id,
        )
        session.add(run)
        session.commit()
        run_id = run.id

        session.query(ModelVersion).filter(ModelVersion.id == rows.detect_version_id).delete()
        session.commit()
        session.expire_all()

        survivor = session.get(InferenceRun, run_id)
        assert survivor is not None
        assert survivor.model_version_id is None
        assert survivor.model_name == "seed-detection"
    finally:
        session.close()
```

- [ ] **Step 3: Run it to verify it fails**

Run: `cd backend && uv run pytest tests/test_inference_api.py -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'app.inference'`.

- [ ] **Step 4: Implement the model, `JobType` and migration**

Create empty `backend/app/inference/__init__.py`.

Create `backend/app/inference/models.py`:

```python
import enum
from datetime import datetime, timezone

from sqlalchemy import DateTime, Enum, ForeignKey, Integer, String
from sqlalchemy.orm import Mapped, mapped_column

from app.db import Base


class InferenceRunStatus(str, enum.Enum):
    """No STOPPED: cancelling a run is out of scope for the first QC slice."""

    PENDING = "pending"
    RUNNING = "running"
    SUCCEEDED = "succeeded"
    FAILED = "failed"


class InferenceRun(Base):
    """One model applied to one video, kept so the result can be reopened.

    model_name is copied at creation and model_version_id is SET NULL on
    delete: a run must stay listable and viewable after its model is
    deleted, because the predictions JSON is self-contained.
    """

    __tablename__ = "inference_runs"

    id: Mapped[int] = mapped_column(primary_key=True)
    video_id: Mapped[int] = mapped_column(ForeignKey("videos.id"))
    model_version_id: Mapped[int | None] = mapped_column(
        ForeignKey("model_versions.id", ondelete="SET NULL"), nullable=True
    )
    model_name: Mapped[str] = mapped_column(String(200))
    job_id: Mapped[int | None] = mapped_column(ForeignKey("jobs.id"), nullable=True)
    frame_stride: Mapped[int] = mapped_column(Integer, default=1)
    status: Mapped[InferenceRunStatus] = mapped_column(
        Enum(InferenceRunStatus), default=InferenceRunStatus.PENDING
    )
    frames_total: Mapped[int] = mapped_column(Integer, default=0)
    frames_processed: Mapped[int] = mapped_column(Integer, default=0)
    predictions_key: Mapped[str | None] = mapped_column(String(500), nullable=True)
    error: Mapped[str | None] = mapped_column(String(2000), nullable=True)
    created_by_id: Mapped[int] = mapped_column(ForeignKey("users.id"))
    started_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    finished_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=lambda: datetime.now(timezone.utc)
    )
```

In `backend/app/jobs/models.py` add `INFERENCE_RUN = "inference_run"` after `MODEL_TRAIN`.

In `backend/app/main.py` add `from app.inference.router import router as inference_router` is **not** added yet (the router arrives in Task 2). Instead import the model so the table registers: add `import app.inference.models  # noqa: F401 -- registers inference_runs on Base.metadata` below the other imports.

Create `backend/alembic/versions/d3e4f5a6b7c8_add_inference_runs.py`:

```python
"""add inference runs

Revision ID: d3e4f5a6b7c8
Revises: f6d4bc4f1b1e
Create Date: 2026-10-06 00:00:00.000000

"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = 'd3e4f5a6b7c8'
down_revision: Union[str, Sequence[str], None] = 'f6d4bc4f1b1e'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    # Postgres enums store the member NAME, so the new jobtype value is upper case.
    op.execute("ALTER TYPE jobtype ADD VALUE IF NOT EXISTS 'INFERENCE_RUN'")
    op.execute("DO $$BEGIN IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'inferencerunstatus') THEN CREATE TYPE inferencerunstatus AS ENUM ('PENDING', 'RUNNING', 'SUCCEEDED', 'FAILED'); END IF; END$$")

    op.create_table(
        'inference_runs',
        sa.Column('id', sa.Integer(), nullable=False),
        sa.Column('video_id', sa.Integer(), nullable=False),
        sa.Column('model_version_id', sa.Integer(), nullable=True),
        sa.Column('model_name', sa.String(length=200), nullable=False),
        sa.Column('job_id', sa.Integer(), nullable=True),
        sa.Column('frame_stride', sa.Integer(), nullable=False),
        sa.Column('status', postgresql.ENUM('PENDING', 'RUNNING', 'SUCCEEDED', 'FAILED', name='inferencerunstatus', create_type=False), nullable=False),
        sa.Column('frames_total', sa.Integer(), nullable=False),
        sa.Column('frames_processed', sa.Integer(), nullable=False),
        sa.Column('predictions_key', sa.String(length=500), nullable=True),
        sa.Column('error', sa.String(length=2000), nullable=True),
        sa.Column('created_by_id', sa.Integer(), nullable=False),
        sa.Column('started_at', sa.DateTime(timezone=True), nullable=True),
        sa.Column('finished_at', sa.DateTime(timezone=True), nullable=True),
        sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(['video_id'], ['videos.id'], ),
        sa.ForeignKeyConstraint(['model_version_id'], ['model_versions.id'], ondelete='SET NULL'),
        sa.ForeignKeyConstraint(['job_id'], ['jobs.id'], ),
        sa.ForeignKeyConstraint(['created_by_id'], ['users.id'], ),
        sa.PrimaryKeyConstraint('id'),
    )


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_table('inference_runs')
    sa.Enum(name='inferencerunstatus').drop(op.get_bind(), checkfirst=True)
    # Postgres cannot drop a value from an enum type; leaving INFERENCE_RUN is
    # harmless because no row will reference it after a downgrade.
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd backend && uv run pytest tests/test_inference_api.py -v`
Expected: PASS.

- [ ] **Step 6: Apply the migration to the dev database**

The ml-worker tests and the running stack read the real `endoscopy` database, which does not get the table from `create_all`. The migration is additive.

Run: `cd backend && uv run alembic upgrade head`
Expected: `Running upgrade f6d4bc4f1b1e -> d3e4f5a6b7c8, add inference runs`.
Verify: `docker compose exec postgres psql -U endoscopy -d endoscopy -c "\d inference_runs"` lists the columns.

- [ ] **Step 7: Commit**

```bash
git add docs/specs/2026-10-06-qc-inference-runs-design.md backend/app/inference backend/app/jobs/models.py backend/app/main.py backend/alembic/versions/d3e4f5a6b7c8_add_inference_runs.py backend/tests/conftest.py backend/tests/test_inference_api.py
git commit -m "feat: add the inference_runs table and INFERENCE_RUN job type" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Backend service, schemas and router

**Files:**
- Create: `backend/app/inference/schemas.py`, `service.py`, `router.py`
- Modify: `backend/app/main.py`, `backend/tests/test_inference_api.py`, `openapi.json`

**Interfaces:**
- Consumes: `InferenceRun`, `InferenceRunStatus`, `JobType.INFERENCE_RUN`, `committed_inference_rows` (Task 1); `app.training.service.get_model_version` and `ModelVersionNotFound`; `app.storage.get_storage_service`.
- Produces: HTTP API under `/inference`:
  - `POST /inference/runs` body `{video_id: int, model_version_id: int, frame_stride: int = 1}` -> 202 `InferenceRunRead`
  - `GET /inference/runs` -> `list[InferenceRunRead]`, newest first
  - `GET /inference/runs/{run_id}` -> `InferenceRunRead`
  - `GET /inference/runs/{run_id}/predictions` -> `PredictionsRead {download_url: str}`
  - `DELETE /inference/runs/{run_id}` -> 204
- `InferenceRunRead` fields: `id, video_id, model_version_id, model_name, job_id, frame_stride, status, frames_total, frames_processed, error, created_at, started_at, finished_at`.
- The Celery job: `celery_app.send_task("inference_run", args=[job.id])`, with `Job.payload = {"inference_run_id", "video_id", "model_version_id", "model_name", "weights_key", "task_type", "frame_stride"}` where `task_type` is `"detection"` or `"segmentation"`.

- [ ] **Step 1: Write the failing tests**

Append to `backend/tests/test_inference_api.py`:

```python
import pytest

from app.jobs.models import Job
from app.storage import get_storage_service


@pytest.fixture(autouse=True)
def _no_celery(monkeypatch):
    sent: list[tuple] = []
    monkeypatch.setattr(
        "app.inference.service.celery_app.send_task",
        lambda name, args=None, **kwargs: sent.append((name, args)),
    )
    return sent


def _create(headers, rows, **overrides):
    body = {
        "video_id": rows.video_id,
        "model_version_id": rows.detect_version_id,
        "frame_stride": 5,
        **overrides,
    }
    return client.post("/inference/runs", headers=headers, json=body)


def test_create_run_returns_202_and_enqueues_the_job(committed_inference_rows, _no_celery):
    headers = _register_and_login("infer-create@example.com")
    rows = committed_inference_rows

    response = _create(headers, rows)

    assert response.status_code == 202
    body = response.json()
    assert body["status"] == "pending"
    assert body["frame_stride"] == 5
    assert body["model_name"] == "seed-detection"
    session = db_module.SessionLocal()
    try:
        job = session.get(Job, body["job_id"])
        assert job.payload["inference_run_id"] == body["id"]
        assert job.payload["video_id"] == rows.video_id
        assert job.payload["task_type"] == "detection"
        assert job.payload["frame_stride"] == 5
        assert job.payload["weights_key"].endswith("/best.pt")
    finally:
        session.close()
    assert _no_celery == [("inference_run", [body["job_id"]])]


def test_create_run_accepts_a_segmentation_model(committed_inference_rows):
    headers = _register_and_login("infer-seg@example.com")
    response = _create(
        headers, committed_inference_rows,
        model_version_id=committed_inference_rows.segment_version_id,
    )
    assert response.status_code == 202


@pytest.mark.parametrize(
    "overrides,expected",
    [
        ({"video_id": 999999}, 404),
        ({"model_version_id": 999999}, 404),
        ({"frame_stride": 0}, 422),
    ],
)
def test_create_run_rejects_bad_input(committed_inference_rows, overrides, expected):
    headers = _register_and_login("infer-bad@example.com")
    assert _create(headers, committed_inference_rows, **overrides).status_code == expected


def test_create_run_rejects_a_classification_model(committed_inference_rows):
    headers = _register_and_login("infer-classify@example.com")
    response = _create(
        headers, committed_inference_rows,
        model_version_id=committed_inference_rows.classify_version_id,
    )
    assert response.status_code == 422
    assert "classification" in response.json()["detail"].lower()


def test_create_run_rejects_a_video_that_is_not_browser_playable(committed_inference_rows):
    headers = _register_and_login("infer-unplayable@example.com")
    response = _create(
        headers, committed_inference_rows,
        video_id=committed_inference_rows.unplayable_video_id,
    )
    assert response.status_code == 409
    assert "playable" in response.json()["detail"].lower()


def test_list_runs_is_newest_first(committed_inference_rows):
    headers = _register_and_login("infer-list@example.com")
    first = _create(headers, committed_inference_rows).json()["id"]
    second = _create(headers, committed_inference_rows).json()["id"]

    ids = [run["id"] for run in client.get("/inference/runs", headers=headers).json()]

    assert ids.index(second) < ids.index(first)


def test_predictions_are_refused_until_the_run_has_succeeded(committed_inference_rows):
    headers = _register_and_login("infer-notready@example.com")
    run_id = _create(headers, committed_inference_rows).json()["id"]

    response = client.get(f"/inference/runs/{run_id}/predictions", headers=headers)

    assert response.status_code == 409


def _mark_succeeded(run_id: int, key: str) -> None:
    session = db_module.SessionLocal()
    try:
        run = session.get(InferenceRun, run_id)
        run.status = InferenceRunStatus.SUCCEEDED
        run.predictions_key = key
        session.commit()
    finally:
        session.close()


class _RecordingStorage:
    def __init__(self):
        self.deleted: list[str] = []

    def delete(self, key: str) -> None:
        self.deleted.append(key)

    def url_for(self, key: str) -> str:
        return f"http://example/{key}"


def test_predictions_return_a_presigned_link_once_succeeded(committed_inference_rows):
    headers = _register_and_login("infer-ready@example.com")
    run_id = _create(headers, committed_inference_rows).json()["id"]
    _mark_succeeded(run_id, f"inference/{run_id}/predictions.json")

    app.dependency_overrides[get_storage_service] = lambda: _RecordingStorage()
    try:
        response = client.get(f"/inference/runs/{run_id}/predictions", headers=headers)
    finally:
        app.dependency_overrides.pop(get_storage_service, None)

    assert response.status_code == 200
    assert response.json()["download_url"] == f"http://example/inference/{run_id}/predictions.json"


def test_delete_removes_the_row_and_the_predictions_object(committed_inference_rows):
    headers = _register_and_login("infer-delete@example.com")
    run_id = _create(headers, committed_inference_rows).json()["id"]
    key = f"inference/{run_id}/predictions.json"
    _mark_succeeded(run_id, key)
    storage = _RecordingStorage()

    app.dependency_overrides[get_storage_service] = lambda: storage
    try:
        response = client.delete(f"/inference/runs/{run_id}", headers=headers)
    finally:
        app.dependency_overrides.pop(get_storage_service, None)

    assert response.status_code == 204
    assert storage.deleted == [key]
    assert client.get(f"/inference/runs/{run_id}", headers=headers).status_code == 404


def test_delete_is_refused_while_the_run_is_active(committed_inference_rows):
    headers = _register_and_login("infer-delete-active@example.com")
    run_id = _create(headers, committed_inference_rows).json()["id"]

    response = client.delete(f"/inference/runs/{run_id}", headers=headers)

    assert response.status_code == 409
    assert client.get(f"/inference/runs/{run_id}", headers=headers).status_code == 200
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd backend && uv run pytest tests/test_inference_api.py -v`
Expected: the new tests FAIL with 404 (no `/inference` routes yet); the Task 1 test still passes.

- [ ] **Step 3: Implement schemas, service and router**

Create `backend/app/inference/schemas.py`:

```python
from datetime import datetime

from pydantic import BaseModel, ConfigDict, Field

from app.inference.models import InferenceRunStatus


class InferenceRunCreate(BaseModel):
    video_id: int
    model_version_id: int
    # Upper bound is a sanity limit, not a product rule: a stride beyond
    # any plausible video length just yields frame 0.
    frame_stride: int = Field(default=1, ge=1, le=1000)


class InferenceRunRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    video_id: int
    model_version_id: int | None
    model_name: str
    job_id: int | None
    frame_stride: int
    status: InferenceRunStatus
    frames_total: int
    frames_processed: int
    error: str | None
    created_at: datetime
    started_at: datetime | None
    finished_at: datetime | None


class PredictionsRead(BaseModel):
    download_url: str
```

Create `backend/app/inference/service.py`:

```python
"""Create, inspect and delete inference runs.

A run is a Job like every other long operation, executed by ml-worker. The
predictions live in object storage as one JSON document; this module only
ever hands out a presigned link to it.
"""

import logging

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.auth.models import User
from app.celery_app import celery_app
from app.datasets.models import TaskType
from app.inference.models import InferenceRun, InferenceRunStatus
from app.jobs.models import Job, JobStatus, JobType
from app.media.models import Video
from app.storage import StorageService
from app.training import service as training_service

logger = logging.getLogger(__name__)

SUPPORTED_TASK_TYPES = (TaskType.DETECTION, TaskType.SEGMENTATION)
ACTIVE_STATUSES = (InferenceRunStatus.PENDING, InferenceRunStatus.RUNNING)


class VideoNotFound(Exception):
    """No such video."""


class VideoNotPlayable(Exception):
    """The video cannot be played in a browser, so its result could not be viewed."""


class UnsupportedModelType(Exception):
    """Only detection and segmentation models can be run."""


class InferenceRunNotFound(Exception):
    """No such run."""


class RunStillActive(Exception):
    """The run is pending or running and cannot be deleted yet."""


class PredictionsNotReady(Exception):
    """The run has not succeeded, so there is nothing to download."""


def create_inference_run(
    session: Session,
    *,
    video_id: int,
    model_version_id: int,
    frame_stride: int,
    created_by: User,
) -> InferenceRun:
    video = session.get(Video, video_id)
    if video is None:
        raise VideoNotFound(f"Video {video_id} not found")
    # `is False`, not falsy: None means "not probed yet", which the player
    # also treats as playable.
    if video.browser_playable is False:
        raise VideoNotPlayable(
            f"Video {video_id} is not browser-playable; convert it in Media first"
        )

    version = training_service.get_model_version(session, model_version_id)
    if version.task_type not in SUPPORTED_TASK_TYPES:
        raise UnsupportedModelType(
            f"A {version.task_type.value} model cannot be run yet; "
            "only detection and segmentation models are supported"
        )

    run = InferenceRun(
        video_id=video_id,
        model_version_id=version.id,
        model_name=version.name,
        frame_stride=frame_stride,
        created_by_id=created_by.id,
    )
    session.add(run)
    session.commit()
    session.refresh(run)

    job = Job(
        job_type=JobType.INFERENCE_RUN,
        status=JobStatus.PENDING,
        payload={
            "inference_run_id": run.id,
            "video_id": video_id,
            "model_version_id": version.id,
            "model_name": version.name,
            "weights_key": version.storage_key,
            "task_type": version.task_type.value,
            "frame_stride": frame_stride,
        },
        created_by_id=created_by.id,
    )
    session.add(job)
    session.commit()
    session.refresh(job)

    run.job_id = job.id
    session.commit()
    session.refresh(run)

    # Default "celery" queue -- ml-worker consumes it.
    celery_app.send_task("inference_run", args=[job.id])
    return run


def get_run(session: Session, run_id: int) -> InferenceRun:
    run = session.get(InferenceRun, run_id)
    if run is None:
        raise InferenceRunNotFound(f"Inference run {run_id} not found")
    return run


def list_runs(session: Session) -> list[InferenceRun]:
    return list(session.scalars(select(InferenceRun).order_by(InferenceRun.id.desc())))


def get_predictions_url(session: Session, storage: StorageService, run_id: int) -> str:
    run = get_run(session, run_id)
    if run.status != InferenceRunStatus.SUCCEEDED or not run.predictions_key:
        raise PredictionsNotReady(f"Inference run {run_id} is {run.status.value}")
    return storage.url_for(run.predictions_key)


def delete_run(session: Session, storage: StorageService, run_id: int) -> None:
    """Delete a finished run and the object that holds its predictions.

    The object goes before the row, matching delete_model_version: a
    storage failure then leaves a recoverable run rather than orphaned
    bytes. An active run is refused because the worker still holds a
    reference to its row.
    """
    run = get_run(session, run_id)
    if run.status in ACTIVE_STATUSES:
        raise RunStillActive(f"Inference run {run_id} is still {run.status.value}")
    if run.predictions_key:
        try:
            storage.delete(run.predictions_key)
        except Exception:  # noqa: BLE001 -- a missing object must not block the delete
            logger.warning("delete_run: could not remove %s", run.predictions_key)
    session.delete(run)
    session.commit()
```

Create `backend/app/inference/router.py`:

```python
from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session

from app.auth.dependencies import get_current_user
from app.auth.models import User
from app.db import get_session
from app.inference import service
from app.inference.schemas import InferenceRunCreate, InferenceRunRead, PredictionsRead
from app.storage import StorageService, get_storage_service
from app.training.service import ModelVersionNotFound

router = APIRouter(
    prefix="/inference", tags=["inference"], dependencies=[Depends(get_current_user)]
)


@router.post("/runs", response_model=InferenceRunRead, status_code=status.HTTP_202_ACCEPTED)
def create_run(
    body: InferenceRunCreate,
    current_user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    try:
        return service.create_inference_run(
            session,
            video_id=body.video_id,
            model_version_id=body.model_version_id,
            frame_stride=body.frame_stride,
            created_by=current_user,
        )
    except (service.VideoNotFound, ModelVersionNotFound) as exc:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(exc))
    except service.VideoNotPlayable as exc:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=str(exc))
    except service.UnsupportedModelType as exc:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail=str(exc))


@router.get("/runs", response_model=list[InferenceRunRead])
def list_runs(session: Session = Depends(get_session)):
    return service.list_runs(session)


@router.get("/runs/{run_id}", response_model=InferenceRunRead)
def get_run(run_id: int, session: Session = Depends(get_session)):
    try:
        return service.get_run(session, run_id)
    except service.InferenceRunNotFound as exc:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(exc))


@router.get("/runs/{run_id}/predictions", response_model=PredictionsRead)
def get_predictions(
    run_id: int,
    session: Session = Depends(get_session),
    storage: StorageService = Depends(get_storage_service),
):
    try:
        return PredictionsRead(
            download_url=service.get_predictions_url(session, storage, run_id)
        )
    except service.InferenceRunNotFound as exc:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(exc))
    except service.PredictionsNotReady as exc:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=str(exc))


@router.delete("/runs/{run_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_run(
    run_id: int,
    session: Session = Depends(get_session),
    storage: StorageService = Depends(get_storage_service),
):
    try:
        service.delete_run(session, storage, run_id)
    except service.InferenceRunNotFound as exc:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(exc))
    except service.RunStillActive as exc:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=str(exc))
```

In `backend/app/main.py` add the import `from app.inference.router import router as inference_router` (keeping imports sorted) and, next to the other `include_router` calls, `app.include_router(inference_router)`. The `import app.inference.models` line from Task 1 is now redundant; remove it.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd backend && uv run pytest tests/test_inference_api.py -v`
Expected: all PASS. Then run the neighbouring suites to catch regressions: `cd backend && uv run pytest tests/test_training_api.py tests/test_main.py -q`. About 16 backend failures predate this work (project memory `reference_pre_existing_red_tests`); what matters is that none of them mention `inference` or `training`.

- [ ] **Step 5: Regenerate `openapi.json`**

Run: `cd backend && PYTHONPATH=. uv run python scripts/export_openapi.py && git diff --stat openapi.json`
Expected: `openapi.json` changed (new `/inference/...` paths).

- [ ] **Step 6: Commit**

```bash
git add backend/app/inference backend/app/main.py backend/tests/test_inference_api.py openapi.json
git commit -m "feat: add the inference runs API" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 3: ml-worker inference adapter

**Files:**
- Create: `ml-worker/app/inference_adapter.py`, `ml-worker/app/ultralytics_inference_adapter.py`
- Test: `ml-worker/tests/test_ultralytics_inference_adapter.py`

**Interfaces:**
- Produces (`ml-worker/app/inference_adapter.py`):

```python
@dataclass
class InferenceRequest:
    video_path: Path
    weights_path: Path
    task_type: str            # "detection" | "segmentation"
    frame_stride: int
    confidence_floor: float = 0.05

@dataclass
class InferenceResult:
    task_type: str
    fps: float
    classes: list[str]        # index == class_id
    frames: dict[str, dict]   # str(frame_index) -> {"timestamp_ms": int, "detections": [..]}

class InferenceAdapter(Protocol):
    def infer(self, request: InferenceRequest,
              on_progress: Callable[[int, int], None]) -> InferenceResult: ...
```

- Produces (`ultralytics_inference_adapter.py`): `UltralyticsInferenceAdapter(model_loader: Callable[[str], Any] | None = None)` implementing `InferenceAdapter`. `on_progress(processed, total)` is called after every processed frame.
- A detection dict is `{"class_id": int, "confidence": float, "bbox": [x, y, w, h], "polygon"?: [[x, y], ...]}`, all coordinates normalised 0..1, `(x, y)` top-left.

- [ ] **Step 1: Write the failing tests**

Create `ml-worker/tests/test_ultralytics_inference_adapter.py`:

```python
import cv2
import numpy as np
import pytest

from app.inference_adapter import InferenceRequest
from app.ultralytics_inference_adapter import UltralyticsInferenceAdapter


def _write_video(path, frames=10, fps=10, size=(64, 48)):
    writer = cv2.VideoWriter(str(path), cv2.VideoWriter_fourcc(*"MJPG"), fps, size)
    for i in range(frames):
        writer.write(np.full((size[1], size[0], 3), i * 20, dtype=np.uint8))
    writer.release()
    return path


class _Boxes:
    def __init__(self, xyxyn, conf, cls):
        self.xyxyn = np.array(xyxyn, dtype=float).reshape(-1, 4)
        self.conf = np.array(conf, dtype=float)
        self.cls = np.array(cls, dtype=float)

    def __len__(self):
        return len(self.conf)


class _Masks:
    def __init__(self, xyn):
        self.xyn = [np.array(polygon, dtype=float) for polygon in xyn]


class _Result:
    def __init__(self, boxes=None, masks=None):
        self.boxes = boxes
        self.masks = masks


class _FakeModel:
    names = {0: "polyp", 1: "fold"}

    def __init__(self, results_by_call=None):
        self.results_by_call = results_by_call or {}
        self.calls = 0
        self.conf_seen = None

    def __call__(self, image, conf, verbose):
        self.conf_seen = conf
        result = self.results_by_call.get(self.calls, _Result(boxes=_Boxes([], [], [])))
        self.calls += 1
        return [result]


def _adapter(model):
    return UltralyticsInferenceAdapter(model_loader=lambda path: model)


def _request(video, stride=1, task_type="detection"):
    return InferenceRequest(
        video_path=video,
        weights_path=video.parent / "w.pt",
        task_type=task_type,
        frame_stride=stride,
    )


def test_stride_one_processes_every_frame(tmp_path):
    video = _write_video(tmp_path / "v.avi", frames=10)
    result = _adapter(_FakeModel()).infer(_request(video, 1), lambda done, total: None)
    assert list(result.frames) == [str(i) for i in range(10)]
    assert result.classes == ["polyp", "fold"]
    assert result.task_type == "detection"


def test_stride_five_processes_frames_zero_and_five(tmp_path):
    video = _write_video(tmp_path / "v.avi", frames=10)
    result = _adapter(_FakeModel()).infer(_request(video, 5), lambda done, total: None)
    assert list(result.frames) == ["0", "5"]


def test_a_stride_longer_than_the_video_still_processes_frame_zero(tmp_path):
    video = _write_video(tmp_path / "v.avi", frames=10)
    result = _adapter(_FakeModel()).infer(_request(video, 1000), lambda done, total: None)
    assert list(result.frames) == ["0"]


def test_a_frame_with_no_detections_keeps_an_empty_list(tmp_path):
    video = _write_video(tmp_path / "v.avi", frames=2)
    result = _adapter(_FakeModel()).infer(_request(video, 1), lambda done, total: None)
    assert result.frames["0"]["detections"] == []
    assert result.frames["1"]["detections"] == []


def test_boxes_become_top_left_xywh_and_the_floor_is_passed_to_the_model(tmp_path):
    video = _write_video(tmp_path / "v.avi", frames=1)
    model = _FakeModel(
        {0: _Result(boxes=_Boxes([[0.2, 0.4, 0.5, 0.9]], [0.87654321], [1]))}
    )
    result = _adapter(model).infer(_request(video, 1), lambda done, total: None)

    detection = result.frames["0"]["detections"][0]
    assert detection["class_id"] == 1
    assert detection["confidence"] == pytest.approx(0.8765, abs=1e-4)
    assert detection["bbox"] == pytest.approx([0.2, 0.4, 0.3, 0.5], abs=1e-4)
    assert "polygon" not in detection
    assert model.conf_seen == 0.05


def test_segmentation_adds_polygons(tmp_path):
    video = _write_video(tmp_path / "v.avi", frames=1)
    model = _FakeModel(
        {
            0: _Result(
                boxes=_Boxes([[0.1, 0.1, 0.4, 0.4]], [0.9], [0]),
                masks=_Masks([[[0.1, 0.1], [0.4, 0.1], [0.4, 0.4]]]),
            )
        }
    )
    result = _adapter(model).infer(
        _request(video, 1, "segmentation"), lambda done, total: None
    )
    assert result.frames["0"]["detections"][0]["polygon"] == [
        [0.1, 0.1], [0.4, 0.1], [0.4, 0.4],
    ]


def test_timestamps_follow_the_video_clock(tmp_path):
    video = _write_video(tmp_path / "v.avi", frames=10, fps=10)
    result = _adapter(_FakeModel()).infer(_request(video, 5), lambda done, total: None)
    assert result.frames["0"]["timestamp_ms"] == 0
    assert result.frames["5"]["timestamp_ms"] == pytest.approx(500, abs=60)
    assert result.fps == pytest.approx(10, abs=0.5)


def test_progress_reports_every_processed_frame_and_ends_at_the_total(tmp_path):
    video = _write_video(tmp_path / "v.avi", frames=10)
    seen: list[tuple[int, int]] = []
    _adapter(_FakeModel()).infer(_request(video, 5), lambda done, total: seen.append((done, total)))
    assert seen == [(1, 2), (2, 2)]


def test_an_unreadable_video_fails_with_a_message_instead_of_hanging(tmp_path):
    broken = tmp_path / "broken.avi"
    broken.write_bytes(b"this is not a video")
    with pytest.raises(ValueError, match="video"):
        _adapter(_FakeModel()).infer(_request(broken, 1), lambda done, total: None)
```

- [ ] **Step 2: Run them to verify they fail**

Run (inside the container, see Global Constraints for the copy steps):
`docker compose exec ml-worker uv run pytest tests/test_ultralytics_inference_adapter.py -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'app.inference_adapter'`.

- [ ] **Step 3: Implement the Protocol and the adapter**

Create `ml-worker/app/inference_adapter.py`:

```python
"""The interface every inference backend implements.

Parallel to TrainingAdapter and shaped the same way: control is handed to
the adapter, which reports progress as it goes. The result is plain data
(dicts and lists) so the worker can serialise it without knowing which
framework produced it.
"""

from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable, Protocol


@dataclass
class InferenceRequest:
    video_path: Path
    weights_path: Path
    # "detection" or "segmentation" -- the TaskType values.
    task_type: str
    frame_stride: int
    # Deliberately low: the screen filters by confidence on the client, so
    # anything the model might still call a detection has to be stored.
    confidence_floor: float = 0.05


@dataclass
class InferenceResult:
    task_type: str
    fps: float
    # Index is the class id.
    classes: list[str]
    # str(frame_index) -> {"timestamp_ms": int, "detections": [...]}.
    # A processed frame with nothing in it has "detections": [], so
    # "nothing found" stays distinguishable from "frame not processed".
    frames: dict[str, dict] = field(default_factory=dict)


class InferenceAdapter(Protocol):
    def infer(
        self,
        request: InferenceRequest,
        on_progress: Callable[[int, int], None],
    ) -> InferenceResult:
        """Run the model over the video. on_progress(processed, total) is
        called after each processed frame. Raise on failure; the caller
        records it."""
        ...
```

Create `ml-worker/app/ultralytics_inference_adapter.py`:

```python
"""Ultralytics YOLO behind InferenceAdapter.

Reads the video with OpenCV (the sanctioned exception to "no filesystem
paths in domain code": OpenCV needs a real path and the caller deletes the
file), runs every frame_stride-th frame through the model, and converts
Ultralytics' result objects to plain dicts with top-left xywh boxes
normalised to 0..1.
"""

import math
from typing import Any, Callable

import cv2

from app.inference_adapter import InferenceRequest, InferenceResult

_BOX_DIGITS = 5
_CONFIDENCE_DIGITS = 4


def _detections_from(result: Any, task_type: str) -> list[dict]:
    boxes = result.boxes
    if boxes is None or len(boxes) == 0:
        return []
    corners = boxes.xyxyn.tolist()
    confidences = boxes.conf.tolist()
    class_ids = boxes.cls.tolist()
    polygons = None
    if task_type == "segmentation" and result.masks is not None:
        polygons = result.masks.xyn

    detections = []
    for i, (corner, confidence, class_id) in enumerate(zip(corners, confidences, class_ids)):
        x1, y1, x2, y2 = corner
        detection = {
            "class_id": int(class_id),
            "confidence": round(float(confidence), _CONFIDENCE_DIGITS),
            "bbox": [
                round(x1, _BOX_DIGITS),
                round(y1, _BOX_DIGITS),
                round(x2 - x1, _BOX_DIGITS),
                round(y2 - y1, _BOX_DIGITS),
            ],
        }
        if polygons is not None and i < len(polygons):
            detection["polygon"] = [
                [round(float(x), _BOX_DIGITS), round(float(y), _BOX_DIGITS)]
                for x, y in polygons[i].tolist()
            ]
        detections.append(detection)
    return detections


class UltralyticsInferenceAdapter:
    name = "ultralytics_yolo"

    def __init__(self, model_loader: Callable[[str], Any] | None = None) -> None:
        # Injectable so tests can run without weights or a GPU.
        self._model_loader = model_loader

    def _load(self, weights_path: str) -> Any:
        if self._model_loader is not None:
            return self._model_loader(weights_path)
        from ultralytics import YOLO

        return YOLO(weights_path)

    def infer(
        self,
        request: InferenceRequest,
        on_progress: Callable[[int, int], None],
    ) -> InferenceResult:
        capture = cv2.VideoCapture(str(request.video_path))
        if not capture.isOpened():
            raise ValueError("Could not open the video file")
        try:
            fps = float(capture.get(cv2.CAP_PROP_FPS)) or 0.0
            frame_count = int(capture.get(cv2.CAP_PROP_FRAME_COUNT))
            total = math.ceil(frame_count / request.frame_stride) if frame_count > 0 else 0
            model = self._load(str(request.weights_path))

            frames: dict[str, dict] = {}
            index = 0
            # grab() advances without decoding; only the frames we keep are
            # retrieved, which is what makes a large stride cheap.
            while capture.grab():
                if index % request.frame_stride == 0:
                    ok, image = capture.retrieve()
                    if ok:
                        position_ms = capture.get(cv2.CAP_PROP_POS_MSEC)
                        if position_ms and position_ms > 0:
                            timestamp_ms = int(position_ms)
                        else:
                            timestamp_ms = int(index / fps * 1000) if fps else 0
                        results = model(image, conf=request.confidence_floor, verbose=False)
                        frames[str(index)] = {
                            "timestamp_ms": timestamp_ms,
                            "detections": _detections_from(results[0], request.task_type),
                        }
                        on_progress(len(frames), max(total, len(frames)))
                index += 1
        finally:
            capture.release()

        if not frames:
            raise ValueError("The video has no readable frames")

        names = model.names
        classes = [str(names[i]) for i in range(len(names))]
        return InferenceResult(
            task_type=request.task_type, fps=fps, classes=classes, frames=frames
        )
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `docker cp ml-worker/app endoscopy-platform-ml-worker-1:/app/app` (after `docker compose exec ml-worker rm -rf /app/tests` and re-copying `tests`), then
`docker compose exec ml-worker uv run pytest tests/test_ultralytics_inference_adapter.py -v`
Expected: all PASS. If the timestamp test is flaky on the container's OpenCV build, widen its tolerance, do not delete it.

- [ ] **Step 5: Commit**

```bash
git add ml-worker/app/inference_adapter.py ml-worker/app/ultralytics_inference_adapter.py ml-worker/tests/test_ultralytics_inference_adapter.py
git commit -m "feat: add the inference adapter and its Ultralytics implementation" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 4: ml-worker `inference_run` task

**Files:**
- Modify: `ml-worker/app/models.py`, `ml-worker/app/tasks.py`, `ml-worker/tests/conftest.py`
- Test: `ml-worker/tests/test_tasks_inference.py`

**Interfaces:**
- Consumes: `InferenceAdapter`, `InferenceRequest`, `InferenceResult` (Task 3); the backend's `Job.payload` shape and `inference_runs` table (Tasks 1-2).
- Produces: Celery task `inference_run(job_id: int, adapter: InferenceAdapter | None = None)`; the ml-worker ORM classes `InferenceRun`, `InferenceRunStatus` and `JobType.INFERENCE_RUN`; the predictions document at key `inference/{run_id}/predictions.json`:

```json
{"task_type": "detection", "model": {"name": "...", "version_id": 12}, "fps": 25.0,
 "frame_stride": 5, "classes": ["polyp"], "frames": {"0": {"timestamp_ms": 0, "detections": []}}}
```

- [ ] **Step 1: Write the failing tests**

Append to `ml-worker/tests/conftest.py` a fixture that mirrors `make_job_and_run`:

```python
@pytest.fixture
def make_inference_job(db_session):
    """A Job(INFERENCE_RUN) paired with an InferenceRun and a throwaway
    videos row, linked via the payload exactly as
    backend/app/inference/service.py builds it. Committed through
    db_session (a different SessionLocal() than the task's own), and
    deleted afterwards, children before parents."""
    from sqlalchemy import text

    from app.models import InferenceRun, InferenceRunStatus, Job, JobStatus, JobType

    created: list[tuple[int, int, int]] = []

    def _make(frame_stride: int = 2):
        user_id = _existing_row_id(db_session, "users")
        video_id = db_session.execute(
            text(
                "INSERT INTO videos (storage_key, filename, title, fps, duration_seconds, "
                "size_bytes, checksum, created_at) VALUES "
                "('videos/inference-test.mp4', 'inference-test.mp4', 'inference test', "
                "10, 1, 1, 'inference-test', now()) RETURNING id"
            )
        ).scalar_one()
        run = InferenceRun(
            video_id=video_id,
            model_version_id=None,
            model_name="yolo11n-run1",
            frame_stride=frame_stride,
            status=InferenceRunStatus.PENDING,
            created_by_id=user_id,
        )
        db_session.add(run)
        db_session.commit()
        db_session.refresh(run)

        job = Job(
            job_type=JobType.INFERENCE_RUN,
            status=JobStatus.PENDING,
            progress=0,
            payload={
                "inference_run_id": run.id,
                "video_id": video_id,
                "model_version_id": None,
                "model_name": "yolo11n-run1",
                "weights_key": "models/1/best.pt",
                "task_type": "detection",
                "frame_stride": frame_stride,
            },
            created_by_id=user_id,
        )
        db_session.add(job)
        db_session.commit()
        db_session.refresh(job)

        run.job_id = job.id
        db_session.commit()
        created.append((run.id, job.id, video_id))
        return job, run

    yield _make

    from sqlalchemy import text as _text

    for run_id, job_id, video_id in created:
        db_session.query(InferenceRun).filter_by(id=run_id).delete()
        db_session.query(Job).filter_by(id=job_id).delete()
        db_session.execute(_text("DELETE FROM videos WHERE id = :id"), {"id": video_id})
    db_session.commit()
```

Create `ml-worker/tests/test_tasks_inference.py`:

```python
import json

from app.inference_adapter import InferenceResult
from app.models import InferenceRunStatus, JobStatus


class _StubAdapter:
    def __init__(self, on_infer=None):
        self.on_infer = on_infer
        self.requests = []

    def infer(self, request, on_progress):
        self.requests.append(request)
        if self.on_infer:
            self.on_infer(on_progress)
        return InferenceResult(
            task_type=request.task_type,
            fps=10.0,
            classes=["polyp"],
            frames={
                "0": {"timestamp_ms": 0, "detections": []},
                "2": {
                    "timestamp_ms": 200,
                    "detections": [
                        {"class_id": 0, "confidence": 0.9, "bbox": [0.1, 0.1, 0.2, 0.2]}
                    ],
                },
            },
        )


def test_a_successful_run_stores_the_document_and_marks_everything_done(
    db_session, make_inference_job, fake_storage
):
    from app.tasks import inference_run

    job, run = make_inference_job(frame_stride=2)
    adapter = _StubAdapter()

    inference_run(job.id, adapter=adapter)
    db_session.refresh(run)
    db_session.refresh(job)

    key = f"inference/{run.id}/predictions.json"
    assert run.status == InferenceRunStatus.SUCCEEDED
    assert run.predictions_key == key
    assert run.frames_total == run.frames_processed == 2
    assert job.status == JobStatus.SUCCEEDED
    assert job.progress == 100
    assert job.result_ref == key

    document = json.loads(fake_storage.uploaded[key])
    assert document["task_type"] == "detection"
    assert document["model"] == {"name": "yolo11n-run1", "version_id": None}
    assert document["frame_stride"] == 2
    assert document["classes"] == ["polyp"]
    assert document["frames"]["2"]["detections"][0]["confidence"] == 0.9
    assert adapter.requests[0].frame_stride == 2
    assert adapter.requests[0].task_type == "detection"


def test_an_adapter_failure_marks_the_run_failed_with_the_message(
    db_session, make_inference_job, fake_storage
):
    from app.tasks import inference_run

    class _Failing:
        def infer(self, request, on_progress):
            raise ValueError("Could not open the video file")

    job, run = make_inference_job()

    inference_run(job.id, adapter=_Failing())
    db_session.refresh(run)
    db_session.refresh(job)

    assert run.status == InferenceRunStatus.FAILED
    assert run.error == "Could not open the video file"
    assert job.status == JobStatus.FAILED
    assert job.error == "Could not open the video file"
    assert run.predictions_key is None
    assert fake_storage.uploaded == {}


def test_a_missing_video_row_fails_the_run_instead_of_crashing(
    db_session, make_inference_job, fake_storage
):
    from app.tasks import inference_run

    job, run = make_inference_job()
    # Break only the lookup: point the job at a video id that does not exist.
    job.payload = {**job.payload, "video_id": 0}
    db_session.commit()

    inference_run(job.id, adapter=_StubAdapter())
    db_session.refresh(run)

    assert run.status == InferenceRunStatus.FAILED
    assert "Video 0 not found" in run.error


def test_progress_is_flushed_and_the_final_count_is_exact(
    db_session, make_inference_job, fake_storage
):
    from app.tasks import inference_run

    job, run = make_inference_job()
    adapter = _StubAdapter(on_infer=lambda on_progress: [on_progress(i, 3) for i in (1, 2, 3)])

    inference_run(job.id, adapter=adapter)
    db_session.refresh(run)

    assert run.frames_processed == run.frames_total


def test_other_model_families_are_evicted_before_the_model_loads(
    db_session, make_inference_job, fake_storage, monkeypatch
):
    import app.tasks as tasks_module

    calls: list[str] = []
    for name in ("sam3", "sam2", "quality", "similarity"):
        monkeypatch.setattr(
            tasks_module, f"_evict_{name}_models", lambda name=name: calls.append(name)
        )

    class _OrderRecorder:
        def infer(self, request, on_progress):
            calls.append("infer")
            return InferenceResult(
                task_type="detection", fps=1.0, classes=[], frames={"0": {"timestamp_ms": 0, "detections": []}}
            )

    job, _ = make_inference_job()
    tasks_module.inference_run(job.id, adapter=_OrderRecorder())

    assert calls[-1] == "infer"
    assert sorted(calls[:-1]) == ["quality", "sam2", "sam3", "similarity"]
```


- [ ] **Step 2: Run them to verify they fail**

Run: copy `app` and `tests` into the container, then
`docker compose exec ml-worker uv run pytest tests/test_tasks_inference.py -v`
Expected: FAIL with `ImportError: cannot import name 'InferenceRun' from 'app.models'`.

- [ ] **Step 3: Add the ORM copy and the task**

In `ml-worker/app/models.py`: add `INFERENCE_RUN = "inference_run"` to `JobType` after `MODEL_TRAIN`, and append (reusing the file's existing imports `enum`, `datetime`, `timezone`, `DateTime`, `Enum`, `ForeignKey`, `Integer`, `String`, `Mapped`, `mapped_column`):

```python
class InferenceRunStatus(str, enum.Enum):
    """Duplicate of backend/app/inference/models.py's InferenceRunStatus --
    member NAMES are what Postgres stores, so they must match exactly."""

    PENDING = "pending"
    RUNNING = "running"
    SUCCEEDED = "succeeded"
    FAILED = "failed"


class InferenceRun(Base):
    """ml-worker's mapping of backend/app/inference/models.py's InferenceRun.

    video_id and created_by_id are plain Integers rather than ForeignKeys,
    for the same reason as TrainingRun.dataset_id: ml-worker has no
    duplicate `videos`/`users` table mapping to point them at.
    """

    __tablename__ = "inference_runs"

    id: Mapped[int] = mapped_column(primary_key=True)
    video_id: Mapped[int] = mapped_column(Integer)
    model_version_id: Mapped[int | None] = mapped_column(Integer, nullable=True)
    model_name: Mapped[str] = mapped_column(String(200))
    job_id: Mapped[int | None] = mapped_column(ForeignKey("jobs.id"), nullable=True)
    frame_stride: Mapped[int] = mapped_column(Integer, default=1)
    status: Mapped[InferenceRunStatus] = mapped_column(
        Enum(InferenceRunStatus), default=InferenceRunStatus.PENDING
    )
    frames_total: Mapped[int] = mapped_column(Integer, default=0)
    frames_processed: Mapped[int] = mapped_column(Integer, default=0)
    predictions_key: Mapped[str | None] = mapped_column(String(500), nullable=True)
    error: Mapped[str | None] = mapped_column(String(2000), nullable=True)
    created_by_id: Mapped[int] = mapped_column(Integer)
    started_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    finished_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=lambda: datetime.now(timezone.utc)
    )
```

In `ml-worker/app/tasks.py`:

1. Add `import gc`, `import json` to the imports, `from sqlalchemy import text`, and extend the `from app.models import (...)` list with `InferenceRun, InferenceRunStatus`. Add `from app.inference_adapter import InferenceRequest`.
2. Append at the end of the file:

```python
INFERENCE_PROGRESS_SECONDS = 2.0


@celery_app.task(name="inference_run")
def inference_run(job_id: int, adapter=None) -> None:
    """Run a detection or segmentation model over a stored video.

    Writes one predictions document to object storage. Progress is
    flushed on a cadence rather than per frame: a 90k-frame video would
    otherwise cost 90k single-row UPDATEs.
    """
    # Same cross-family VRAM rule as every other task here.
    _evict_sam3_models()
    _evict_sam2_models()
    _evict_quality_models()
    _evict_similarity_models()

    session = SessionLocal()
    job = session.get(Job, job_id)
    if job is None:
        session.close()
        return

    run = session.get(InferenceRun, job.payload["inference_run_id"])
    if run is None:
        job.status = JobStatus.FAILED
        job.error = f"InferenceRun {job.payload.get('inference_run_id')} not found"
        job.finished_at = datetime.now(timezone.utc)
        session.commit()
        session.close()
        return

    if adapter is None:
        from app.ultralytics_inference_adapter import UltralyticsInferenceAdapter

        adapter = UltralyticsInferenceAdapter()

    job.status = JobStatus.RUNNING
    job.started_at = datetime.now(timezone.utc)
    run.status = InferenceRunStatus.RUNNING
    run.started_at = job.started_at
    session.commit()

    storage = get_storage_service()
    last_flush = [0.0]

    def _on_progress(done: int, total: int) -> None:
        now = time.monotonic()
        if done < total and now - last_flush[0] < INFERENCE_PROGRESS_SECONDS:
            return
        last_flush[0] = now
        run.frames_processed = done
        run.frames_total = total
        job.progress = int(done / total * 100) if total else 0
        session.commit()

    try:
        # Resolved here, not at enqueue: a transcode between the two
        # replaces videos.storage_key and deletes the old object.
        video_key = session.execute(
            text("SELECT storage_key FROM videos WHERE id = :id"),
            {"id": job.payload["video_id"]},
        ).scalar_one_or_none()
        if video_key is None:
            raise ValueError(f"Video {job.payload['video_id']} not found")

        with tempfile.TemporaryDirectory() as workdir:
            work = Path(workdir)
            video_path = work / "input.mp4"
            video_path.write_bytes(storage.download(video_key))
            weights_path = work / "weights.pt"
            weights_path.write_bytes(storage.download(job.payload["weights_key"]))

            result = adapter.infer(
                InferenceRequest(
                    video_path=video_path,
                    weights_path=weights_path,
                    task_type=job.payload["task_type"],
                    frame_stride=job.payload["frame_stride"],
                ),
                on_progress=_on_progress,
            )

        document = {
            "task_type": result.task_type,
            "model": {
                "name": job.payload["model_name"],
                "version_id": job.payload.get("model_version_id"),
            },
            "fps": result.fps,
            "frame_stride": job.payload["frame_stride"],
            "classes": result.classes,
            "frames": result.frames,
        }
        predictions_key = f"inference/{run.id}/predictions.json"
        storage.upload(predictions_key, json.dumps(document).encode(), "application/json")

        run.predictions_key = predictions_key
        run.frames_processed = run.frames_total = len(result.frames)
        run.status = InferenceRunStatus.SUCCEEDED
        run.finished_at = datetime.now(timezone.utc)
        job.status = JobStatus.SUCCEEDED
        job.progress = 100
        job.result_ref = predictions_key
        job.finished_at = run.finished_at
        session.commit()
    except Exception as exc:  # noqa: BLE001 -- recorded, not swallowed
        session.rollback()
        job = session.get(Job, job_id)
        run = session.get(InferenceRun, job.payload["inference_run_id"])
        run.status = InferenceRunStatus.FAILED
        run.error = str(exc)[:2000]
        run.finished_at = datetime.now(timezone.utc)
        job.status = JobStatus.FAILED
        job.error = str(exc)[:2000]
        job.finished_at = run.finished_at
        session.commit()
    finally:
        session.close()
        gc.collect()
        if torch.cuda.is_available():
            torch.cuda.empty_cache()
```

The `FakeStorage.download` in `conftest.py` returns zip bytes for any key, which is enough because the stub adapter never opens the files.

- [ ] **Step 4: Run the tests to verify they pass**

Run: copy `app` and `tests` into the container, then
`docker compose exec ml-worker uv run pytest tests/test_tasks_inference.py tests/test_tasks_training.py tests/test_tasks_gpu_eviction.py -v -k "not requires_sam3_weights and not requires_sam2_weights"`
Expected: all PASS (the training and eviction suites guard against regressions in the shared module).

Then confirm nothing leaked: `docker compose exec postgres psql -U endoscopy -d endoscopy -c "select count(*) from inference_runs; select count(*) from videos where title = 'inference test';"` -> both 0.

- [ ] **Step 5: Commit**

```bash
git add ml-worker/app/models.py ml-worker/app/tasks.py ml-worker/tests/conftest.py ml-worker/tests/test_tasks_inference.py
git commit -m "feat: run inference jobs in ml-worker" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Frontend data layer and prediction helpers

**Files:**
- Create: `frontend/src/entities/useInferenceRuns.ts`, `frontend/src/entities/useModelVersions.ts`
- Create: `frontend/src/features/qc/predictions.ts`, `drawDetections.ts`
- Test: `frontend/src/features/qc/predictions.test.ts`, `drawDetections.test.ts`

**Interfaces:**
- Consumes: the `/inference/*` and `/training/models` API (generated types `InferenceRunRead`, `ModelVersionRead`).
- Produces (`predictions.ts`):

```ts
export interface Detection { class_id: number; confidence: number; bbox: [number, number, number, number]; polygon?: [number, number][] }
export interface PredictionsDocument { task_type: "detection" | "segmentation"; model: { name: string; version_id: number | null }; fps: number; frame_stride: number; classes: string[]; frames: Record<string, { timestamp_ms: number; detections: Detection[] }> }
export interface FrameIndex { timestamps: number[]; detections: Detection[][] }
export const DISPLAY_CONFIDENCE_THRESHOLD = 0.25;
export function buildFrameIndex(doc: PredictionsDocument): FrameIndex;
export function detectionsAt(index: FrameIndex, timeMs: number): Detection[];
export function colorForClass(classId: number): string;
export function countByClass(index: FrameIndex, classCount: number, threshold: number): number[];
```

- Produces (`drawDetections.ts`):

```ts
export interface Rect { left: number; top: number; width: number; height: number }
export function drawDetections(ctx: CanvasRenderingContext2D, rect: Rect, detections: Detection[], classes: string[], threshold: number): void;
```

- Produces (`useInferenceRuns.ts`): `useInferenceRuns()`, `useInferenceRun(runId: number | null)`, `useCreateInferenceRun()`, `useDeleteInferenceRun()`, `usePredictions(runId: number | null, enabled: boolean)`; (`useModelVersions.ts`): `useModelVersions()`.

- [ ] **Step 1: Generate the API types**

Run: `cd frontend && npm run generate-api`
Expected: `src/shared/api/generated/schema.d.ts` now contains `InferenceRunRead`. (It is gitignored; nothing to commit.)

- [ ] **Step 2: Write the failing tests**

Create `frontend/src/features/qc/predictions.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import {
  buildFrameIndex,
  colorForClass,
  countByClass,
  detectionsAt,
  type PredictionsDocument,
} from "./predictions";

const det = (class_id: number, confidence: number) => ({
  class_id,
  confidence,
  bbox: [0.1, 0.1, 0.2, 0.2] as [number, number, number, number],
});

const doc: PredictionsDocument = {
  task_type: "detection",
  model: { name: "m", version_id: 1 },
  fps: 10,
  frame_stride: 5,
  classes: ["polyp", "fold"],
  frames: {
    "5": { timestamp_ms: 500, detections: [det(1, 0.6)] },
    "0": { timestamp_ms: 0, detections: [det(0, 0.9), det(0, 0.1)] },
    "10": { timestamp_ms: 1000, detections: [] },
  },
};

describe("detectionsAt", () => {
  const index = buildFrameIndex(doc);

  it("sorts frames by time regardless of key order", () => {
    expect(index.timestamps).toEqual([0, 500, 1000]);
  });

  it("returns the nearest processed frame at or before the time", () => {
    expect(detectionsAt(index, 0)).toHaveLength(2);
    expect(detectionsAt(index, 499)).toHaveLength(2);
    expect(detectionsAt(index, 500)[0].class_id).toBe(1);
    expect(detectionsAt(index, 760)[0].class_id).toBe(1);
  });

  it("keeps showing the last frame's result past the end instead of flickering off", () => {
    expect(detectionsAt(index, 99999)).toEqual([]); // the last frame has no detections
    expect(detectionsAt(index, 1000)).toEqual([]);
  });

  it("returns nothing before the first processed frame", () => {
    expect(detectionsAt(index, -5)).toEqual([]);
  });

  it("returns nothing for an empty document", () => {
    expect(detectionsAt(buildFrameIndex({ ...doc, frames: {} }), 100)).toEqual([]);
  });
});

describe("countByClass", () => {
  it("counts only detections at or above the threshold", () => {
    expect(countByClass(buildFrameIndex(doc), 2, 0.25)).toEqual([1, 1]);
  });
});

describe("colorForClass", () => {
  it("is stable per class and distinct for neighbours", () => {
    expect(colorForClass(3)).toBe(colorForClass(3));
    expect(colorForClass(0)).not.toBe(colorForClass(1));
  });
});
```

Create `frontend/src/features/qc/drawDetections.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import { drawDetections } from "./drawDetections";

function fakeContext() {
  const calls: Array<[string, ...unknown[]]> = [];
  const record = (name: string) => (...args: unknown[]) => {
    calls.push([name, ...args]);
  };
  const ctx = {
    strokeRect: record("strokeRect"),
    fillRect: record("fillRect"),
    fillText: record("fillText"),
    beginPath: record("beginPath"),
    moveTo: record("moveTo"),
    lineTo: record("lineTo"),
    closePath: record("closePath"),
    fill: record("fill"),
    stroke: record("stroke"),
    measureText: () => ({ width: 40 }),
    strokeStyle: "",
    fillStyle: "",
    lineWidth: 0,
    font: "",
    globalAlpha: 1,
  } as unknown as CanvasRenderingContext2D;
  return { ctx, calls };
}

const rect = { left: 10, top: 20, width: 200, height: 100 };

describe("drawDetections", () => {
  it("maps a normalised box into the picture rectangle, not the element box", () => {
    const { ctx, calls } = fakeContext();
    drawDetections(
      ctx,
      rect,
      [{ class_id: 0, confidence: 0.9, bbox: [0.5, 0.5, 0.25, 0.5] }],
      ["polyp"],
      0.25,
    );
    expect(calls).toContainEqual(["strokeRect", 110, 70, 50, 50]);
  });

  it("skips detections below the threshold", () => {
    const { ctx, calls } = fakeContext();
    drawDetections(
      ctx,
      rect,
      [{ class_id: 0, confidence: 0.2, bbox: [0.1, 0.1, 0.1, 0.1] }],
      ["polyp"],
      0.25,
    );
    expect(calls).toEqual([]);
  });

  it("fills a polygon for a segmentation detection", () => {
    const { ctx, calls } = fakeContext();
    drawDetections(
      ctx,
      rect,
      [
        {
          class_id: 0,
          confidence: 0.9,
          bbox: [0.1, 0.1, 0.4, 0.4],
          polygon: [[0.1, 0.1], [0.5, 0.1], [0.5, 0.5]],
        },
      ],
      ["polyp"],
      0.25,
    );
    const names = calls.map((c) => c[0]);
    expect(names).toContain("beginPath");
    expect(names).toContain("fill");
    expect(calls).toContainEqual(["moveTo", 30, 30]);
    expect(calls).toContainEqual(["lineTo", 110, 30]);
  });

  it("labels the box with the class name and confidence", () => {
    const { ctx, calls } = fakeContext();
    drawDetections(
      ctx,
      rect,
      [{ class_id: 1, confidence: 0.876, bbox: [0.1, 0.1, 0.1, 0.1] }],
      ["polyp", "fold"],
      0.25,
    );
    expect(calls.some((c) => c[0] === "fillText" && String(c[1]).startsWith("fold 0.88"))).toBe(true);
  });

  it("falls back to the class id when the name is unknown", () => {
    const { ctx, calls } = fakeContext();
    drawDetections(
      ctx,
      rect,
      [{ class_id: 7, confidence: 0.5, bbox: [0.1, 0.1, 0.1, 0.1] }],
      [],
      0.25,
    );
    expect(calls.some((c) => c[0] === "fillText" && String(c[1]).startsWith("#7"))).toBe(true);
  });
});
```


Create `frontend/src/entities/useInferenceRuns.test.tsx`:

```tsx
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { apiClient } from "../shared/api/client";
import { useInferenceRuns } from "./useInferenceRuns";

vi.mock("../shared/api/client", () => ({
  apiClient: { GET: vi.fn(), POST: vi.fn(), DELETE: vi.fn() },
}));

function wrapper({ children }: { children: ReactNode }) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}

describe("useInferenceRuns", () => {
  afterEach(() => vi.clearAllMocks());

  it("returns the list from the API", async () => {
    vi.mocked(apiClient.GET).mockResolvedValue({ data: [{ id: 3, status: "succeeded" }] } as never);
    const { result } = renderHook(() => useInferenceRuns(), { wrapper });
    await waitFor(() => expect(result.current.data).toEqual([{ id: 3, status: "succeeded" }]));
    expect(apiClient.GET).toHaveBeenCalledWith("/inference/runs", {});
  });
});
```

- [ ] **Step 3: Run them to verify they fail**

Run: `cd frontend && npx vitest run src/features/qc src/entities/useInferenceRuns.test.tsx`
Expected: FAIL with "Failed to resolve import" for the new modules.

- [ ] **Step 4: Implement**

Create `frontend/src/features/qc/predictions.ts`:

```ts
export interface Detection {
  class_id: number;
  confidence: number;
  /** [x, y, w, h], normalised 0..1, (x, y) the top-left corner. */
  bbox: [number, number, number, number];
  polygon?: [number, number][];
}

export interface PredictionsDocument {
  task_type: "detection" | "segmentation";
  model: { name: string; version_id: number | null };
  fps: number;
  frame_stride: number;
  classes: string[];
  frames: Record<string, { timestamp_ms: number; detections: Detection[] }>;
}

/** Processed frames sorted by time, so playback can binary-search them. */
export interface FrameIndex {
  timestamps: number[];
  detections: Detection[][];
}

/** The Ultralytics default. A slider replaces this in sub-project 2. */
export const DISPLAY_CONFIDENCE_THRESHOLD = 0.25;

export function buildFrameIndex(doc: PredictionsDocument): FrameIndex {
  const entries = Object.values(doc.frames).sort((a, b) => a.timestamp_ms - b.timestamp_ms);
  return {
    timestamps: entries.map((entry) => entry.timestamp_ms),
    detections: entries.map((entry) => entry.detections),
  };
}

/** Detections of the nearest processed frame at or before `timeMs`.
 * With a stride above 1 most playback times fall between processed
 * frames; holding the previous frame's result (rather than showing
 * nothing) keeps the overlay from flickering. */
export function detectionsAt(index: FrameIndex, timeMs: number): Detection[] {
  const { timestamps, detections } = index;
  if (timestamps.length === 0 || timeMs < timestamps[0]) return [];
  let low = 0;
  let high = timestamps.length - 1;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (timestamps[mid] <= timeMs) low = mid;
    else high = mid - 1;
  }
  return detections[low];
}

export function countByClass(index: FrameIndex, classCount: number, threshold: number): number[] {
  const counts = new Array<number>(classCount).fill(0);
  for (const frame of index.detections) {
    for (const detection of frame) {
      if (detection.confidence >= threshold && detection.class_id < classCount) {
        counts[detection.class_id] += 1;
      }
    }
  }
  return counts;
}

/** One palette for every run, so a class keeps its colour between runs.
 * The golden angle spreads neighbouring ids far apart on the hue wheel. */
export function colorForClass(classId: number): string {
  const hue = (classId * 137.508) % 360;
  return `hsl(${hue.toFixed(0)}, 85%, 60%)`;
}
```

Create `frontend/src/features/qc/drawDetections.ts`:

```ts
import { colorForClass, type Detection } from "./predictions";

export interface Rect {
  left: number;
  top: number;
  width: number;
  height: number;
}

const LABEL_FONT = "12px sans-serif";
const LABEL_HEIGHT = 16;

/** Draws onto a canvas that covers the whole <video> element. `rect` is
 * where the picture actually sits inside that element (letterboxing), so
 * normalised coordinates are scaled against it, not against the canvas. */
export function drawDetections(
  ctx: CanvasRenderingContext2D,
  rect: Rect,
  detections: Detection[],
  classes: string[],
  threshold: number,
): void {
  for (const detection of detections) {
    if (detection.confidence < threshold) continue;
    const color = colorForClass(detection.class_id);
    const [x, y, w, h] = detection.bbox;
    const px = rect.left + x * rect.width;
    const py = rect.top + y * rect.height;

    if (detection.polygon && detection.polygon.length > 0) {
      ctx.beginPath();
      detection.polygon.forEach(([vx, vy], i) => {
        const cx = rect.left + vx * rect.width;
        const cy = rect.top + vy * rect.height;
        if (i === 0) ctx.moveTo(cx, cy);
        else ctx.lineTo(cx, cy);
      });
      ctx.closePath();
      ctx.fillStyle = color;
      ctx.globalAlpha = 0.3;
      ctx.fill();
      ctx.globalAlpha = 1;
      ctx.strokeStyle = color;
      ctx.lineWidth = 2;
      ctx.stroke();
    }

    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.strokeRect(px, py, w * rect.width, h * rect.height);

    const name = classes[detection.class_id] ?? `#${detection.class_id}`;
    const label = `${name} ${detection.confidence.toFixed(2)}`;
    ctx.font = LABEL_FONT;
    const labelWidth = ctx.measureText(label).width + 8;
    ctx.fillStyle = color;
    ctx.fillRect(px, Math.max(py - LABEL_HEIGHT, 0), labelWidth, LABEL_HEIGHT);
    ctx.fillStyle = "#000000";
    ctx.fillText(label, px + 4, Math.max(py - LABEL_HEIGHT, 0) + 12);
  }
}
```

Create `frontend/src/entities/useModelVersions.ts`:

```ts
import { useQuery } from "@tanstack/react-query";

import { apiClient } from "../shared/api/client";

export function useModelVersions() {
  return useQuery({
    queryKey: ["model-versions"],
    queryFn: async () => {
      const result = await apiClient.GET("/training/models", {});
      return result.data ?? [];
    },
  });
}
```

Create `frontend/src/entities/useInferenceRuns.ts`:

```ts
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { apiClient } from "../shared/api/client";
import type { components } from "../shared/api/generated/schema";
import type { PredictionsDocument } from "../features/qc/predictions";

export type InferenceRun = components["schemas"]["InferenceRunRead"];

const POLL_INTERVAL_MS = 2000;

function isActive(run: InferenceRun): boolean {
  return run.status === "pending" || run.status === "running";
}

export function useInferenceRuns() {
  return useQuery({
    queryKey: ["inference-runs"],
    queryFn: async () => {
      const result = await apiClient.GET("/inference/runs", {});
      return result.data ?? [];
    },
    // Poll only while something is still running; an idle screen stays quiet.
    refetchInterval: (query) => ((query.state.data ?? []).some(isActive) ? POLL_INTERVAL_MS : false),
  });
}

export function useInferenceRun(runId: number | null) {
  return useQuery({
    queryKey: ["inference-run", runId],
    queryFn: async () => {
      const result = await apiClient.GET("/inference/runs/{run_id}", {
        params: { path: { run_id: runId as number } },
      });
      if (result.error) throw result.error;
      return result.data;
    },
    enabled: runId !== null,
    refetchInterval: (query) =>
      query.state.data && isActive(query.state.data) ? POLL_INTERVAL_MS : false,
  });
}

export function useCreateInferenceRun() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (body: { video_id: number; model_version_id: number; frame_stride: number }) => {
      const result = await apiClient.POST("/inference/runs", { body });
      if (result.error) throw result.error;
      return result.data;
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["inference-runs"] }),
  });
}

export function useDeleteInferenceRun() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (runId: number) => {
      const result = await apiClient.DELETE("/inference/runs/{run_id}", {
        params: { path: { run_id: runId } },
      });
      if (result.error) throw result.error;
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["inference-runs"] }),
  });
}

/** Downloads the predictions document once and keeps it in the cache. It
 * can be tens of megabytes for a long video, so it is never refetched on
 * focus. The presigned URL points at object storage, not the API, which
 * is why this is a plain fetch and not apiClient. */
export function usePredictions(runId: number | null, enabled: boolean) {
  return useQuery({
    queryKey: ["inference-predictions", runId],
    queryFn: async () => {
      const link = await apiClient.GET("/inference/runs/{run_id}/predictions", {
        params: { path: { run_id: runId as number } },
      });
      if (link.error || !link.data) throw link.error ?? new Error("No predictions link");
      const response = await fetch(link.data.download_url);
      if (!response.ok) throw new Error(`Could not download predictions (${response.status})`);
      return (await response.json()) as PredictionsDocument;
    },
    enabled: runId !== null && enabled,
    staleTime: Infinity,
    refetchOnWindowFocus: false,
  });
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd frontend && npx vitest run src/features/qc src/entities/useInferenceRuns.test.tsx && npx tsc --noEmit`
Expected: PASS. A red `npm run build` predates this work (see project memory); `tsc --noEmit` must show no errors in the new files.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/entities/useInferenceRuns.ts frontend/src/entities/useInferenceRuns.test.tsx frontend/src/entities/useModelVersions.ts frontend/src/features/qc/predictions.ts frontend/src/features/qc/predictions.test.ts frontend/src/features/qc/drawDetections.ts frontend/src/features/qc/drawDetections.test.ts
git commit -m "feat: add the QC data layer and prediction helpers" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 6: QC launch-and-history screen, navigation and routes

**Files:**
- Create: `frontend/src/features/qc/RunForm.tsx`, `RunStatus.tsx`, `RunsTable.tsx`, `QcPage.tsx`
- Test: `frontend/src/features/qc/RunForm.test.tsx`, `RunStatus.test.tsx`, `RunsTable.test.tsx`
- Modify: `frontend/src/app/AppHeader.tsx`, `frontend/src/app/AppHeader.test.tsx`, `frontend/src/app/App.tsx`

**Interfaces:**
- Consumes: `useInferenceRuns`, `useCreateInferenceRun`, `useDeleteInferenceRun`, `InferenceRun` (Task 5); `useModelVersions`; `useVideos`; `VideoUploadFlow` (`onVideoUploaded(videoId)`).
- Produces: `RunForm` props `{ models: ModelOption[]; videos: VideoOption[]; videoId: number | null; onVideoChange(id: number | null): void; onSubmit(values: { modelVersionId: number; videoId: number; frameStride: number }): void; submitting: boolean; error: string | null }` with `ModelOption = { id: number; name: string; task_type: string }` and `VideoOption = { id: number; title: string }`; `RunStatus` props `{ run: InferenceRun | null }`; `RunsTable` props `{ runs: InferenceRun[]; videoTitles: Record<number, string>; onDelete(id: number): void }`; route `/qc` -> `QcPage`.

- [ ] **Step 1: Write the failing tests**

Create `frontend/src/features/qc/RunForm.test.tsx`:

```tsx
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { RunForm } from "./RunForm";

const models = [
  { id: 4, name: "yolo11n-run7", task_type: "detection" },
  { id: 5, name: "yolo11n-seg-run8", task_type: "segmentation" },
];
const videos = [{ id: 9, title: "Colonoscopy A" }];

function setup(overrides = {}) {
  const props = {
    models,
    videos,
    videoId: null as number | null,
    onVideoChange: vi.fn(),
    onSubmit: vi.fn(),
    submitting: false,
    error: null as string | null,
    ...overrides,
  };
  render(<RunForm {...props} />);
  return props;
}

describe("RunForm", () => {
  it("keeps Run disabled until a model and a video are chosen", async () => {
    setup();
    expect(screen.getByRole("button", { name: "Run" })).toBeDisabled();
  });

  it("submits the chosen model, video and stride", async () => {
    const user = userEvent.setup();
    const props = setup({ videoId: 9 });
    await user.selectOptions(screen.getByLabelText("Model"), "5");
    await user.clear(screen.getByLabelText("Frame stride"));
    await user.type(screen.getByLabelText("Frame stride"), "5");
    await user.click(screen.getByRole("button", { name: "Run" }));
    expect(props.onSubmit).toHaveBeenCalledWith({ modelVersionId: 5, videoId: 9, frameStride: 5 });
  });

  it("defaults the stride to 1", () => {
    setup();
    expect(screen.getByLabelText("Frame stride")).toHaveValue(1);
  });

  it("guides the user when there is no usable model", () => {
    setup({ models: [] });
    expect(screen.getByText(/train a detect or segment model first/i)).toBeInTheDocument();
  });

  it("shows a submit error", () => {
    setup({ error: "Video 9 is not browser-playable" });
    expect(screen.getByText("Video 9 is not browser-playable")).toBeInTheDocument();
  });
});
```

Create `frontend/src/features/qc/RunStatus.test.tsx`:

```tsx
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import type { InferenceRun } from "../../entities/useInferenceRuns";
import { RunStatus } from "./RunStatus";

const base: InferenceRun = {
  id: 1,
  video_id: 9,
  model_version_id: 4,
  model_name: "yolo11n-run7",
  job_id: 3,
  frame_stride: 1,
  status: "running",
  frames_total: 4500,
  frames_processed: 1200,
  error: null,
  created_at: "2026-10-06T10:00:00Z",
  started_at: "2026-10-06T10:00:01Z",
  finished_at: null,
};

describe("RunStatus", () => {
  it("shows the frame counter and a progress bar while running", () => {
    render(<RunStatus run={base} />);
    expect(screen.getByText("running")).toBeInTheDocument();
    expect(screen.getByText("1200 / 4500 frames")).toBeInTheDocument();
    expect(screen.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "27");
  });

  it("shows the error of a failed run", () => {
    render(<RunStatus run={{ ...base, status: "failed", error: "Could not open the video file" }} />);
    expect(screen.getByText("Could not open the video file")).toBeInTheDocument();
  });

  it("says so when nothing has been run", () => {
    render(<RunStatus run={null} />);
    expect(screen.getByText(/no run selected/i)).toBeInTheDocument();
  });
});
```

Create `frontend/src/features/qc/RunsTable.test.tsx`:

```tsx
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";

import type { InferenceRun } from "../../entities/useInferenceRuns";
import { RunsTable } from "./RunsTable";

const run = (over: Partial<InferenceRun>): InferenceRun => ({
  id: 1,
  video_id: 9,
  model_version_id: 4,
  model_name: "yolo11n-run7",
  job_id: 3,
  frame_stride: 5,
  status: "succeeded",
  frames_total: 10,
  frames_processed: 10,
  error: null,
  created_at: "2026-10-06T10:00:00Z",
  started_at: null,
  finished_at: null,
  ...over,
});

function renderTable(runs: InferenceRun[], onDelete = vi.fn()) {
  render(
    <MemoryRouter>
      <RunsTable runs={runs} videoTitles={{ 9: "Colonoscopy A" }} onDelete={onDelete} />
    </MemoryRouter>,
  );
  return onDelete;
}

describe("RunsTable", () => {
  it("shows the video title and the model name copied onto the run", () => {
    renderTable([run({ model_version_id: null })]);
    expect(screen.getByText("Colonoscopy A")).toBeInTheDocument();
    expect(screen.getByText("yolo11n-run7")).toBeInTheDocument();
  });

  it("links a succeeded run to its view", () => {
    renderTable([run({ id: 12 })]);
    expect(screen.getByRole("link", { name: "View" })).toHaveAttribute("href", "/qc/12");
  });

  it("does not offer View for a run that has not succeeded", () => {
    renderTable([run({ status: "running" })]);
    expect(screen.queryByRole("link", { name: "View" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "View" })).toBeDisabled();
  });

  it("does not offer Delete while a run is active", () => {
    renderTable([run({ status: "pending" })]);
    expect(screen.getByRole("button", { name: "Delete" })).toBeDisabled();
  });

  it("deletes only after the second press", async () => {
    const user = userEvent.setup();
    const onDelete = renderTable([run({ id: 12 })]);
    await user.click(screen.getByRole("button", { name: "Delete" }));
    expect(onDelete).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Confirm" }));
    expect(onDelete).toHaveBeenCalledWith(12);
  });

  it("shows an empty state", () => {
    renderTable([]);
    expect(screen.getByText(/no runs yet/i)).toBeInTheDocument();
  });
});
```

In `frontend/src/app/AppHeader.test.tsx` add inside the file:

```tsx
describe("AppHeader navigation", () => {
  it("links QC to /qc and no longer shows Results", () => {
    mockAuth("admin");
    render(<AppHeader />, { wrapper: MemoryRouter });
    expect(screen.getByRole("link", { name: "QC" })).toHaveAttribute("href", "/qc");
    expect(screen.queryByText("Results")).not.toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd frontend && npx vitest run src/features/qc src/app/AppHeader.test.tsx`
Expected: FAIL (modules missing; AppHeader still shows Results).

- [ ] **Step 3: Implement the components**

Create `frontend/src/features/qc/RunForm.tsx`:

```tsx
import { useState } from "react";

export interface ModelOption {
  id: number;
  name: string;
  task_type: string;
}

export interface VideoOption {
  id: number;
  title: string;
}

interface RunFormProps {
  models: ModelOption[];
  videos: VideoOption[];
  videoId: number | null;
  onVideoChange: (id: number | null) => void;
  onSubmit: (values: { modelVersionId: number; videoId: number; frameStride: number }) => void;
  submitting: boolean;
  error: string | null;
}

const FIELD =
  "rounded border border-gray-700 bg-gray-900 px-2 py-1.5 text-sm text-gray-100 focus:border-blue-500 focus:outline-none";

export function RunForm({
  models,
  videos,
  videoId,
  onVideoChange,
  onSubmit,
  submitting,
  error,
}: RunFormProps) {
  const [modelId, setModelId] = useState<number | null>(null);
  const [stride, setStride] = useState(1);

  const canRun = modelId !== null && videoId !== null && stride >= 1 && !submitting;

  function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (modelId === null || videoId === null) return;
    onSubmit({ modelVersionId: modelId, videoId, frameStride: stride });
  }

  return (
    <form
      onSubmit={handleSubmit}
      className="flex flex-col gap-3 rounded border border-gray-800 bg-gray-900 p-4"
    >
      <h2 className="text-sm font-semibold text-gray-200">Run inference</h2>

      {models.length === 0 ? (
        <p className="text-sm text-gray-500">Train a detect or segment model first.</p>
      ) : (
        <label className="flex flex-col gap-1 text-sm text-gray-300">
          Model
          <select
            value={modelId ?? ""}
            onChange={(e) => setModelId(e.target.value ? Number(e.target.value) : null)}
            className={FIELD}
          >
            <option value="" disabled>
              Select a model
            </option>
            {models.map((model) => (
              <option key={model.id} value={model.id}>
                {model.name} ({model.task_type})
              </option>
            ))}
          </select>
        </label>
      )}

      <label className="flex flex-col gap-1 text-sm text-gray-300">
        Video
        <select
          value={videoId ?? ""}
          onChange={(e) => onVideoChange(e.target.value ? Number(e.target.value) : null)}
          className={FIELD}
        >
          <option value="" disabled>
            Select a video
          </option>
          {videos.map((video) => (
            <option key={video.id} value={video.id}>
              {video.title}
            </option>
          ))}
        </select>
      </label>

      <label className="flex flex-col gap-1 text-sm text-gray-300">
        Frame stride
        <input
          type="number"
          min={1}
          max={1000}
          value={stride}
          onChange={(e) => setStride(Number(e.target.value))}
          className={FIELD}
        />
        <span className="text-xs text-gray-500">
          1 runs every frame; 5 runs every fifth frame, which is much faster on a long video.
        </span>
      </label>

      {error && <p className="text-sm text-red-400">{error}</p>}

      <button
        type="submit"
        disabled={!canRun}
        className="rounded bg-blue-600 px-3 py-1.5 text-sm text-white disabled:opacity-50"
      >
        Run
      </button>
    </form>
  );
}
```

Create `frontend/src/features/qc/RunStatus.tsx`:

```tsx
import type { InferenceRun } from "../../entities/useInferenceRuns";

const BADGE: Record<string, string> = {
  pending: "bg-gray-700 text-gray-200",
  running: "bg-blue-700 text-white",
  succeeded: "bg-green-700 text-white",
  failed: "bg-red-700 text-white",
};

export function RunStatus({ run }: { run: InferenceRun | null }) {
  if (run === null) {
    return (
      <div className="rounded border border-gray-800 bg-gray-900 p-4 text-sm text-gray-500">
        No run selected.
      </div>
    );
  }

  const percent =
    run.frames_total > 0 ? Math.floor((run.frames_processed / run.frames_total) * 100) : 0;

  return (
    <div className="flex flex-col gap-3 rounded border border-gray-800 bg-gray-900 p-4">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold text-gray-200">Run #{run.id}</h2>
        <span className={`rounded px-2 py-0.5 text-xs ${BADGE[run.status] ?? BADGE.pending}`}>
          {run.status}
        </span>
      </div>
      <div
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent}
        className="h-2 overflow-hidden rounded bg-gray-800"
      >
        <div className="h-full bg-blue-500" style={{ width: `${percent}%` }} />
      </div>
      <p className="text-sm text-gray-400">
        {run.frames_processed} / {run.frames_total} frames
      </p>
      {run.error && <p className="text-sm text-red-400">{run.error}</p>}
    </div>
  );
}
```

Create `frontend/src/features/qc/RunsTable.tsx`:

```tsx
import { useState } from "react";
import { Link } from "react-router-dom";

import type { InferenceRun } from "../../entities/useInferenceRuns";

interface RunsTableProps {
  runs: InferenceRun[];
  videoTitles: Record<number, string>;
  onDelete: (id: number) => void;
}

const BUTTON = "rounded border border-gray-700 px-2 py-1 text-xs text-gray-300";

export function RunsTable({ runs, videoTitles, onDelete }: RunsTableProps) {
  const [armed, setArmed] = useState<number | null>(null);

  if (runs.length === 0) {
    return <p className="text-sm text-gray-500">No runs yet.</p>;
  }

  return (
    <table className="w-full text-left text-sm text-gray-200">
      <thead>
        <tr className="border-b border-gray-800 text-gray-400">
          <th className="px-4 py-2 font-normal">Video</th>
          <th className="px-4 py-2 font-normal">Model</th>
          <th className="px-4 py-2 font-normal">Stride</th>
          <th className="px-4 py-2 font-normal">Status</th>
          <th className="px-4 py-2 font-normal">Date</th>
          <th className="px-4 py-2 text-right font-normal">Actions</th>
        </tr>
      </thead>
      <tbody>
        {runs.map((run) => {
          const active = run.status === "pending" || run.status === "running";
          return (
            <tr key={run.id} className="border-b border-gray-900">
              <td className="px-4 py-2">{videoTitles[run.video_id] ?? `Video ${run.video_id}`}</td>
              <td className="px-4 py-2 text-gray-400">{run.model_name}</td>
              <td className="px-4 py-2 text-gray-400">{run.frame_stride}</td>
              <td className="px-4 py-2 text-gray-400">{run.status}</td>
              <td className="px-4 py-2 text-gray-400">
                {new Date(run.created_at).toLocaleDateString()}
              </td>
              <td className="px-4 py-2 text-right">
                {run.status === "succeeded" ? (
                  <Link to={`/qc/${run.id}`} className={`${BUTTON} mr-2 inline-block hover:text-gray-100`}>
                    View
                  </Link>
                ) : (
                  <button type="button" disabled className={`${BUTTON} mr-2 opacity-50`}>
                    View
                  </button>
                )}
                {armed === run.id ? (
                  <button
                    type="button"
                    className="rounded bg-red-700 px-2 py-1 text-xs text-white"
                    onClick={() => {
                      onDelete(run.id);
                      setArmed(null);
                    }}
                  >
                    Confirm
                  </button>
                ) : (
                  <button
                    type="button"
                    disabled={active}
                    className={`${BUTTON} disabled:opacity-50`}
                    onClick={() => setArmed(run.id)}
                  >
                    Delete
                  </button>
                )}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
```

Create `frontend/src/features/qc/QcPage.tsx`:

```tsx
import { useState } from "react";

import {
  useCreateInferenceRun,
  useDeleteInferenceRun,
  useInferenceRuns,
} from "../../entities/useInferenceRuns";
import { useModelVersions } from "../../entities/useModelVersions";
import { useVideos } from "../../entities/useVideos";
import { VideoUploadFlow } from "../media/VideoUploadFlow";
import { RunForm } from "./RunForm";
import { RunStatus } from "./RunStatus";
import { RunsTable } from "./RunsTable";

// Only the model types the worker can run; classification is a later slice.
const RUNNABLE = new Set(["detection", "segmentation"]);

export function QcPage() {
  const runsQuery = useInferenceRuns();
  const modelsQuery = useModelVersions();
  const videosQuery = useVideos();
  const createRun = useCreateInferenceRun();
  const deleteRun = useDeleteInferenceRun();

  const [videoId, setVideoId] = useState<number | null>(null);
  const [selectedRunId, setSelectedRunId] = useState<number | null>(null);
  const [showUpload, setShowUpload] = useState(false);

  const runs = runsQuery.data ?? [];
  const videos = videosQuery.data ?? [];
  const models = (modelsQuery.data ?? []).filter((m) => RUNNABLE.has(m.task_type));
  const videoTitles = Object.fromEntries(videos.map((v) => [v.id, v.title]));
  const shownRun =
    runs.find((run) => run.id === selectedRunId) ??
    runs.find((run) => run.status === "pending" || run.status === "running") ??
    runs[0] ??
    null;

  const submitError = createRun.error ? errorMessage(createRun.error) : null;

  return (
    <div className="flex flex-col gap-6 p-6">
      <h1 className="text-xl font-semibold text-gray-100">QC</h1>
      <div className="grid gap-6 lg:grid-cols-2">
        <div className="flex flex-col gap-3">
          <RunForm
            models={models}
            videos={videos}
            videoId={videoId}
            onVideoChange={setVideoId}
            submitting={createRun.isPending}
            error={submitError}
            onSubmit={({ modelVersionId, videoId: vid, frameStride }) =>
              createRun.mutate(
                { model_version_id: modelVersionId, video_id: vid, frame_stride: frameStride },
                { onSuccess: (run) => run && setSelectedRunId(run.id) },
              )
            }
          />
          <button
            type="button"
            onClick={() => setShowUpload((open) => !open)}
            className="self-start text-sm text-blue-400 hover:underline"
          >
            {showUpload ? "Hide upload" : "Upload a new video"}
          </button>
          {showUpload && (
            <VideoUploadFlow
              onVideoUploaded={(id) => {
                setVideoId(id);
                setShowUpload(false);
              }}
            />
          )}
        </div>
        <RunStatus run={shownRun} />
      </div>
      <RunsTable
        runs={runs}
        videoTitles={videoTitles}
        onDelete={(id) => deleteRun.mutate(id)}
      />
    </div>
  );
}

function errorMessage(error: unknown): string {
  if (error && typeof error === "object" && "detail" in error) {
    const detail = (error as { detail: unknown }).detail;
    if (typeof detail === "string") return detail;
  }
  return "Could not start the run";
}
```

- [ ] **Step 4: Wire navigation and routes**

In `frontend/src/app/AppHeader.tsx` change `{ label: "Results", path: null },` to `{ label: "QC", path: "/qc" },`.

In `frontend/src/app/App.tsx` add `import { QcPage } from "../features/qc/QcPage";` (sorted among the feature imports) and, after the `/train` route, `<Route path="/qc" element={<QcPage />} />`. (The `/qc/:runId` route arrives in Task 7.)

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd frontend && npx vitest run src/features/qc src/app && npx tsc --noEmit`
Expected: PASS, no type errors in the changed files.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/features/qc frontend/src/app
git commit -m "feat: add the QC screen with run form, status and history" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 7: Run view with the canvas overlay

**Files:**
- Create: `frontend/src/features/qc/PredictionOverlay.tsx`, `frontend/src/features/qc/RunViewPage.tsx`
- Modify: `frontend/src/app/App.tsx`

**Interfaces:**
- Consumes: `useInferenceRun`, `usePredictions`, `useVideo` (existing, returns `stream_url`, `browser_playable`, `title`); `TranscodePrompt` props `(videoId, onTranscodeComplete)`; `computeVideoMediaRect`; `buildFrameIndex`, `detectionsAt`, `countByClass`, `colorForClass`, `DISPLAY_CONFIDENCE_THRESHOLD`; `drawDetections`.
- Produces: route `/qc/:runId`; `PredictionOverlay` props `{ videoRef: React.RefObject<HTMLVideoElement | null>; index: FrameIndex; classes: string[] }`.

Pure logic is already covered in Task 5. These two components are browser glue (canvas, `<video>`, layout): jsdom has no canvas and no video clock, so a unit test would only assert mocks. They are verified in the real browser in Task 8, which is where the CLAUDE.md testing philosophy says this kind of code must be checked.

- [ ] **Step 1: Implement the overlay**

Create `frontend/src/features/qc/PredictionOverlay.tsx`:

```tsx
import { useEffect, useRef } from "react";

import { computeVideoMediaRect } from "../media/computeVideoMediaRect";
import { drawDetections } from "./drawDetections";
import { DISPLAY_CONFIDENCE_THRESHOLD, detectionsAt, type FrameIndex } from "./predictions";

interface PredictionOverlayProps {
  videoRef: React.RefObject<HTMLVideoElement | null>;
  index: FrameIndex;
  classes: string[];
}

/** A canvas laid exactly over the <video> element. A rAF loop redraws only
 * when the video time or the element size changed, which covers playback,
 * pausing and scrubbing with one mechanism. */
export function PredictionOverlay({ videoRef, index, classes }: PredictionOverlayProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    let frameHandle = 0;
    let lastKey = "";

    function tick() {
      const video = videoRef.current;
      const canvas = canvasRef.current;
      if (video && canvas) {
        const width = video.clientWidth;
        const height = video.clientHeight;
        const timeMs = Math.round(video.currentTime * 1000);
        const key = `${timeMs}|${width}|${height}|${video.videoWidth}|${video.videoHeight}`;
        if (key !== lastKey) {
          lastKey = key;
          if (canvas.width !== width) canvas.width = width;
          if (canvas.height !== height) canvas.height = height;
          const ctx = canvas.getContext("2d");
          const rect = computeVideoMediaRect(video.videoWidth, video.videoHeight, width, height);
          if (ctx && rect) {
            ctx.clearRect(0, 0, width, height);
            drawDetections(
              ctx,
              rect,
              detectionsAt(index, timeMs),
              classes,
              DISPLAY_CONFIDENCE_THRESHOLD,
            );
          }
        }
      }
      frameHandle = requestAnimationFrame(tick);
    }

    frameHandle = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frameHandle);
  }, [videoRef, index, classes]);

  return <canvas ref={canvasRef} className="pointer-events-none absolute inset-0 h-full w-full" />;
}
```

Create `frontend/src/features/qc/RunViewPage.tsx`:

```tsx
import { useMemo, useRef } from "react";
import { Link, useParams } from "react-router-dom";

import { useInferenceRun, usePredictions } from "../../entities/useInferenceRuns";
import { useVideo } from "../../entities/useVideo";
import { TranscodePrompt } from "../media/TranscodePrompt";
import { PredictionOverlay } from "./PredictionOverlay";
import {
  DISPLAY_CONFIDENCE_THRESHOLD,
  buildFrameIndex,
  colorForClass,
  countByClass,
} from "./predictions";
import { RunStatus } from "./RunStatus";

export function RunViewPage() {
  const params = useParams();
  const runId = params.runId ? Number(params.runId) : null;
  const runQuery = useInferenceRun(runId);
  const run = runQuery.data ?? null;
  const videoQuery = useVideo(run?.video_id ?? null);
  const predictionsQuery = usePredictions(runId, run?.status === "succeeded");
  const videoRef = useRef<HTMLVideoElement>(null);

  const document = predictionsQuery.data;
  const index = useMemo(() => (document ? buildFrameIndex(document) : null), [document]);
  const counts = useMemo(
    () =>
      document && index
        ? countByClass(index, document.classes.length, DISPLAY_CONFIDENCE_THRESHOLD)
        : [],
    [document, index],
  );

  const video = videoQuery.data;

  return (
    <div className="flex flex-col gap-4 p-6">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold text-gray-100">
          {video?.title ?? "Run"} · {run?.model_name}
        </h1>
        <Link to="/qc" className="text-sm text-blue-400 hover:underline">
          ← Back to QC
        </Link>
      </div>

      {runQuery.isError && <p className="text-sm text-red-400">This run could not be loaded.</p>}

      {run && run.status !== "succeeded" && <RunStatus run={run} />}

      {run?.status === "succeeded" && video?.browser_playable === false && (
        <TranscodePrompt videoId={video.id} onTranscodeComplete={() => videoQuery.refetch()} />
      )}

      {run?.status === "succeeded" && video && video.browser_playable !== false && (
        <div className="flex flex-col gap-4 lg:flex-row">
          <div className="relative flex-1 bg-black">
            <video
              ref={videoRef}
              src={video.stream_url}
              controls
              className="block max-h-[70vh] w-full"
            />
            {index && document && (
              <PredictionOverlay videoRef={videoRef} index={index} classes={document.classes} />
            )}
            {predictionsQuery.isPending && (
              <p className="absolute left-2 top-2 rounded bg-gray-900/80 px-2 py-1 text-xs text-gray-300">
                Loading predictions…
              </p>
            )}
            {predictionsQuery.isError && (
              <p className="absolute left-2 top-2 rounded bg-red-900/80 px-2 py-1 text-xs text-red-100">
                Could not load predictions.
              </p>
            )}
          </div>
          <aside className="w-full shrink-0 rounded border border-gray-800 bg-gray-900 p-4 lg:w-64">
            <h2 className="mb-2 text-sm font-semibold text-gray-200">Classes</h2>
            {document && document.classes.length > 0 ? (
              <ul className="flex flex-col gap-1 text-sm text-gray-300">
                {document.classes.map((name, id) => (
                  <li key={id} className="flex items-center justify-between">
                    <span className="flex items-center gap-2">
                      <span
                        className="inline-block h-3 w-3 rounded-sm"
                        style={{ backgroundColor: colorForClass(id) }}
                      />
                      {name}
                    </span>
                    <span className="text-gray-500">{counts[id] ?? 0}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-gray-500">No classes.</p>
            )}
            <p className="mt-3 text-xs text-gray-500">
              Showing detections at confidence {DISPLAY_CONFIDENCE_THRESHOLD} and above.
            </p>
          </aside>
        </div>
      )}
    </div>
  );
}
```

In `frontend/src/app/App.tsx` add `import { RunViewPage } from "../features/qc/RunViewPage";` and, after the `/qc` route, `<Route path="/qc/:runId" element={<RunViewPage />} />`.

- [ ] **Step 2: Type-check and run the whole frontend suite**

Run: `cd frontend && npx tsc --noEmit && npx vitest run`
Expected: no type errors in the new files; all frontend tests PASS (compare any failure against the known pre-existing red set before treating it as yours).

- [ ] **Step 3: Commit**

```bash
git add frontend/src/features/qc frontend/src/app/App.tsx
git commit -m "feat: view an inference run with a canvas overlay" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 8: Real-stack verification and roadmap

This task is manual on purpose. CLAUDE.md records three bugs that only a real browser against the real stack caught; this feature adds two new cross-origin paths (the presigned MinIO fetch and the `<video>` stream) and a GPU worker, none of which any unit test touches.

**Files:**
- Modify: `ROADMAP.md`

- [ ] **Step 1: Bring up the stack**

Run: `docker compose up -d`, then re-copy `ml-worker/app` into the container as in Global Constraints and `docker compose restart ml-worker` so it registers the `inference_run` task. Start the API (`cd backend && uv run uvicorn app.main:app --reload`), the transcode worker **with** `-Q video_transcode`, and the frontend.

The backend allows CORS only from `localhost:5173`/`127.0.0.1:5173`. At the time of planning, another project's Vite held :5173 and this project's frontend fell back to :5174. **Ask the user before stopping that process or changing the allowlist**; do neither on your own.

- [ ] **Step 2: Drive the real flow**

Log in as `manualcheck@example.com` (credentials in the project memory note `reference_manual_check_login_and_taxonomy_reimport.md`). Then, in the browser:

1. Open `/qc`: the nav shows `QC` and no `Results`; the model list contains only detection/segmentation models.
2. Pick a real trained detect model and a real browser-playable video, stride 5, press Run. The status badge goes pending -> running, the counter and bar advance, then it reads succeeded without a page reload.
3. Press View. The video plays and boxes follow it; pause, scrub backwards and forwards and confirm the overlay tracks the picture rather than the element (check on a video whose aspect ratio is not the element's, so the letterboxing is real).
4. Browser console and network tab: no CORS errors on the presigned predictions fetch or the video stream.
5. Repeat once with a segmentation model and confirm translucent polygons.
6. Run with stride 1000: the run succeeds and shows frame 0's result only.
7. Delete a succeeded run: the row disappears and `inference/<id>/predictions.json` is gone from MinIO (list the `inference/` prefix; do not spot-check one key).
8. Delete a model version that has a run, reload `/qc`, and confirm the run is still listed and still viewable.

Report each item as passed or failed with what was observed. A failure is fixed in the owning task's files with a new failing test where one can exist.

- [ ] **Step 3: Sweep what the verification created**

Back up to the scratchpad first, then delete by precise predicate every `inference_runs` row, its `jobs` row, and the `inference/` objects this session created, plus any uploaded test video. Confirm with `select count(*) from inference_runs;` and a listing of the `inference/` prefix.

- [ ] **Step 4: Update the roadmap**

In `ROADMAP.md` change the heading `### Phase 3: QC screen, sub-project 1 (inference runs) — NOT STARTED (design approved 2026-10-06)` to `... — DONE (<date>)`, replace "Implementation plan: not written yet." with a link to this plan, and add a short **Deviations** list covering whatever the implementation actually changed from the spec (at minimum: `model_name` column, top-left `bbox`, rAF overlay loop, no drag-and-drop, delete refused while active) and the verification results from Step 2, including anything that failed and how it was fixed.

- [ ] **Step 5: Commit**

```bash
git add ROADMAP.md
git commit -m "docs: record the QC inference runs verification in the roadmap" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```
