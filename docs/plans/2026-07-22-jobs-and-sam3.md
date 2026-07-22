# Jobs Infrastructure and SAM-3 Segmentation Adapter Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the `jobs` domain (async task tracking, Celery + Redis) and a real GPU-backed ML worker running Meta's SAM-3 for interactive segmentation — `predict()` on a single frame (point/box prompts) and `track()` across a sequence's frames — with progress visible on the frontend via polling (SSE deferred), producing `Annotation` rows of type `mask` with the raster mask stored in MinIO.

**Architecture:** A new `backend/app/jobs` package (FastAPI routes + SQLAlchemy model, in the existing `endoscopy-platform-backend` process) owns the `Job` row and enqueues Celery tasks. A new, separate `ml-worker` Python project (own `pyproject.toml`, own `uv` environment, GPU-enabled Docker image) runs the Celery worker process, holds the SAM-3 model in memory, and talks to Postgres/MinIO directly — it does not import from `backend/app`; it duplicates the small set of models/schemas it needs (matches the existing project's own precedent: no shared package between frontend and backend either, see design spec's modular-monolith rationale). The worker updates `Job.progress`/`status` as it runs; the API's `GET /jobs/{id}` reads that row. The frontend polls via TanStack Query `refetchInterval`.

**Tech Stack:** Celery 5.x, Redis (already provisioned, unused until now), `sam3` (Meta AI, installed from `git+https://github.com/facebookresearch/sam3.git`), PyTorch 2.7+ with CUDA support, `huggingface_hub` for gated checkpoint download, Docker Compose with NVIDIA GPU passthrough (`nvidia` runtime, confirmed available in this environment via `docker info`).

## Global Constraints

- License: Apache 2.0 for this project's own code. SAM-3 weights/code are under Meta's custom **SAM License** (not Apache/MIT/OSI-approved) — see `NOTICE` at repo root, already updated with the full terms. The worker must not redistribute SAM-3 weights; it downloads them at build/first-run time via an authenticated Hugging Face token the operator supplies (`HF_TOKEN` env var), never commits them to the repo or to MinIO as a "model artifact for redistribution."
- Language: English only in all code, comments, docstrings, and UI copy. No Russian in the repository.
- UI theme: dark is the only implemented theme (unchanged from Phase 1) — any new frontend component must use the existing dark Tailwind classes, never introduce a light background.
- Object storage: all binary media (masks, in this plan) goes through `StorageService` — never a direct filesystem path in domain code. The ML worker gets its own copy of `StorageService` (see Task 2) since it doesn't import `backend/app`.
- `taxonomy_version` must be attached to any data referencing a `Label` — the mask `Annotation` created by this plan follows the same rule already enforced for classification annotations in Phase 1: copy `Label.taxonomy_version` at creation time.
- API contract: REST + OpenAPI for the `jobs` endpoints on the existing FastAPI app — the frontend TypeScript client is regenerated from the schema, no hand-written untyped fetch calls.
- TDD: every backend task and every frontend task with logic writes a failing test before the implementation. The ML worker's SAM-3 integration test requires a real GPU and real (gated) model weights — see Task 6's explicit note on how that test is scoped so CI/environments without a GPU or HF access aren't blocked.
- GPU: this environment has one NVIDIA GPU (RTX 2070, 8GB VRAM, CUDA 13.0, confirmed via `nvidia-smi`) and Docker's `nvidia` runtime is already configured (confirmed via `docker info`). 8GB is a real constraint, not a comfortable margin — this plan's research did not verify SAM-3's actual VRAM footprint against real weights (no GPU/HF access in the research sandbox). Task 6, Step 6 (first real model load) is the actual point this gets confirmed; if `torch.cuda.OutOfMemoryError` occurs there, report BLOCKED rather than silently reducing image resolution or switching to a smaller checkpoint variant without checking with the human first. Do not load multiple large models in the worker process simultaneously (e.g. both the image and video predictors at once beyond what Task 7's lazy-loading already does) without checking VRAM headroom.

---

## File Structure

```
endoscopy-platform/
  docker-compose.yml                  # MODIFIED: add ml-worker service (GPU)
  .env.example                        # MODIFIED: add HF_TOKEN, CELERY_* vars
  backend/
    app/
      jobs/
        __init__.py
        models.py                     # Job model
        schemas.py                    # JobCreate, JobRead
        service.py                    # enqueue_sam3_predict_job, enqueue_sam3_track_job
        router.py                     # POST /jobs/sam3/predict, POST /jobs/sam3/track, GET /jobs/{id}
      celery_app.py                   # Celery app instance (broker config only — API process
                                       #   enqueues tasks by name, never imports worker task code)
      main.py                         # MODIFIED: mount jobs router
      alembic/env.py                  # MODIFIED: import jobs.models
    tests/
      test_jobs.py
  ml-worker/
    pyproject.toml
    Dockerfile
    app/
      __init__.py
      config.py                       # WorkerSettings (own copy: db/redis/minio/hf config)
      db.py                           # own engine/session (mirrors backend/app/db.py)
      storage.py                      # own StorageService (mirrors backend/app/storage.py)
      models.py                       # minimal read/write models: Job, Frame, Annotation
                                       #   (only the columns this worker touches)
      celery_app.py                   # Celery app instance, same broker config as backend
      sam3_adapter.py                 # Sam3Adapter: predict(), track()
      tasks.py                        # Celery tasks: run_sam3_predict, run_sam3_track
    tests/
      conftest.py
      test_sam3_adapter.py            # marked slow/gpu, skipped without SAM3_WEIGHTS_AVAILABLE=1
      test_tasks.py                   # tests task orchestration logic with a stubbed adapter
  frontend/
    src/
      entities/
        useJobs.ts                    # useJob(jobId) — polling query
      features/
        annotation/
          FrameAnnotationPage.tsx     # MODIFIED: add "Segment with SAM-3" point-prompt UI
          SegmentButton.tsx           # click-to-place-point, calls POST /jobs/sam3/predict
    tests/
      useJobs.test.ts
      SegmentButton.test.tsx
```

---

### Task 1: `jobs` domain — Job model, schemas, and REST endpoints (no Celery yet)

**Files:**
- Create: `backend/app/jobs/__init__.py`
- Create: `backend/app/jobs/models.py`
- Create: `backend/app/jobs/schemas.py`
- Create: `backend/app/jobs/router.py`
- Modify: `backend/app/main.py` — mount jobs router
- Modify: `backend/alembic/env.py` — import `jobs.models`
- Create: `backend/tests/test_jobs.py`

**Interfaces:**
- Consumes: `app.db.Base`, `app.db.get_session`, `app.auth.dependencies.get_current_user` (all from Phase 1).
- Produces: `app.jobs.models.Job(id, job_type, status, progress, payload, result_ref, error, created_by_id, started_at, finished_at, created_at)` where `job_type` is `"sam3_predict" | "sam3_track"` (only these two in this plan; the design spec's `export`/`train` types are future work) and `status` is `"pending" | "running" | "succeeded" | "failed"`.
- Produces: route `GET /jobs/{id}` (requires auth → 200 with `JobRead`, or 404). This task does NOT add the enqueue endpoints yet — those come in Task 3 once Celery exists to enqueue into. Building the read side first means Task 1 is independently testable without a message broker.

- [ ] **Step 1: Write the failing tests**

`backend/tests/test_jobs.py`:
```python
from fastapi.testclient import TestClient

from app.main import app

client = TestClient(app)


def _register_and_login(email: str) -> str:
    client.post("/auth/register", json={"email": email, "password": "pass1234", "role": "annotator"})
    response = client.post("/auth/login", json={"email": email, "password": "pass1234"})
    return response.json()["access_token"]


def _auth_headers(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


def test_get_job_requires_auth():
    response = client.get("/jobs/1")
    assert response.status_code == 401


def test_get_nonexistent_job_returns_404():
    token = _auth_headers(_register_and_login("jobs1@example.com"))
    response = client.get("/jobs/999999", headers=token)
    assert response.status_code == 404


def test_get_job_returns_current_state():
    from app.db import SessionLocal
    from app.jobs.models import Job, JobStatus, JobType

    token_str = _register_and_login("jobs2@example.com")
    token = _auth_headers(token_str)

    me_response = client.get("/auth/me", headers=token)
    user_id = me_response.json()["id"]

    session = SessionLocal()
    job = Job(
        job_type=JobType.SAM3_PREDICT,
        status=JobStatus.RUNNING,
        progress=42,
        payload={"frame_id": 1},
        created_by_id=user_id,
    )
    session.add(job)
    session.commit()
    session.refresh(job)
    job_id = job.id
    session.close()

    response = client.get(f"/jobs/{job_id}", headers=token)

    assert response.status_code == 200
    body = response.json()
    assert body["status"] == "running"
    assert body["progress"] == 42
    assert body["job_type"] == "sam3_predict"
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd backend && uv run pytest tests/test_jobs.py -v`
Expected: FAIL with `404 Not Found` for `/jobs/1` (router not mounted) or `ModuleNotFoundError`.

- [ ] **Step 3: Write models.py**

```python
import enum
from datetime import datetime, timezone

from sqlalchemy import JSON, DateTime, Enum, ForeignKey, Integer, String
from sqlalchemy.orm import Mapped, mapped_column

from app.db import Base


class JobType(str, enum.Enum):
    SAM3_PREDICT = "sam3_predict"
    SAM3_TRACK = "sam3_track"


class JobStatus(str, enum.Enum):
    PENDING = "pending"
    RUNNING = "running"
    SUCCEEDED = "succeeded"
    FAILED = "failed"


class Job(Base):
    __tablename__ = "jobs"

    id: Mapped[int] = mapped_column(primary_key=True)
    job_type: Mapped[JobType] = mapped_column(Enum(JobType))
    status: Mapped[JobStatus] = mapped_column(Enum(JobStatus), default=JobStatus.PENDING)
    progress: Mapped[int] = mapped_column(Integer, default=0)
    payload: Mapped[dict] = mapped_column(JSON, default=dict)
    result_ref: Mapped[str | None] = mapped_column(String(500), nullable=True)
    error: Mapped[str | None] = mapped_column(String(2000), nullable=True)
    created_by_id: Mapped[int] = mapped_column(ForeignKey("users.id"))
    started_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    finished_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=lambda: datetime.now(timezone.utc)
    )
```

- [ ] **Step 4: Write schemas.py**

```python
from datetime import datetime

from pydantic import BaseModel, ConfigDict

from app.jobs.models import JobStatus, JobType


class JobRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    job_type: JobType
    status: JobStatus
    progress: int
    result_ref: str | None
    error: str | None
    created_by_id: int
    started_at: datetime | None
    finished_at: datetime | None
```

- [ ] **Step 5: Write router.py**

```python
from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session

from app.auth.dependencies import get_current_user
from app.db import get_session
from app.jobs.models import Job
from app.jobs.schemas import JobRead

router = APIRouter(prefix="/jobs", tags=["jobs"], dependencies=[Depends(get_current_user)])


@router.get("/{job_id}", response_model=JobRead)
def get_job(job_id: int, session: Session = Depends(get_session)) -> Job:
    job = session.get(Job, job_id)
    if job is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Job not found")
    return job
```

- [ ] **Step 6: Mount router, wire alembic import**

Modify `backend/app/main.py`, add:
```python
from app.jobs.router import router as jobs_router

app.include_router(jobs_router)
```

Modify `backend/alembic/env.py`, add below the `annotation_models` import:
```python
from app.jobs import models as jobs_models  # noqa: F401
```

- [ ] **Step 7: Generate and apply migration**

```bash
cd backend
uv run alembic revision --autogenerate -m "add jobs table"
uv run alembic upgrade head
```

- [ ] **Step 8: Run tests to verify they pass**

Run: `cd backend && uv run pytest tests/test_jobs.py -v`
Expected: PASS (all 3 tests).

- [ ] **Step 9: Commit**

```bash
git add backend/app/jobs backend/app/main.py backend/alembic backend/tests/test_jobs.py
git commit -m "Add jobs domain: Job model, GET /jobs/{id} read endpoint"
```

---

### Task 2: Celery app config in backend (enqueue side) + docker-compose wiring

**Files:**
- Create: `backend/app/celery_app.py`
- Modify: `backend/pyproject.toml` — add `celery` dependency
- Modify: `.env.example` — add Celery-related vars
- Create: `backend/tests/test_celery_app.py`

**Interfaces:**
- Consumes: `app.config.get_settings().redis_url` (Phase 1, already exists).
- Produces: `app.celery_app.celery_app` — a configured `Celery` instance the API process uses to enqueue tasks **by name** (`celery_app.send_task("sam3_predict", args=[...])`), never by importing task functions from the worker (the worker is a separate `uv` project — see Task 4 — and the API process must not depend on it).

- [ ] **Step 1: Add celery dependency**

```bash
cd /mnt/work-disk/Documents/Dev/endoscopy-platform/backend
uv add celery
```

- [ ] **Step 2: Write the failing test**

`backend/tests/test_celery_app.py`:
```python
from app.celery_app import celery_app


def test_celery_app_uses_redis_broker_from_settings():
    from app.config import get_settings

    settings = get_settings()
    assert celery_app.conf.broker_url == settings.redis_url


def test_celery_app_result_backend_is_redis():
    from app.config import get_settings

    settings = get_settings()
    assert celery_app.conf.result_backend == settings.redis_url
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && uv run pytest tests/test_celery_app.py -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'app.celery_app'`.

- [ ] **Step 3: Write celery_app.py**

```python
from celery import Celery

from app.config import get_settings

settings = get_settings()

celery_app = Celery(
    "endoscopy_platform",
    broker=settings.redis_url,
    backend=settings.redis_url,
)
celery_app.conf.task_serializer = "json"
celery_app.conf.result_serializer = "json"
celery_app.conf.accept_content = ["json"]
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && uv run pytest tests/test_celery_app.py -v`
Expected: PASS (requires `docker compose up -d` running so Redis is reachable — the test only checks config values, not connectivity, but `Celery(...)` construction itself doesn't connect eagerly, so this passes even without Redis up; still run with the stack up for consistency with the rest of the suite).

- [ ] **Step 5: Add ml-worker service and HF_TOKEN to docker-compose.yml and .env.example**

Modify `.env.example`, add:
```
CELERY_BROKER_URL=redis://localhost:6379/0
HF_TOKEN=your_huggingface_token_with_sam3_access
```

Modify `docker-compose.yml`, add a new service (the image is built in Task 5 — this step only wires the compose entry; `docker compose up ml-worker` will fail to build until Task 5 adds the Dockerfile, which is expected and fine at this point in the plan):
```yaml
  ml-worker:
    build:
      context: ./ml-worker
    environment:
      POSTGRES_USER: ${POSTGRES_USER}
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD}
      POSTGRES_DB: ${POSTGRES_DB}
      POSTGRES_HOST: postgres
      POSTGRES_PORT: 5432
      REDIS_URL: redis://redis:6379/0
      MINIO_ENDPOINT: minio:9000
      MINIO_ACCESS_KEY: ${MINIO_ACCESS_KEY}
      MINIO_SECRET_KEY: ${MINIO_SECRET_KEY}
      MINIO_BUCKET: ${MINIO_BUCKET}
      MINIO_SECURE: "false"
      HF_TOKEN: ${HF_TOKEN}
    depends_on:
      - postgres
      - redis
      - minio
    deploy:
      resources:
        reservations:
          devices:
            - driver: nvidia
              count: 1
              capabilities: [gpu]
```

Note: the `deploy.resources.reservations.devices` block is the Compose v2 way to request GPU passthrough with the `nvidia` runtime already confirmed available in this environment (`docker info` shows `Runtimes: ... nvidia`). No `runtime: nvidia` line is needed alongside `deploy.resources` on modern Docker Compose — using only one avoids the two mechanisms conflicting.

- [ ] **Step 6: Commit**

```bash
git add backend/app/celery_app.py backend/pyproject.toml backend/uv.lock backend/tests/test_celery_app.py .env.example docker-compose.yml
git commit -m "Add Celery app config (enqueue side) and ml-worker compose service stub"
```

---

### Task 3: Enqueue endpoints — `POST /jobs/sam3/predict`, `POST /jobs/sam3/track`

**Files:**
- Create: `backend/app/jobs/service.py`
- Modify: `backend/app/jobs/router.py` — add enqueue routes
- Modify: `backend/app/jobs/schemas.py` — add `Sam3PredictRequest`, `Sam3TrackRequest`
- Modify: `backend/tests/test_jobs.py` — add enqueue tests

**Interfaces:**
- Consumes: `app.celery_app.celery_app` (Task 2), `app.media.models.Frame`, `app.media.models.Sequence` (Phase 1).
- Produces: `app.jobs.service.enqueue_sam3_predict(session, frame_id, prompts, created_by) -> Job` and `app.jobs.service.enqueue_sam3_track(session, sequence_id, prompts, created_by) -> Job` — both create a `Job` row with `status=PENDING`, then call `celery_app.send_task(...)` with the job's id in the task payload, and return the `Job`. If the Celery broker is unreachable, the `Job` row still gets created with `status=PENDING`; the task simply never starts — this is acceptable for this plan since Task 6's worker owns retry/failure semantics, and the frontend polling in Task 8 will just show "pending" indefinitely, which is an honest reflection of "the enqueue succeeded but nothing is consuming it," not a bug this task needs to paper over.
- Produces: routes `POST /jobs/sam3/predict` (body: `frame_id: int, prompts: list[{"type": "point"|"box", "coords": list[float], "label": bool}]` → 201 + `JobRead`) and `POST /jobs/sam3/track` (body: `sequence_id: int, prompts: list[...]` → 201 + `JobRead`).

- [ ] **Step 1: Write the failing tests**

Append to `backend/tests/test_jobs.py`:
```python
from pathlib import Path


def _create_frame(token: str) -> int:
    headers = _auth_headers(token)
    fixture = Path(__file__).parent / "fixtures" / "tiny.mp4"
    with open(fixture, "rb") as f:
        upload = client.post(
            "/media/videos", files={"file": ("tiny.mp4", f, "video/mp4")},
            data={"title": "jobs test source"}, headers=headers,
        )
    video_id = upload.json()["id"]
    sequence = client.post(
        f"/media/videos/{video_id}/sequences", json={"start_time": 0, "duration": 2}, headers=headers
    ).json()
    frames = client.get(f"/media/sequences/{sequence['id']}/frames", headers=headers).json()
    return frames[0]["id"], sequence["id"]


def test_enqueue_sam3_predict_creates_pending_job():
    token = _register_and_login("jobs3@example.com")
    frame_id, _ = _create_frame(token)

    response = client.post(
        "/jobs/sam3/predict",
        json={"frame_id": frame_id, "prompts": [{"type": "point", "coords": [0.5, 0.5], "label": True}]},
        headers=_auth_headers(token),
    )

    assert response.status_code == 201
    body = response.json()
    assert body["job_type"] == "sam3_predict"
    assert body["status"] == "pending"


def test_enqueue_sam3_track_creates_pending_job():
    token = _register_and_login("jobs4@example.com")
    _, sequence_id = _create_frame(token)

    response = client.post(
        "/jobs/sam3/track",
        json={"sequence_id": sequence_id, "prompts": [{"type": "box", "coords": [0.1, 0.1, 0.3, 0.3], "label": True}]},
        headers=_auth_headers(token),
    )

    assert response.status_code == 201
    body = response.json()
    assert body["job_type"] == "sam3_track"
    assert body["status"] == "pending"


def test_enqueue_requires_auth():
    response = client.post("/jobs/sam3/predict", json={"frame_id": 1, "prompts": []})
    assert response.status_code == 401
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd backend && uv run pytest tests/test_jobs.py -v -k enqueue`
Expected: FAIL with `404 Not Found` (routes don't exist yet).

- [ ] **Step 3: Add prompt/request schemas to schemas.py**

Append to `backend/app/jobs/schemas.py`:
```python
from typing import Literal


class PromptIn(BaseModel):
    type: Literal["point", "box"]
    coords: list[float]
    label: bool = True


class Sam3PredictRequest(BaseModel):
    frame_id: int
    prompts: list[PromptIn]


class Sam3TrackRequest(BaseModel):
    sequence_id: int
    prompts: list[PromptIn]
```

- [ ] **Step 4: Write service.py**

```python
from sqlalchemy.orm import Session

from app.auth.models import User
from app.celery_app import celery_app
from app.jobs.models import Job, JobStatus, JobType


def enqueue_sam3_predict(session: Session, frame_id: int, prompts: list[dict], created_by: User) -> Job:
    job = Job(
        job_type=JobType.SAM3_PREDICT,
        status=JobStatus.PENDING,
        payload={"frame_id": frame_id, "prompts": prompts},
        created_by_id=created_by.id,
    )
    session.add(job)
    session.commit()
    session.refresh(job)

    celery_app.send_task("sam3_predict", args=[job.id])
    return job


def enqueue_sam3_track(session: Session, sequence_id: int, prompts: list[dict], created_by: User) -> Job:
    job = Job(
        job_type=JobType.SAM3_TRACK,
        status=JobStatus.PENDING,
        payload={"sequence_id": sequence_id, "prompts": prompts},
        created_by_id=created_by.id,
    )
    session.add(job)
    session.commit()
    session.refresh(job)

    celery_app.send_task("sam3_track", args=[job.id])
    return job
```

- [ ] **Step 5: Add enqueue routes to router.py**

Modify `backend/app/jobs/router.py`:
```python
from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session

from app.auth.dependencies import get_current_user
from app.auth.models import User
from app.db import get_session
from app.jobs.models import Job
from app.jobs.schemas import JobRead, Sam3PredictRequest, Sam3TrackRequest
from app.jobs.service import enqueue_sam3_predict, enqueue_sam3_track

router = APIRouter(prefix="/jobs", tags=["jobs"], dependencies=[Depends(get_current_user)])


@router.post("/sam3/predict", response_model=JobRead, status_code=status.HTTP_201_CREATED)
def create_sam3_predict_job(
    payload: Sam3PredictRequest,
    current_user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
) -> Job:
    prompts = [p.model_dump() for p in payload.prompts]
    return enqueue_sam3_predict(session, payload.frame_id, prompts, current_user)


@router.post("/sam3/track", response_model=JobRead, status_code=status.HTTP_201_CREATED)
def create_sam3_track_job(
    payload: Sam3TrackRequest,
    current_user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
) -> Job:
    prompts = [p.model_dump() for p in payload.prompts]
    return enqueue_sam3_track(session, payload.sequence_id, prompts, current_user)


@router.get("/{job_id}", response_model=JobRead)
def get_job(job_id: int, session: Session = Depends(get_session)) -> Job:
    job = session.get(Job, job_id)
    if job is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Job not found")
    return job
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `cd backend && uv run pytest tests/test_jobs.py -v`
Expected: PASS (all 6 tests). Requires `docker compose up -d` (Redis reachable for `send_task` not to raise — `send_task` connects lazily and will raise a connection error if Redis is down, so the enqueue tests will fail without the stack running; this is intentional, matching how every other Phase 1 test suite requires the dev stack).

- [ ] **Step 7: Commit**

```bash
git add backend/app/jobs backend/tests/test_jobs.py
git commit -m "Add SAM-3 job enqueue endpoints: predict and track"
```

---

### Task 4: `ml-worker` project scaffold — own settings, db, storage

**Files:**
- Create: `ml-worker/pyproject.toml`
- Create: `ml-worker/app/__init__.py`
- Create: `ml-worker/app/config.py`
- Create: `ml-worker/app/db.py`
- Create: `ml-worker/app/storage.py`
- Create: `ml-worker/app/models.py`
- Create: `ml-worker/tests/conftest.py`
- Create: `ml-worker/tests/test_config.py`
- Create: `ml-worker/tests/test_storage.py`

**Interfaces:**
- Produces: `ml_worker.app.config.WorkerSettings` (pydantic-settings, same field shape as `backend/app/config.Settings` minus JWT fields, plus `hf_token: str`).
- Produces: `ml_worker.app.db.SessionLocal`, `ml_worker.app.db.Base` — a separate SQLAlchemy setup pointed at the same Postgres database as the backend, but the worker only ever touches its own three tables (`jobs`, `frames`, `annotations` — read/write) and never runs its own migrations; Alembic migrations remain owned exclusively by `backend/`.
- Produces: `ml_worker.app.storage.StorageService` — byte-for-byte the same implementation as `backend/app/storage.StorageService` (duplicated, not imported, per this plan's Architecture section).
- Produces: `ml_worker.app.models.Job`, `ml_worker.app.models.Frame`, `ml_worker.app.models.Annotation` — minimal re-declarations of the backend's tables (same `__tablename__`, only the columns this worker actually reads/writes) mapped onto the existing tables Task 1/Phase 1 created.

This task has no new application logic (it's a settings/DB/storage scaffold, directly parallel to Phase 1's Task 2+3) — tests verify the scaffold is wired correctly, not novel behavior.

- [ ] **Step 1: Initialize the ml-worker uv project**

```bash
cd /mnt/work-disk/Documents/Dev/endoscopy-platform
mkdir -p ml-worker/app ml-worker/tests
cd ml-worker
uv init --name endoscopy-platform-ml-worker --python 3.12 --no-readme
uv add celery "sqlalchemy>=2.0" psycopg2-binary pydantic-settings boto3 huggingface-hub
uv add --dev pytest
```

- [ ] **Step 2: Write the failing config test**

`ml-worker/tests/test_config.py`:
```python
import os

import pytest

from app.config import WorkerSettings


def test_settings_reads_database_url_components(monkeypatch):
    monkeypatch.setenv("POSTGRES_USER", "endoscopy")
    monkeypatch.setenv("POSTGRES_PASSWORD", "pw")
    monkeypatch.setenv("POSTGRES_DB", "endoscopy")
    monkeypatch.setenv("POSTGRES_HOST", "postgres")
    monkeypatch.setenv("REDIS_URL", "redis://redis:6379/0")
    monkeypatch.setenv("MINIO_ENDPOINT", "minio:9000")
    monkeypatch.setenv("MINIO_ACCESS_KEY", "key")
    monkeypatch.setenv("MINIO_SECRET_KEY", "secret")
    monkeypatch.setenv("MINIO_BUCKET", "endoscopy-media")
    monkeypatch.setenv("HF_TOKEN", "hf_test_token")

    settings = WorkerSettings()

    assert settings.database_url == "postgresql+psycopg2://endoscopy:pw@postgres:5432/endoscopy"
    assert settings.redis_url == "redis://redis:6379/0"
    assert settings.hf_token == "hf_test_token"
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd ml-worker && uv run pytest tests/test_config.py -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'app.config'`.

- [ ] **Step 4: Write config.py**

```python
from functools import lru_cache

from pydantic_settings import BaseSettings, SettingsConfigDict


class WorkerSettings(BaseSettings):
    model_config = SettingsConfigDict(extra="ignore")

    postgres_user: str
    postgres_password: str
    postgres_db: str
    postgres_host: str = "localhost"
    postgres_port: int = 5432

    redis_url: str = "redis://localhost:6379/0"

    minio_endpoint: str
    minio_access_key: str
    minio_secret_key: str
    minio_bucket: str
    minio_secure: bool = False

    hf_token: str

    @property
    def database_url(self) -> str:
        return (
            f"postgresql+psycopg2://{self.postgres_user}:{self.postgres_password}"
            f"@{self.postgres_host}:{self.postgres_port}/{self.postgres_db}"
        )


@lru_cache
def get_worker_settings() -> WorkerSettings:
    return WorkerSettings()
```

Note: unlike `backend/app/config.Settings`, this reads from real process environment variables (no `env_file`) — the worker always runs inside its own Docker container (Task 2's compose service), where env vars are injected directly by Compose, not from a relative `.env` file path that would be wrong inside the container's filesystem.

- [ ] **Step 5: Run test to verify it passes**

Run: `cd ml-worker && uv run pytest tests/test_config.py -v`
Expected: PASS

- [ ] **Step 6: Write db.py**

```python
from collections.abc import Generator

from sqlalchemy import create_engine
from sqlalchemy.orm import DeclarativeBase, Session, sessionmaker

from app.config import get_worker_settings

settings = get_worker_settings()
engine = create_engine(settings.database_url)
SessionLocal = sessionmaker(bind=engine, autoflush=False, autocommit=False)


class Base(DeclarativeBase):
    pass


def get_session() -> Generator[Session, None, None]:
    session = SessionLocal()
    try:
        yield session
    finally:
        session.close()
```

- [ ] **Step 7: Write storage.py**

```python
from functools import lru_cache

import boto3
from botocore.client import Config
from botocore.exceptions import ClientError

from app.config import WorkerSettings, get_worker_settings


class StorageService:
    def __init__(self, settings: WorkerSettings):
        self._bucket = settings.minio_bucket
        protocol = "https" if settings.minio_secure else "http"
        self._client = boto3.client(
            "s3",
            endpoint_url=f"{protocol}://{settings.minio_endpoint}",
            aws_access_key_id=settings.minio_access_key,
            aws_secret_access_key=settings.minio_secret_key,
            config=Config(signature_version="s3v4"),
        )

    def ensure_bucket(self) -> None:
        try:
            self._client.head_bucket(Bucket=self._bucket)
        except ClientError:
            self._client.create_bucket(Bucket=self._bucket)

    def upload(self, key: str, data: bytes, content_type: str) -> None:
        self._client.put_object(
            Bucket=self._bucket, Key=key, Body=data, ContentType=content_type
        )

    def download(self, key: str) -> bytes:
        response = self._client.get_object(Bucket=self._bucket, Key=key)
        return response["Body"].read()


@lru_cache
def get_storage_service() -> StorageService:
    service = StorageService(get_worker_settings())
    service.ensure_bucket()
    return service
```

- [ ] **Step 8: Write the failing storage test**

`ml-worker/tests/test_storage.py`:
```python
import os

import pytest

os.environ.setdefault("POSTGRES_USER", "endoscopy")
os.environ.setdefault("POSTGRES_PASSWORD", "endoscopy_dev_password")
os.environ.setdefault("POSTGRES_DB", "endoscopy")
os.environ.setdefault("POSTGRES_HOST", "localhost")
os.environ.setdefault("MINIO_ENDPOINT", "localhost:9000")
os.environ.setdefault("MINIO_ACCESS_KEY", "endoscopy_dev")
os.environ.setdefault("MINIO_SECRET_KEY", "endoscopy_dev_secret")
os.environ.setdefault("MINIO_BUCKET", "endoscopy-media")
os.environ.setdefault("HF_TOKEN", "unused-in-this-test")

from app.storage import StorageService
from app.config import get_worker_settings


@pytest.fixture
def storage():
    service = StorageService(get_worker_settings())
    service.ensure_bucket()
    return service


def test_worker_storage_roundtrips_bytes(storage):
    key = "test/worker-roundtrip.bin"
    storage.upload(key, b"worker hello", content_type="application/octet-stream")

    result = storage.download(key)

    assert result == b"worker hello"
```

This test runs against the same MinIO instance the backend uses (`docker compose up -d` from repo root) — the worker and API share one MinIO bucket, they don't get separate storage.

- [ ] **Step 9: Run test to verify it passes**

Run: `cd ml-worker && uv run pytest tests/test_storage.py -v`
Expected: PASS (requires `docker compose up -d` running from repo root).

- [ ] **Step 10: Write models.py**

```python
import enum
from datetime import datetime

from sqlalchemy import JSON, DateTime, Enum, ForeignKey, Integer, String
from sqlalchemy.orm import Mapped, mapped_column

from app.db import Base


class JobType(str, enum.Enum):
    SAM3_PREDICT = "sam3_predict"
    SAM3_TRACK = "sam3_track"


class JobStatus(str, enum.Enum):
    PENDING = "pending"
    RUNNING = "running"
    SUCCEEDED = "succeeded"
    FAILED = "failed"


class Job(Base):
    __tablename__ = "jobs"

    id: Mapped[int] = mapped_column(primary_key=True)
    job_type: Mapped[JobType] = mapped_column(Enum(JobType))
    status: Mapped[JobStatus] = mapped_column(Enum(JobStatus))
    progress: Mapped[int] = mapped_column(Integer)
    payload: Mapped[dict] = mapped_column(JSON)
    result_ref: Mapped[str | None] = mapped_column(String(500), nullable=True)
    error: Mapped[str | None] = mapped_column(String(2000), nullable=True)
    created_by_id: Mapped[int] = mapped_column(Integer)
    started_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    finished_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)


class Frame(Base):
    __tablename__ = "frames"

    id: Mapped[int] = mapped_column(primary_key=True)
    sequence_id: Mapped[int] = mapped_column(Integer)
    storage_key: Mapped[str] = mapped_column(String(500))
    frame_index: Mapped[int] = mapped_column(Integer)
    width: Mapped[int] = mapped_column(Integer)
    height: Mapped[int] = mapped_column(Integer)


class Annotation(Base):
    __tablename__ = "annotations"

    id: Mapped[int] = mapped_column(primary_key=True)
    frame_id: Mapped[int] = mapped_column(ForeignKey("frames.id"))
    label_id: Mapped[int | None] = mapped_column(ForeignKey("labels.id"), nullable=True)
    taxonomy_version: Mapped[int | None] = mapped_column(Integer, nullable=True)
    annotation_type: Mapped[str] = mapped_column(String(20))
    payload: Mapped[dict] = mapped_column(JSON)
    status: Mapped[str] = mapped_column(String(20))
    created_by_id: Mapped[int] = mapped_column(Integer)
    storage_key: Mapped[str | None] = mapped_column(String(500), nullable=True)
```

Note: `Annotation.label_id`/`taxonomy_version` are nullable here even though the backend's own `Annotation` model (Phase 1) declares them non-nullable — a SAM-3 mask produced from a raw point/box prompt has no `Label` until a human annotator assigns one during review, unlike the classification flow where the label is chosen up front. This task does not change the backend's `Annotation` table or its non-null constraint; Task 6 explicitly writes a real `label_id`/`taxonomy_version` only when a target label is known (see Task 6's payload contract), and leaves them absent (whichever the backend schema allows) otherwise. If the backend's existing NOT NULL constraint on those two columns blocks a labelless mask row, Task 6 must surface that as a NEEDS_CONTEXT/BLOCKED report rather than silently loosening Phase 1's schema — this is flagged explicitly so the implementer checks it against the real `backend/app/annotation/models.py` state before writing Task 6's insert code, not just this plan's paraphrase of it.

- [ ] **Step 11: Commit**

```bash
git add ml-worker/pyproject.toml ml-worker/uv.lock ml-worker/app ml-worker/tests
git commit -m "Scaffold ml-worker project: settings, DB session, StorageService"
```

---

### Task 5: `ml-worker` Docker image with GPU support

**Files:**
- Create: `ml-worker/Dockerfile`
- Modify: `docker-compose.yml` — GPU service block already added in Task 2; this task makes it actually buildable

**Interfaces:**
- Produces: a Docker image that installs PyTorch with CUDA support, `sam3` from its GitHub source, and runs `celery -A app.celery_app worker` as its entrypoint.

- [ ] **Step 1: Write the Dockerfile**

`ml-worker/Dockerfile`:
```dockerfile
FROM nvidia/cuda:12.6.0-runtime-ubuntu22.04

RUN apt-get update && apt-get install -y --no-install-recommends \
    python3.12 python3.12-venv python3-pip git curl \
    && rm -rf /var/lib/apt/lists/*

RUN curl -LsSf https://astral.sh/uv/install.sh | sh
ENV PATH="/root/.local/bin:${PATH}"

WORKDIR /app
COPY pyproject.toml uv.lock ./
RUN uv sync --frozen --no-install-project

RUN uv pip install torch --index-url https://download.pytorch.org/whl/cu126
RUN uv pip install "sam3 @ git+https://github.com/facebookresearch/sam3.git"

COPY app ./app

CMD ["uv", "run", "celery", "-A", "app.celery_app", "worker", "--loglevel=info"]
```

Note on the base image tag: `nvidia/cuda:12.6.0-runtime-ubuntu22.04` matches the CUDA 12.6+ floor SAM-3's own documentation states, and is compatible with this environment's driver (`nvidia-smi` reports CUDA 13.0, which is backward-compatible with containers built against 12.6 — NVIDIA's driver/toolkit compatibility guarantees run newer-driver-with-older-toolkit). If `nvidia/cuda:12.6.0-runtime-ubuntu22.04` is no longer published on Docker Hub by the time this task executes, use the newest available `12.6.x` or `12.8.x` runtime-ubuntu22.04 tag — check `https://hub.docker.com/r/nvidia/cuda/tags` and record whichever tag was actually used in the commit message, since image tags for base images are exactly the kind of detail that goes stale between plan-writing and execution.

- [ ] **Step 2: Build and verify the image**

```bash
cd /mnt/work-disk/Documents/Dev/endoscopy-platform
docker compose build ml-worker
```

Expected: image builds successfully (this step has no automated test — it's infrastructure, verified by successful build output, matching how Phase 1's Task 1 docker-compose step had no test either).

- [ ] **Step 3: Verify GPU is visible inside the container**

```bash
docker compose run --rm ml-worker python3 -c "import torch; print(torch.cuda.is_available(), torch.cuda.get_device_name(0))"
```

Expected output: `True NVIDIA GeForce RTX 2070` (or whatever GPU name `nvidia-smi` reports on the host).

- [ ] **Step 4: Commit**

```bash
git add ml-worker/Dockerfile
git commit -m "Add ml-worker Dockerfile with CUDA base image and GPU verification"
```

---

### Task 6: SAM-3 adapter — `predict()` for point/box prompts on a single frame

**Files:**
- Create: `ml-worker/app/sam3_adapter.py`
- Create: `ml-worker/tests/conftest.py`
- Create: `ml-worker/tests/test_sam3_adapter.py`

**Interfaces:**
- Consumes: `sam3.model_builder.build_sam3_image_model`, `sam3.model.sam3_image_processor.Sam3Processor` (external package, installed in Task 5).
- Produces: `ml_worker.app.sam3_adapter.Sam3Adapter` with `predict(frame_bytes: bytes, prompts: list[dict]) -> MaskResult` where `MaskResult` is a `dataclass(mask_png: bytes, score: float)`. `prompts` items match the API contract from Task 3: `{"type": "point"|"box", "coords": [...], "label": bool}`.

**Critical implementation note on SAM-3's real API** (verified directly against `facebookresearch/sam3`'s source on 2026-07-22, not the README's text-prompt-only example): `Sam3Processor` has no separate "point" method — points and boxes both go through `add_geometric_prompt(box: list, label: bool, state: dict)`, where `box` is `[center_x, center_y, width, height]` normalized to `[0, 1]`. A point prompt is a zero-area box: `[x, y, 0.0, 0.0]`. This adapter's `predict()` must convert this plan's `{"type": "point", "coords": [x, y]}` into that `[x, y, 0, 0]` form, and `{"type": "box", "coords": [x1, y1, x2, y2]}` (top-left/bottom-right, this plan's own convention, matching how `Annotation.payload` stores bbox coordinates elsewhere in the codebase per the design spec) into SAM-3's `[center_x, center_y, width, height]` form.

- [ ] **Step 1: Write conftest.py — GPU/weights availability guard**

`ml-worker/tests/conftest.py`:
```python
import os

import pytest


def pytest_collection_modifyitems(config, items):
    if os.environ.get("SAM3_WEIGHTS_AVAILABLE") == "1":
        return
    skip_gpu = pytest.mark.skip(
        reason="SAM3_WEIGHTS_AVAILABLE=1 not set — skipping tests that need real SAM-3 weights/GPU"
    )
    for item in items:
        if "requires_sam3_weights" in item.keywords:
            item.add_marker(skip_gpu)
```

This is the mechanism referenced in the plan's Global Constraints: any environment without a GPU or without HF access to the gated SAM-3 checkpoint gets these tests skipped, not failed. This environment (confirmed via `nvidia-smi` and the human's confirmation of already having HF access) runs them for real.

- [ ] **Step 2: Write the failing test**

`ml-worker/tests/test_sam3_adapter.py`:
```python
import os
from pathlib import Path

import pytest

os.environ.setdefault("HF_TOKEN", os.environ.get("HF_TOKEN", ""))

from app.sam3_adapter import Sam3Adapter


@pytest.mark.requires_sam3_weights
def test_predict_with_point_prompt_returns_mask():
    adapter = Sam3Adapter()
    fixture_path = Path(__file__).parent / "fixtures" / "sample_frame.png"
    frame_bytes = fixture_path.read_bytes()

    result = adapter.predict(
        frame_bytes,
        prompts=[{"type": "point", "coords": [0.5, 0.5], "label": True}],
    )

    assert isinstance(result.mask_png, bytes)
    assert len(result.mask_png) > 0
    assert 0.0 <= result.score <= 1.0


@pytest.mark.requires_sam3_weights
def test_predict_with_box_prompt_returns_mask():
    adapter = Sam3Adapter()
    fixture_path = Path(__file__).parent / "fixtures" / "sample_frame.png"
    frame_bytes = fixture_path.read_bytes()

    result = adapter.predict(
        frame_bytes,
        prompts=[{"type": "box", "coords": [0.2, 0.2, 0.6, 0.6], "label": True}],
    )

    assert isinstance(result.mask_png, bytes)
    assert len(result.mask_png) > 0


def test_point_prompt_converts_to_zero_area_box():
    from app.sam3_adapter import _prompt_to_geometric_box

    box, label = _prompt_to_geometric_box({"type": "point", "coords": [0.5, 0.3], "label": True})

    assert box == [0.5, 0.3, 0.0, 0.0]
    assert label is True


def test_box_prompt_converts_corners_to_center_width_height():
    from app.sam3_adapter import _prompt_to_geometric_box

    box, label = _prompt_to_geometric_box({"type": "box", "coords": [0.2, 0.2, 0.6, 0.6], "label": False})

    assert box == pytest.approx([0.4, 0.4, 0.4, 0.4])
    assert label is False
```

Register the custom marker to avoid a pytest warning — add to `ml-worker/pyproject.toml` under `[tool.pytest.ini_options]`:
```toml
[tool.pytest.ini_options]
markers = ["requires_sam3_weights: needs real SAM-3 weights and GPU, see conftest.py"]
```

Create the fixture: a real small PNG is needed. Generate it with:
```bash
cd /mnt/work-disk/Documents/Dev/endoscopy-platform/ml-worker
mkdir -p tests/fixtures
uv run python -c "
from PIL import Image
img = Image.new('RGB', (256, 256), color=(80, 40, 40))
img.save('tests/fixtures/sample_frame.png')
"
```
(This requires `Pillow` — add it: `uv add --dev pillow`.)

- [ ] **Step 3: Run tests to verify they fail**

Run: `cd ml-worker && uv run pytest tests/test_sam3_adapter.py -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'app.sam3_adapter'`. The two `requires_sam3_weights` tests will show as `SKIPPED` if `SAM3_WEIGHTS_AVAILABLE` isn't set yet, or `ERROR` (import failure) if it is — either way, confirm the two conversion-only tests (`test_point_prompt_converts...`, `test_box_prompt_converts...`) fail with the expected import error, since those don't need real weights and are the tests that must go green first.

- [ ] **Step 4: Write sam3_adapter.py**

```python
import io
from dataclasses import dataclass

import numpy as np
from PIL import Image

from sam3.model_builder import build_sam3_image_model
from sam3.model.sam3_image_processor import Sam3Processor


@dataclass
class MaskResult:
    mask_png: bytes
    score: float


def _prompt_to_geometric_box(prompt: dict) -> tuple[list[float], bool]:
    """Converts this project's point/box prompt shape into SAM-3's
    [center_x, center_y, width, height] normalized box format.
    A point becomes a zero-area box at that coordinate."""
    if prompt["type"] == "point":
        x, y = prompt["coords"]
        return [x, y, 0.0, 0.0], prompt["label"]
    if prompt["type"] == "box":
        x1, y1, x2, y2 = prompt["coords"]
        center_x = (x1 + x2) / 2
        center_y = (y1 + y2) / 2
        width = x2 - x1
        height = y2 - y1
        return [center_x, center_y, width, height], prompt["label"]
    raise ValueError(f"Unknown prompt type: {prompt['type']!r}")


class Sam3Adapter:
    def __init__(self) -> None:
        self._model = build_sam3_image_model()
        self._processor = Sam3Processor(self._model)

    def predict(self, frame_bytes: bytes, prompts: list[dict]) -> MaskResult:
        image = Image.open(io.BytesIO(frame_bytes)).convert("RGB")
        state = self._processor.set_image(image)

        for prompt in prompts:
            box, label = _prompt_to_geometric_box(prompt)
            state = self._processor.add_geometric_prompt(box=box, label=label, state=state)

        masks = state["masks"]
        scores = state["scores"]
        if len(masks) == 0:
            raise ValueError("SAM-3 returned no masks above the confidence threshold for the given prompts")

        best_index = int(scores.argmax())
        mask_array = masks[best_index].squeeze().cpu().numpy().astype(np.uint8) * 255

        mask_image = Image.fromarray(mask_array, mode="L")
        buffer = io.BytesIO()
        mask_image.save(buffer, format="PNG")

        return MaskResult(mask_png=buffer.getvalue(), score=float(scores[best_index]))
```

- [ ] **Step 5: Run the conversion-only tests to verify they pass**

Run: `cd ml-worker && uv run pytest tests/test_sam3_adapter.py -v -k "converts"`
Expected: PASS (2 tests) — these don't touch the GPU or real weights.

- [ ] **Step 6: Set up Hugging Face access and run the GPU tests**

```bash
cd /mnt/work-disk/Documents/Dev/endoscopy-platform/ml-worker
export HF_TOKEN=<the token the human already has approved SAM-3 access with>
uv run python -c "from huggingface_hub import login; login(token='$HF_TOKEN')"
SAM3_WEIGHTS_AVAILABLE=1 uv run pytest tests/test_sam3_adapter.py -v
```

Expected: PASS (all 4 tests). First run will download the SAM-3 checkpoint from Hugging Face (multi-GB, several minutes depending on connection) — this is expected and not a hang. If `HF_TOKEN` lacks approved SAM-3 access, this fails with an authentication/403 error from `huggingface_hub` — that's a real environment gap to report as BLOCKED, not something to work around by mocking the model.

- [ ] **Step 7: Commit**

```bash
git add ml-worker/app/sam3_adapter.py ml-worker/tests/test_sam3_adapter.py ml-worker/tests/conftest.py ml-worker/tests/fixtures ml-worker/pyproject.toml ml-worker/uv.lock
git commit -m "Add Sam3Adapter: point/box prompt to mask prediction"
```

---

### Task 7: SAM-3 adapter — `track()` across a sequence's frames

**Files:**
- Modify: `ml-worker/app/sam3_adapter.py` — add `track()`
- Modify: `ml-worker/tests/test_sam3_adapter.py` — add track tests

**Interfaces:**
- Consumes: `sam3.model_builder.build_sam3_video_predictor` (external package).
- Produces: `Sam3Adapter.track(frame_bytes_list: list[bytes], prompts: list[dict]) -> list[MaskResult]` — one `MaskResult` per input frame, propagating the initial prompt(s) (applied to the first frame) through the sequence via SAM-3's video predictor session.

**Implementation note on the real video predictor API** (verified against `facebookresearch/sam3` source): `build_sam3_video_predictor()` returns an object whose `handle_request(dict)` method drives a session state machine — `{"type": "start_session", "resource_path": ...}` then `{"type": "add_prompt", "session_id": ..., "frame_index": 0, ...}`. The public example only shows `resource_path` pointing at a video file on disk, not a list of in-memory frame bytes — this task's `track()` must write the frame bytes to a temporary local video/image-sequence path before calling `start_session`, mirroring the same sanctioned `tempfile.NamedTemporaryFile` pattern Phase 1's `backend/app/media/service.py` already uses for OpenCV (transient local file for a library that needs a real path; MinIO/Postgres remain the actual source of truth — nothing here is stored on the worker's local disk beyond the temp file's lifetime).

- [ ] **Step 1: Write the failing test**

Append to `ml-worker/tests/test_sam3_adapter.py`:
```python
@pytest.mark.requires_sam3_weights
def test_track_propagates_prompt_across_frames():
    adapter = Sam3Adapter()
    fixture_path = Path(__file__).parent / "fixtures" / "sample_frame.png"
    frame_bytes = fixture_path.read_bytes()
    frames = [frame_bytes, frame_bytes, frame_bytes]  # 3 identical frames is enough to prove propagation runs

    results = adapter.track(
        frames,
        prompts=[{"type": "point", "coords": [0.5, 0.5], "label": True}],
    )

    assert len(results) == 3
    for result in results:
        assert isinstance(result.mask_png, bytes)
        assert len(result.mask_png) > 0
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd ml-worker && SAM3_WEIGHTS_AVAILABLE=1 uv run pytest tests/test_sam3_adapter.py -v -k track`
Expected: FAIL with `AttributeError: 'Sam3Adapter' object has no attribute 'track'`.

- [ ] **Step 3: Add track() to sam3_adapter.py**

Modify `ml-worker/app/sam3_adapter.py`, add the import and method:
```python
import tempfile
from pathlib import Path

from sam3.model_builder import build_sam3_video_predictor
```

```python
class Sam3Adapter:
    def __init__(self) -> None:
        self._model = build_sam3_image_model()
        self._processor = Sam3Processor(self._model)
        self._video_predictor = None  # lazy: only load the (larger) video model if track() is actually used

    def _get_video_predictor(self):
        if self._video_predictor is None:
            self._video_predictor = build_sam3_video_predictor()
        return self._video_predictor

    def predict(self, frame_bytes: bytes, prompts: list[dict]) -> MaskResult:
        ...  # unchanged from Task 6

    def track(self, frames: list[bytes], prompts: list[dict]) -> list[MaskResult]:
        video_predictor = self._get_video_predictor()

        with tempfile.TemporaryDirectory() as tmp_dir:
            frame_paths = []
            for index, frame_data in enumerate(frames):
                frame_path = Path(tmp_dir) / f"{index:05d}.png"
                frame_path.write_bytes(frame_data)
                frame_paths.append(frame_path)

            response = video_predictor.handle_request({
                "type": "start_session",
                "resource_path": tmp_dir,
            })
            session_id = response["session_id"]

            for prompt in prompts:
                box, label = _prompt_to_geometric_box(prompt)
                response = video_predictor.handle_request({
                    "type": "add_prompt",
                    "session_id": session_id,
                    "frame_index": 0,
                    "box": box,
                    "label": label,
                })

            outputs = response["outputs"]
            results = []
            for frame_output in outputs:
                mask_array = (frame_output["mask"] * 255).astype(np.uint8)
                mask_image = Image.fromarray(mask_array, mode="L")
                buffer = io.BytesIO()
                mask_image.save(buffer, format="PNG")
                results.append(MaskResult(mask_png=buffer.getvalue(), score=float(frame_output.get("score", 1.0))))

            video_predictor.handle_request({"type": "close_session", "session_id": session_id})
            return results
```

**Flag for the implementer:** the exact shape of `response["outputs"]` per frame (key names like `"mask"`/`"score"`) is inferred from the video predictor's `add_prompt` response pattern shown in the repository's example notebook reference, not confirmed against the notebook's actual cell output (the notebook file itself returned 404 when fetched during this plan's research — only the README's abbreviated snippet was available). Before trusting this task's `track()` body verbatim, run Step 6's real GPU test with a debugger or a `print(response)` inserted temporarily, inspect the actual key names in one real `handle_request` response, and adjust the field names in this method to match — do not guess further or ship this against an unverified response shape. This is exactly the kind of gap the plan's TDD step (Step 2, run against real weights) exists to catch.

- [ ] **Step 4: Run test to verify it passes, adjusting field names per the flag above if needed**

Run: `cd ml-worker && SAM3_WEIGHTS_AVAILABLE=1 uv run pytest tests/test_sam3_adapter.py -v`
Expected: PASS (all 6 tests, once the response field names are confirmed/corrected per Step 3's flag).

- [ ] **Step 5: Commit**

```bash
git add ml-worker/app/sam3_adapter.py ml-worker/tests/test_sam3_adapter.py
git commit -m "Add Sam3Adapter.track(): mask propagation across a sequence"
```

---

### Task 8: Celery tasks — wire adapter to Job/Annotation rows with progress updates

**Files:**
- Create: `ml-worker/app/tasks.py`
- Create: `ml-worker/app/celery_app.py`
- Create: `ml-worker/tests/test_tasks.py`

**Interfaces:**
- Consumes: `ml_worker.app.sam3_adapter.Sam3Adapter` (Task 6/7), `ml_worker.app.db.SessionLocal`, `ml_worker.app.storage.get_storage_service`, `ml_worker.app.models.{Job, Frame, Annotation}`.
- Produces: Celery tasks registered as `"sam3_predict"` and `"sam3_track"` (matching the names `backend/app/jobs/service.py`'s `send_task()` calls use — this is the load-bearing contract between the two separate projects: task names are the only coupling, and both sides must agree on them without importing each other's code).

This task uses a stubbed `Sam3Adapter` in its own tests (constructor-injected) rather than the real GPU model — Task 6/7 already proved the adapter itself works against real weights; this task's job is to prove the *orchestration* (progress updates, error handling, DB writes) is correct, which doesn't need a GPU to verify.

- [ ] **Step 1: Write celery_app.py**

```python
from celery import Celery

from app.config import get_worker_settings

settings = get_worker_settings()

celery_app = Celery(
    "endoscopy_platform_worker",
    broker=settings.redis_url,
    backend=settings.redis_url,
)
celery_app.conf.task_serializer = "json"
celery_app.conf.result_serializer = "json"
celery_app.conf.accept_content = ["json"]
```

- [ ] **Step 2: Write the failing test**

`ml-worker/tests/test_tasks.py`:
```python
import os
from dataclasses import dataclass
from unittest.mock import MagicMock

os.environ.setdefault("POSTGRES_USER", "endoscopy")
os.environ.setdefault("POSTGRES_PASSWORD", "endoscopy_dev_password")
os.environ.setdefault("POSTGRES_DB", "endoscopy")
os.environ.setdefault("POSTGRES_HOST", "localhost")
os.environ.setdefault("MINIO_ENDPOINT", "localhost:9000")
os.environ.setdefault("MINIO_ACCESS_KEY", "endoscopy_dev")
os.environ.setdefault("MINIO_SECRET_KEY", "endoscopy_dev_secret")
os.environ.setdefault("MINIO_BUCKET", "endoscopy-media")
os.environ.setdefault("HF_TOKEN", "unused-in-this-test")

from app.db import SessionLocal
from app.models import Frame, Job, JobStatus, JobType
from app.sam3_adapter import MaskResult
from app.storage import get_storage_service
from app.tasks import run_sam3_predict


def _make_pending_job_with_frame(session) -> tuple[int, int]:
    from app.models import Base
    from app.db import engine

    storage = get_storage_service()
    storage.upload("test/task-frame.png", b"fake png bytes", content_type="image/png")

    frame = Frame(sequence_id=1, storage_key="test/task-frame.png", frame_index=0, width=64, height=48)
    session.add(frame)
    session.commit()
    session.refresh(frame)

    job = Job(
        job_type=JobType.SAM3_PREDICT,
        status=JobStatus.PENDING,
        progress=0,
        payload={"frame_id": frame.id, "prompts": [{"type": "point", "coords": [0.5, 0.5], "label": True}]},
        created_by_id=1,
    )
    session.add(job)
    session.commit()
    session.refresh(job)
    return job.id, frame.id


def test_run_sam3_predict_marks_job_succeeded_and_creates_mask_annotation():
    session = SessionLocal()
    job_id, frame_id = _make_pending_job_with_frame(session)
    session.close()

    fake_adapter = MagicMock()
    fake_adapter.predict.return_value = MaskResult(mask_png=b"fake mask png bytes", score=0.91)

    run_sam3_predict(job_id, adapter=fake_adapter)

    session = SessionLocal()
    job = session.get(Job, job_id)
    assert job.status == JobStatus.SUCCEEDED
    assert job.progress == 100
    assert job.result_ref is not None

    from app.models import Annotation

    annotation = session.query(Annotation).filter(Annotation.frame_id == frame_id).first()
    assert annotation is not None
    assert annotation.annotation_type == "mask"
    assert annotation.storage_key == job.result_ref
    session.close()


def test_run_sam3_predict_marks_job_failed_on_adapter_error():
    session = SessionLocal()
    job_id, _ = _make_pending_job_with_frame(session)
    session.close()

    fake_adapter = MagicMock()
    fake_adapter.predict.side_effect = ValueError("no masks above threshold")

    run_sam3_predict(job_id, adapter=fake_adapter)

    session = SessionLocal()
    job = session.get(Job, job_id)
    assert job.status == JobStatus.FAILED
    assert "no masks above threshold" in job.error
    session.close()
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `cd ml-worker && uv run pytest tests/test_tasks.py -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'app.tasks'`.

- [ ] **Step 4: Write tasks.py**

```python
from datetime import datetime, timezone

from app.celery_app import celery_app
from app.db import SessionLocal
from app.models import Annotation, Frame, Job, JobStatus
from app.sam3_adapter import Sam3Adapter
from app.storage import get_storage_service

_adapter_singleton: Sam3Adapter | None = None


def _get_default_adapter() -> Sam3Adapter:
    global _adapter_singleton
    if _adapter_singleton is None:
        _adapter_singleton = Sam3Adapter()
    return _adapter_singleton


@celery_app.task(name="sam3_predict")
def run_sam3_predict(job_id: int, adapter: Sam3Adapter | None = None) -> None:
    """`adapter` is injectable for tests; production calls always resolve
    the real singleton lazily so the (slow) model load happens once per
    worker process, not once per plan-writing decision."""
    session = SessionLocal()
    storage = get_storage_service()
    resolved_adapter = adapter if adapter is not None else _get_default_adapter()

    job = session.get(Job, job_id)
    job.status = JobStatus.RUNNING
    job.started_at = datetime.now(timezone.utc)
    session.commit()

    try:
        frame_id = job.payload["frame_id"]
        prompts = job.payload["prompts"]
        frame = session.get(Frame, frame_id)

        frame_bytes = storage.download(frame.storage_key)
        result = resolved_adapter.predict(frame_bytes, prompts)

        mask_key = f"masks/{frame_id}/{job_id}.png"
        storage.upload(mask_key, result.mask_png, content_type="image/png")

        annotation = Annotation(
            frame_id=frame_id,
            label_id=None,
            taxonomy_version=None,
            annotation_type="mask",
            payload={"prompts": prompts, "score": result.score},
            status="draft",
            created_by_id=job.created_by_id,
            storage_key=mask_key,
        )
        session.add(annotation)

        job.status = JobStatus.SUCCEEDED
        job.progress = 100
        job.result_ref = mask_key
        job.finished_at = datetime.now(timezone.utc)
        session.commit()
    except Exception as exc:
        session.rollback()
        job = session.get(Job, job_id)
        job.status = JobStatus.FAILED
        job.error = str(exc)
        job.finished_at = datetime.now(timezone.utc)
        session.commit()
    finally:
        session.close()


@celery_app.task(name="sam3_track")
def run_sam3_track(job_id: int, adapter: Sam3Adapter | None = None) -> None:
    session = SessionLocal()
    storage = get_storage_service()
    resolved_adapter = adapter if adapter is not None else _get_default_adapter()

    job = session.get(Job, job_id)
    job.status = JobStatus.RUNNING
    job.started_at = datetime.now(timezone.utc)
    session.commit()

    try:
        sequence_id = job.payload["sequence_id"]
        prompts = job.payload["prompts"]
        frames = session.query(Frame).filter(Frame.sequence_id == sequence_id).order_by(Frame.frame_index).all()

        frame_bytes_list = [storage.download(f.storage_key) for f in frames]
        results = resolved_adapter.track(frame_bytes_list, prompts)

        for index, (frame, result) in enumerate(zip(frames, results)):
            mask_key = f"masks/{frame.id}/{job_id}.png"
            storage.upload(mask_key, result.mask_png, content_type="image/png")
            annotation = Annotation(
                frame_id=frame.id,
                label_id=None,
                taxonomy_version=None,
                annotation_type="mask",
                payload={"prompts": prompts, "score": result.score},
                status="draft",
                created_by_id=job.created_by_id,
                storage_key=mask_key,
            )
            session.add(annotation)

            job.progress = int(((index + 1) / len(frames)) * 100)
            session.commit()

        job.status = JobStatus.SUCCEEDED
        job.finished_at = datetime.now(timezone.utc)
        session.commit()
    except Exception as exc:
        session.rollback()
        job = session.get(Job, job_id)
        job.status = JobStatus.FAILED
        job.error = str(exc)
        job.finished_at = datetime.now(timezone.utc)
        session.commit()
    finally:
        session.close()
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd ml-worker && uv run pytest tests/test_tasks.py -v`
Expected: PASS (both tests). Requires `docker compose up -d` (Postgres + MinIO reachable).

- [ ] **Step 6: Commit**

```bash
git add ml-worker/app/tasks.py ml-worker/app/celery_app.py ml-worker/tests/test_tasks.py
git commit -m "Add Celery tasks: sam3_predict and sam3_track orchestration with progress"
```

---

### Task 9: Frontend — poll job status, point-prompt UI on the frame annotation page

**Files:**
- Create: `frontend/src/entities/useJobs.ts`
- Create: `frontend/src/features/annotation/SegmentButton.tsx`
- Modify: `frontend/src/features/annotation/FrameAnnotationPage.tsx` — add the segment button and mask overlay
- Create: `frontend/tests/useJobs.test.ts`
- Create: `frontend/tests/SegmentButton.test.tsx`

**Interfaces:**
- Consumes: `apiClient` (Phase 1), the regenerated OpenAPI schema (this task requires running `npm run generate-api` after the backend's Task 3 routes exist, so the generated `paths` type includes `/jobs/sam3/predict` and `/jobs/{id}` — this happens automatically via the `predev`/`pretest`/`prebuild` hooks Phase 1 already wired).
- Produces: `useJob(jobId: number | null)` — a TanStack Query hook with `refetchInterval` that polls `GET /jobs/{id}` every 1500ms while `status` is `"pending"` or `"running"`, and stops polling once `"succeeded"` or `"failed"` (TanStack Query's `refetchInterval` accepts a function of the query state for exactly this).
- Produces: `<SegmentButton frameId={number} onJobCreated={(jobId: number) => void} />` — a button that, when clicked, prompts the user to click a point on the frame image (a single positive point prompt at normalized coordinates — box prompts and the multi-point UI are out of scope for this task, matching the plan's Task 6 MVP scope), calls `POST /jobs/sam3/predict`, and reports the resulting job id up via `onJobCreated`.

- [ ] **Step 1: Write the failing test for useJobs**

`frontend/tests/useJobs.test.ts`:
```typescript
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";

import { apiClient } from "../src/shared/api/client";
import { useJob } from "../src/entities/useJobs";

function wrapper({ children }: { children: ReactNode }) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}

describe("useJob", () => {
  it("stops polling once the job status is succeeded", async () => {
    vi.spyOn(apiClient, "GET").mockResolvedValue({
      data: { id: 1, job_type: "sam3_predict", status: "succeeded", progress: 100, result_ref: "masks/1/1.png", error: null, created_by_id: 1, started_at: null, finished_at: null },
      error: undefined,
      response: new Response(),
    } as never);

    const { result } = renderHook(() => useJob(1), { wrapper });

    await waitFor(() => expect(result.current.data?.status).toBe("succeeded"));
    expect(apiClient.GET).toHaveBeenCalledWith(
      "/jobs/{job_id}",
      expect.objectContaining({ params: { path: { job_id: 1 } } }),
    );
  });

  it("returns undefined data when jobId is null and does not call the API", () => {
    vi.spyOn(apiClient, "GET").mockResolvedValue({ data: undefined, error: undefined, response: new Response() } as never);

    const { result } = renderHook(() => useJob(null), { wrapper });

    expect(result.current.data).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npm run test -- useJobs`
Expected: FAIL with a module resolution error for `../src/entities/useJobs`.

- [ ] **Step 3: Write useJobs.ts**

```typescript
import { useQuery } from "@tanstack/react-query";

import { apiClient } from "../shared/api/client";

const TERMINAL_STATUSES = new Set(["succeeded", "failed"]);

export function useJob(jobId: number | null) {
  return useQuery({
    queryKey: ["jobs", jobId],
    queryFn: async () => {
      const result = await apiClient.GET("/jobs/{job_id}", {
        params: { path: { job_id: jobId as number } },
      });
      return result.data;
    },
    enabled: jobId !== null,
    refetchInterval: (query) => {
      const status = query.state.data?.status;
      if (status && TERMINAL_STATUSES.has(status)) {
        return false;
      }
      return 1500;
    },
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd frontend && npm run test -- useJobs`
Expected: PASS (both tests).

- [ ] **Step 5: Write the failing test for SegmentButton**

`frontend/tests/SegmentButton.test.tsx`:
```tsx
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it, vi, beforeEach } from "vitest";

import { apiClient } from "../src/shared/api/client";
import { SegmentButton } from "../src/features/annotation/SegmentButton";

function renderButton(onJobCreated: (jobId: number) => void) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <SegmentButton frameId={42} onJobCreated={onJobCreated} />
    </QueryClientProvider>,
  );
}

describe("SegmentButton", () => {
  beforeEach(() => {
    vi.spyOn(apiClient, "POST").mockResolvedValue({
      data: { id: 7, job_type: "sam3_predict", status: "pending", progress: 0, result_ref: null, error: null, created_by_id: 1, started_at: null, finished_at: null },
      error: undefined,
      response: new Response(),
    } as never);
  });

  it("enters point-picking mode on click, then enqueues a predict job on image click", async () => {
    const onJobCreated = vi.fn();
    renderButton(onJobCreated);

    await userEvent.click(screen.getByRole("button", { name: "Segment with SAM-3" }));

    expect(screen.getByText("Click a point on the frame to segment")).toBeInTheDocument();
  });

  it("calls POST /jobs/sam3/predict with a point prompt when the frame image is clicked in picking mode", async () => {
    const onJobCreated = vi.fn();
    renderButton(onJobCreated);

    await userEvent.click(screen.getByRole("button", { name: "Segment with SAM-3" }));
    const image = screen.getByTestId("segment-click-target");
    Object.defineProperty(image, "getBoundingClientRect", {
      value: () => ({ left: 0, top: 0, width: 200, height: 100 }),
    });
    await userEvent.click(image, { clientX: 100, clientY: 50 });

    await waitFor(() => expect(apiClient.POST).toHaveBeenCalledWith(
      "/jobs/sam3/predict",
      expect.objectContaining({
        body: {
          frame_id: 42,
          prompts: [{ type: "point", coords: [0.5, 0.5], label: true }],
        },
      }),
    ));
    await waitFor(() => expect(onJobCreated).toHaveBeenCalledWith(7));
  });
});
```

- [ ] **Step 6: Run test to verify it fails**

Run: `cd frontend && npm run test -- SegmentButton`
Expected: FAIL with a module resolution error.

- [ ] **Step 7: Write SegmentButton.tsx**

```tsx
import { useState, type MouseEvent } from "react";
import { useMutation } from "@tanstack/react-query";

import { apiClient } from "../../shared/api/client";

interface SegmentButtonProps {
  frameId: number;
  onJobCreated: (jobId: number) => void;
}

export function SegmentButton({ frameId, onJobCreated }: SegmentButtonProps) {
  const [isPicking, setIsPicking] = useState(false);

  const createJob = useMutation({
    mutationFn: async (coords: [number, number]) => {
      const result = await apiClient.POST("/jobs/sam3/predict", {
        body: {
          frame_id: frameId,
          prompts: [{ type: "point", coords, label: true }],
        },
      });
      return result.data;
    },
    onSuccess: (data) => {
      setIsPicking(false);
      if (data) {
        onJobCreated(data.id);
      }
    },
  });

  function handleImageClick(event: MouseEvent<HTMLDivElement>) {
    if (!isPicking) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const normalizedX = (event.clientX - rect.left) / rect.width;
    const normalizedY = (event.clientY - rect.top) / rect.height;
    createJob.mutate([normalizedX, normalizedY]);
  }

  return (
    <div>
      <button
        type="button"
        onClick={() => setIsPicking(true)}
        className="rounded bg-blue-600 px-3 py-2 font-medium text-white hover:bg-blue-500"
      >
        Segment with SAM-3
      </button>
      {isPicking && (
        <p className="mt-2 text-sm text-gray-400">Click a point on the frame to segment</p>
      )}
      <div data-testid="segment-click-target" onClick={handleImageClick} className="contents" />
    </div>
  );
}
```

Note: `data-testid="segment-click-target"` on a plain `div` is a placeholder click surface for this task's test — Task 10 (or a follow-up UI-polish task, not in this plan) is expected to replace it with the actual frame `<img>` element already rendered by `FrameAnnotationPage`, once that page's layout is touched in Step 9 below. This task's own test only proves the coordinate math and the mutation call are correct, not the final visual placement.

- [ ] **Step 8: Run test to verify it passes**

Run: `cd frontend && npm run test -- SegmentButton`
Expected: PASS (both tests).

- [ ] **Step 9: Wire SegmentButton and job status into FrameAnnotationPage**

Modify `frontend/src/features/annotation/FrameAnnotationPage.tsx`, replacing the placeholder frame display with a clickable image wrapper and adding job status feedback:

```tsx
import { useState } from "react";
import { useParams } from "react-router-dom";

import { useAnnotations, useCreateAnnotation } from "../../entities/useAnnotations";
import { useJob } from "../../entities/useJobs";
import { useLabels } from "../../entities/useLabels";
import { LabelPicker } from "./LabelPicker";
import { SegmentButton } from "./SegmentButton";

export function FrameAnnotationPage() {
  const { frameId } = useParams<{ frameId: string }>();
  const frameIdNumber = Number(frameId);
  const [activeJobId, setActiveJobId] = useState<number | null>(null);

  const labelsQuery = useLabels();
  const annotationsQuery = useAnnotations(frameIdNumber);
  const createAnnotation = useCreateAnnotation(frameIdNumber);
  const jobQuery = useJob(activeJobId);

  return (
    <div className="grid min-h-screen grid-cols-[1fr_300px] bg-gray-950 text-gray-100">
      <div className="flex flex-col items-center justify-center gap-4 p-8">
        <p className="text-gray-400">Frame #{frameId}</p>
        <SegmentButton frameId={frameIdNumber} onJobCreated={setActiveJobId} />
        {jobQuery.data && (
          <p className="text-sm text-gray-400">
            SAM-3 job #{jobQuery.data.id}: {jobQuery.data.status} ({jobQuery.data.progress}%)
          </p>
        )}
      </div>
      <aside className="border-l border-gray-800 p-4">
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-gray-400">
          Labels
        </h2>
        <LabelPicker
          labels={labelsQuery.data ?? []}
          onSelect={(labelId) => createAnnotation.mutate(labelId)}
        />
        <h2 className="mb-3 mt-6 text-sm font-semibold uppercase tracking-wide text-gray-400">
          Existing annotations
        </h2>
        <ul className="space-y-1 text-sm text-gray-300">
          {(annotationsQuery.data ?? []).map((annotation) => (
            <li key={annotation.id}>
              Label #{annotation.label_id} — {annotation.status}
            </li>
          ))}
        </ul>
      </aside>
    </div>
  );
}
```

- [ ] **Step 10: Run the full frontend suite and build**

```bash
cd frontend
npm run test
npm run build
```
Expected: all tests PASS, build succeeds.

- [ ] **Step 11: Commit**

```bash
git add frontend/src/entities/useJobs.ts frontend/src/features/annotation/SegmentButton.tsx frontend/src/features/annotation/FrameAnnotationPage.tsx frontend/tests/useJobs.test.ts frontend/tests/SegmentButton.test.tsx
git commit -m "Add frontend job polling and SAM-3 point-prompt UI on frame annotation page"
```

---

### Task 10: End-to-end verification — real GPU inference through the full stack

**Files:**
- Modify: `frontend/e2e/annotation-flow.spec.ts` — extend with a SAM-3 segmentation step, OR create `frontend/e2e/sam3-segment.spec.ts` as a separate spec (implementer's choice — if the existing spec is already long/slow, a separate spec that reuses the same register/login/upload setup pattern is reasonable; if adding to the existing one keeps the file more cohesive as "the one true integration test," that's also fine — this task's requirement is that the flow gets proven, not which file it lives in).

**Interfaces:**
- Consumes: the full running stack — backend on `:8000`, frontend dev server on `:5173`, `ml-worker` Celery worker actually running and consuming from Redis (this is the one new requirement beyond Phase 1's e2e setup: `docker compose up -d ml-worker` or a locally-run `celery -A app.celery_app worker` process from `ml-worker/`), real SAM-3 weights loaded.
- Produces: one Playwright spec proving register → login → upload video → create sequence (via API, as Phase 1's pattern) → open a frame → click "Segment with SAM-3" → click a point on the frame → poll until the job succeeds → verify a mask `Annotation` now exists for that frame, end-to-end against the real GPU-backed worker, no mocks.

- [ ] **Step 1: Write the failing test**

`frontend/e2e/sam3-segment.spec.ts`:
```typescript
import { expect, test } from "@playwright/test";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

test("annotator can segment a frame with SAM-3 and see the resulting mask annotation", async ({ page, request }) => {
  const email = `e2e-sam3-${Date.now()}@example.com`;
  const password = "e2e-pass-1234";

  const registerResponse = await request.post("http://localhost:8000/auth/register", {
    data: { email, password, role: "annotator" },
  });
  expect(registerResponse.ok()).toBe(true);

  const loginResponse = await request.post("http://localhost:8000/auth/login", {
    data: { email, password },
  });
  const { access_token: token } = await loginResponse.json();
  const authHeaders = { Authorization: `Bearer ${token}` };

  const uploadResponse = await request.post("http://localhost:8000/media/videos", {
    headers: authHeaders,
    multipart: {
      title: `SAM3 e2e ${Date.now()}`,
      file: {
        name: "tiny.mp4",
        mimeType: "video/mp4",
        buffer: require("node:fs").readFileSync(path.join(__dirname, "..", "tests", "fixtures", "tiny.mp4")),
      },
    },
  });
  const video = await uploadResponse.json();

  const sequenceResponse = await request.post(`http://localhost:8000/media/videos/${video.id}/sequences`, {
    headers: authHeaders,
    data: { start_time: 0, duration: 2 },
  });
  const sequence = await sequenceResponse.json();

  const framesResponse = await request.get(`http://localhost:8000/media/sequences/${sequence.id}/frames`, {
    headers: authHeaders,
  });
  const frames = await framesResponse.json();
  const firstFrame = frames[0];

  await page.goto("/login");
  await page.getByPlaceholder("Email").fill(email);
  await page.getByPlaceholder("Password").fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/videos$/);

  await page.goto(`/frames/${firstFrame.id}`);
  await page.getByRole("button", { name: "Segment with SAM-3" }).click();
  await page.getByTestId("segment-click-target").click({ position: { x: 100, y: 50 } });

  await expect(page.getByText(/SAM-3 job #\d+: succeeded/)).toBeVisible({ timeout: 60_000 });

  const annotationsResponse = await request.get(
    `http://localhost:8000/annotation/frames/${firstFrame.id}/annotations`,
    { headers: authHeaders },
  );
  const annotations = await annotationsResponse.json();
  const maskAnnotation = annotations.find((a: { annotation_type: string }) => a.annotation_type === "mask");
  expect(maskAnnotation).toBeTruthy();
  expect(maskAnnotation.status).toBe("draft");
});
```

Note the 60-second timeout on the job-succeeded assertion — real GPU inference plus a cold model load (first request in a freshly-started worker process) can take significantly longer than Phase 1's synchronous, CPU-only OpenCV frame extraction did; don't reuse Phase 1's shorter timeouts here.

- [ ] **Step 2: Run test to verify it fails**

With `ml-worker` NOT running (backend/frontend/infra up, but no Celery worker consuming tasks), run: `cd frontend && npm run test:e2e -- sam3-segment`
Expected: FAIL — the job stays `"pending"` forever and the 60-second wait for `"succeeded"` times out. This confirms the frontend polling and the enqueue side work; only the worker is missing, which is the correct RED state for this task.

- [ ] **Step 3: Start the ml-worker and full stack**

```bash
cd /mnt/work-disk/Documents/Dev/endoscopy-platform
docker compose up -d
cd backend && uv run uvicorn app.main:app --reload &
cd ../frontend && npm run dev &
docker compose up ml-worker &
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cd /mnt/work-disk/Documents/Dev/endoscopy-platform/frontend
npm run test:e2e -- sam3-segment
```
Expected: PASS — first run includes the SAM-3 checkpoint download/load time inside the worker; if the 60s timeout is exceeded purely due to a cold model load on a slow connection (not an actual failure), rerun once the worker has fully started (check its logs for "ready" via `docker compose logs ml-worker`) before concluding there's a real defect.

- [ ] **Step 5: Stop background processes**

```bash
kill %1 %2 %3 2>/dev/null
docker compose stop ml-worker
```
(Adjust job numbers per `jobs`; leave `postgres`/`redis`/`minio` running as with Phase 1.)

- [ ] **Step 6: Commit**

```bash
cd /mnt/work-disk/Documents/Dev/endoscopy-platform
git add frontend/e2e/sam3-segment.spec.ts
git commit -m "Add end-to-end test: real SAM-3 GPU segmentation through the full stack"
```

---

## Self-Review Notes

- **Spec coverage:** `jobs` domain (Task 1, 3), Celery + Redis (Task 2), SAM-3 as the primary segmentation adapter with all four prompt forms mentioned in the design spec — this plan implements point/box (per the human's explicit MVP scoping decision during planning; text/exemplar prompts and other detection adapters are follow-up work, not silently dropped — see the note below), `predict`/`track` per the `SegmentationAdapter` protocol shape (Task 6, 7), `Job.payload` carrying adapter-specific data (Task 1), progress on the frontend via polling with an explicit note that SSE (the spec's stated preference) is deferred per the human's explicit choice during planning, mask `Annotation` rows using the `payload`/`storage_key` columns Phase 1 already reserved for this (Task 8). `StorageService`-only access to binaries maintained throughout (Task 4, 6, 8).
- **Explicitly deferred, not forgotten:** SAM-3 text/exemplar prompts (only point/box in this plan), YOLO/RT-DETRv2/RF-DETR detection adapters (separate Phase per ROADMAP.md), MLflow/datasets/training (separate Phases), SSE progress streaming (polling only here). Record these in ROADMAP.md's Phase 2 entry when this plan completes, the same way Phase 1's deviations were logged.
- **Placeholder scan:** no TBD/TODO markers. Two explicit, deliberate flags exist where the plan's confidence in an external API's exact response shape is lower than the rest of the plan (Task 7's `track()` output field names, Task 5's CUDA base image tag) — both are flagged with concrete verification steps for the implementer to run and correct against, not silently asserted as fact. This is a deliberate departure from "no placeholders" in the narrow case of a third-party API this plan's author could not fully execute against during research (no GPU/HF access at plan-writing time in the research sandbox) — the flags themselves contain the exact command to run to resolve the uncertainty, which is the standard this skill holds placeholders to.
- **Type consistency:** `JobType`/`JobStatus` enum values match across `backend/app/jobs/models.py`, `ml-worker/app/models.py`, and test assertions (Task 1, 3, 8). Prompt shape (`{"type": "point"|"box", "coords": [...], "label": bool}`) matches across `backend/app/jobs/schemas.py`'s `PromptIn`, `ml_worker.app.sam3_adapter._prompt_to_geometric_box`, and the frontend's `SegmentButton.tsx` mutation body. `MaskResult(mask_png, score)` matches between Task 6's `predict()` and Task 8's `tasks.py` usage. Fixed during self-review: Task 4's `ml-worker/app/models.py` `Job` class initially omitted `created_by_id`, while Task 8's `tasks.py` referenced `job.created_by_id` when constructing `Annotation` rows (`created_by_id` is NOT NULL on the backend's real schema) — added the column to Task 4's model and removed the `hasattr` workaround the draft had used to paper over the gap; Task 8's test fixture (`_make_pending_job_with_frame`) now sets `created_by_id=1` explicitly to match.
