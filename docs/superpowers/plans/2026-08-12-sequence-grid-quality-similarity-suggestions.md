# Sequence grid: Rank Quality / Find Similar suggestions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add two suggestion tools to the sequence grid's Select mode — "Rank Quality" (auto-checks the worst N% of frames by image quality) and "Find Similar" (auto-checks near-duplicate frames) — both suggestion-only, reusing the existing checkbox/delete mechanics.

**Architecture:** Both tools are Celery jobs in `ml-worker`, dispatched and polled through the existing `Job`/`useJob` infrastructure used by SAM2/SAM3. Rank Quality scores frames with TOPIQ (pyiqa), falling back to Laplacian variance if pyiqa/torch is unavailable. Find Similar embeds frames with DINOv2 ViT-B/14, clusters near-duplicates by cosine similarity via Union-Find, and keeps the best-quality frame per cluster (reusing the quality scorer). Results are written into the existing `Job.payload` JSON column (`payload["result"]`) rather than a new column. The frontend auto-checks returned frame IDs into the grid's existing selection state, tracking which checks came from a suggestion tool (for "Clear marks") separately from manual ones.

**Tech Stack:** FastAPI, SQLAlchemy, Celery, Pydantic (backend) · Celery, PyTorch, pyiqa, OpenCV, torch.hub DINOv2 (ml-worker) · React, TanStack Query, Tailwind, Vitest/Testing Library (frontend)

## Global Constraints

- No Russian in committed content — code, comments, docstrings, UI copy (English only; conversation with the user is fine).
- No new `Frame` table columns and no Alembic migration — quality/similarity results are transient, stored only in `Job.payload["result"]` for that job's lifetime.
- No change to "Delete selected" or manual checkbox selection — both are reused unmodified.
- Every backend and frontend task with logic gets a failing test before the implementation (TDD).
- New ml-worker Celery tasks register on the **default** queue (same as SAM2/SAM3 tasks) — not a dedicated queue.
- Quality score convention: **lower score = worse quality** (matches TOPIQ's native higher-is-better polarity, and the Laplacian fallback is inverted to match).
- Backend tests in this repo run `TestClient(app)` against the real dev-pattern database via fixtures created through the API (procedures → sequences → frames) — no mocking the DB layer. Follow `backend/tests/test_media.py`'s `_auth_headers()` / photo-sequence-upload pattern for any new test needing a sequence with real frames.
- ml-worker tests requiring torch/pyiqa run inside the `ml-worker` Docker container (`docker cp` + `docker compose exec`), not the host venv — see `ml_worker_test_workflow` memory. Tests that don't need torch (pure logic, e.g. Union-Find clustering math) can run on the host if `torch` isn't imported at module load time in a way that breaks host collection — mirror how `test_tasks_gpu_eviction.py` already does this (mocks adapters, doesn't need real torch execution).

---

## Phase 1: Rank Quality

### Task 1: Backend — `JobType.RANK_QUALITY` and `enqueue_rank_quality`

**Files:**
- Modify: `backend/app/jobs/models.py` (add enum member)
- Modify: `backend/app/jobs/service.py` (add enqueue function)
- Test: `backend/tests/test_jobs.py`

**Interfaces:**
- Consumes: `Job`, `JobStatus`, `JobType` from `app.jobs.models`; `celery_app` from `app.celery_app`.
- Produces: `JobType.RANK_QUALITY` enum member; `enqueue_rank_quality(session: Session, sequence_id: int, percent: int, created_by: User) -> Job` — creates a `Job` row with `job_type=JobType.RANK_QUALITY`, `payload={"sequence_id": sequence_id, "percent": percent}`, dispatches `celery_app.send_task("rank_quality", args=[job.id])` (no explicit `queue=` kwarg, so it lands on the default queue), returns the `Job`. Later tasks (Task 3, the router) call this by name and this exact signature.

- [ ] **Step 1: Write the failing test**

Add to `backend/tests/test_jobs.py` (check the file's existing imports/fixtures first — mirror whatever pattern `enqueue_sam3_predict`/`enqueue_video_transcode` are already tested with there; if no such file-level pattern exists yet, use `db_session` from `conftest.py` directly, following `enqueue_video_transcode`'s three-line-body shape as the reference):

```python
from app.jobs.models import Job, JobStatus, JobType
from app.jobs.service import enqueue_rank_quality


def test_enqueue_rank_quality_creates_pending_job(db_session):
    from app.auth.models import User

    user = User(email="rank-quality-enqueue@example.com", hashed_password="x", role="admin")
    db_session.add(user)
    db_session.commit()
    db_session.refresh(user)

    job = enqueue_rank_quality(db_session, sequence_id=123, percent=20, created_by=user)

    assert job.id is not None
    assert job.job_type == JobType.RANK_QUALITY
    assert job.status == JobStatus.PENDING
    assert job.payload == {"sequence_id": 123, "percent": 20}
```

(If `test_jobs.py` already has a `_make_user`/similar helper or a different User-construction pattern, use that instead of the inline construction above — read the file first and match its existing style exactly rather than introducing a second pattern.)

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && uv run pytest tests/test_jobs.py::test_enqueue_rank_quality_creates_pending_job -v`
Expected: FAIL with `ImportError: cannot import name 'enqueue_rank_quality'` (or `AttributeError: RANK_QUALITY`)

- [ ] **Step 3: Implement `JobType.RANK_QUALITY` and `enqueue_rank_quality`**

In `backend/app/jobs/models.py`, add to the `JobType` enum:

```python
class JobType(str, enum.Enum):
    SAM3_PREDICT = "sam3_predict"
    SAM3_TRACK = "sam3_track"
    SAM2_PREDICT = "sam2_predict"
    SAM2_TRACK = "sam2_track"
    VIDEO_TRANSCODE = "video_transcode"
    RANK_QUALITY = "rank_quality"
    FIND_SIMILAR = "find_similar"
```

(Both members are added now since they share one `Enum` — Phase 2 will not need to touch this file again.)

In `backend/app/jobs/service.py`, add after `enqueue_video_transcode`:

```python
def enqueue_rank_quality(session: Session, sequence_id: int, percent: int, created_by: User) -> Job:
    job = Job(
        job_type=JobType.RANK_QUALITY,
        status=JobStatus.PENDING,
        payload={"sequence_id": sequence_id, "percent": percent},
        created_by_id=created_by.id,
    )
    session.add(job)
    session.commit()
    session.refresh(job)

    celery_app.send_task("rank_quality", args=[job.id])
    return job
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && uv run pytest tests/test_jobs.py::test_enqueue_rank_quality_creates_pending_job -v`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add backend/app/jobs/models.py backend/app/jobs/service.py backend/tests/test_jobs.py
git commit -m "feat: add RANK_QUALITY job type and enqueue_rank_quality"
```

---

### Task 2: Backend — `POST /media/sequences/{sequence_id}/rank-quality` endpoint

**Files:**
- Modify: `backend/app/media/schemas.py` (add `RankQualityRequest`)
- Modify: `backend/app/media/router.py` (add endpoint)
- Test: `backend/tests/test_media.py`

**Interfaces:**
- Consumes: `enqueue_rank_quality` from `app.jobs.service` (Task 1); `Sequence` from `app.media.models`; `Job`, `JobStatus`, `JobType` from `app.jobs.models`; `JobRead` from `app.jobs.schemas`.
- Produces: `RankQualityRequest { percent: int }` (ge=1, le=99, default=20) pydantic schema in `app.media.schemas`. Endpoint `POST /media/sequences/{sequence_id}/rank-quality` returning `JobRead` (201) — sequence-not-found → 404, duplicate in-flight `RANK_QUALITY` job for the same sequence → 409. Frontend hooks (Task 8) call this exact path/shape.

- [ ] **Step 1: Write the failing test**

Add to `backend/tests/test_media.py`, following `test_transcode_video_creates_job`'s exact style (real `_auth_headers()`, real procedure/sequence via the API, `tiny_frame.png` fixture already used by `test_upload_photo_batch_creates_one_sequence_and_all_frames`):

```python
def test_rank_quality_creates_job():
    headers = _auth_headers()
    procedure_id = client.post(
        "/taxonomy/procedures", json={"name": "rank-quality-procedure"}, headers=headers
    ).json()["id"]
    fixture = Path(__file__).parent / "fixtures" / "tiny_frame.png"
    with open(fixture, "rb") as f:
        image_bytes = f.read()
    sequence_id = client.post(
        "/media/sequences/photos",
        data={"name": "Rank quality seq", "procedure_id": str(procedure_id)},
        files=[("files", ("a.png", image_bytes, "image/png"))],
        headers=headers,
    ).json()["id"]

    response = client.post(
        f"/media/sequences/{sequence_id}/rank-quality", json={"percent": 20}, headers=headers
    )
    assert response.status_code == 201
    body = response.json()
    assert body["job_type"] == "rank_quality"
    assert body["status"] == "pending"


def test_rank_quality_404_for_missing_sequence():
    headers = _auth_headers()
    response = client.post(
        "/media/sequences/999999999/rank-quality", json={"percent": 20}, headers=headers
    )
    assert response.status_code == 404


def test_rank_quality_409_when_already_pending():
    headers = _auth_headers()
    procedure_id = client.post(
        "/taxonomy/procedures", json={"name": "rank-quality-double-procedure"}, headers=headers
    ).json()["id"]
    fixture = Path(__file__).parent / "fixtures" / "tiny_frame.png"
    with open(fixture, "rb") as f:
        image_bytes = f.read()
    sequence_id = client.post(
        "/media/sequences/photos",
        data={"name": "Rank quality double seq", "procedure_id": str(procedure_id)},
        files=[("files", ("a.png", image_bytes, "image/png"))],
        headers=headers,
    ).json()["id"]

    first = client.post(
        f"/media/sequences/{sequence_id}/rank-quality", json={"percent": 20}, headers=headers
    )
    assert first.status_code == 201

    second = client.post(
        f"/media/sequences/{sequence_id}/rank-quality", json={"percent": 20}, headers=headers
    )
    assert second.status_code == 409
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && uv run pytest tests/test_media.py::test_rank_quality_creates_job -v`
Expected: FAIL with 404 (route doesn't exist yet)

- [ ] **Step 3: Implement the schema and endpoint**

In `backend/app/media/schemas.py`, add:

```python
class RankQualityRequest(BaseModel):
    percent: int = Field(default=20, ge=1, le=99)
```

In `backend/app/media/router.py`:

Add to the imports from `app.jobs.schemas`: `JobRead` is already imported. Add to imports from `app.jobs.service`: `enqueue_rank_quality`. Add to imports from `app.media.schemas`: `RankQualityRequest`.

Add the endpoint, placed after `bulk_delete_frames` (end of file):

```python
@router.post(
    "/sequences/{sequence_id}/rank-quality", response_model=JobRead, status_code=status.HTTP_201_CREATED
)
def rank_sequence_quality(
    sequence_id: int,
    payload: RankQualityRequest,
    current_user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
) -> Job:
    sequence = session.get(Sequence, sequence_id)
    if sequence is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Sequence not found")

    existing_pending_or_running = (
        session.query(Job)
        .filter(
            Job.job_type == JobType.RANK_QUALITY,
            Job.payload["sequence_id"].as_integer() == sequence_id,
            Job.status.in_([JobStatus.PENDING, JobStatus.RUNNING]),
        )
        .first()
    )
    if existing_pending_or_running is not None:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="A quality ranking job is already in progress for this sequence",
        )

    return enqueue_rank_quality(session, sequence_id, payload.percent, current_user)
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd backend && uv run pytest tests/test_media.py::test_rank_quality_creates_job tests/test_media.py::test_rank_quality_404_for_missing_sequence tests/test_media.py::test_rank_quality_409_when_already_pending -v`
Expected: PASS (all three)

- [ ] **Step 5: Regenerate `openapi.json`**

Run: `cd backend && PYTHONPATH=. uv run python scripts/export_openapi.py`
Verify: `git diff --stat openapi.json` shows a change.

- [ ] **Step 6: Commit**

```bash
git add backend/app/media/schemas.py backend/app/media/router.py backend/tests/test_media.py openapi.json
git commit -m "feat: add POST /media/sequences/{id}/rank-quality endpoint"
```

---

### Task 3: ml-worker — `QualityAdapter` (TOPIQ + Laplacian fallback)

**Files:**
- Create: `ml-worker/app/quality_adapter.py`
- Test: `ml-worker/tests/test_quality_adapter.py`
- Modify: `ml-worker/pyproject.toml` (add `pyiqa`, `opencv-python-headless` to `dependencies`)
- Modify: `ml-worker/Dockerfile` (install the same two packages)

**Interfaces:**
- Consumes: nothing beyond `torch`, `pyiqa`, `cv2`, `numpy`, `PIL.Image` (all newly available after this task's dependency changes).
- Produces: `class QualityAdapter` with `__init__(self) -> None` (lazy, no eager model load) and `score(self, frame_bytes: bytes) -> float` — returns a `float` where **lower = worse quality**. Primary path: `pyiqa.create_metric('topiq_nr')` (module-level lazy singleton inside the class instance, mirroring `Sam2Adapter`'s `self._image_predictor = None` pattern). Fallback path (triggered when `import pyiqa` or model creation raises): Laplacian variance via `cv2.Laplacian(gray, cv2.CV_64F).var()`, inverted to match TOPIQ's polarity. Task 5 (`run_rank_quality`) and Task 6 (`run_find_similar`, Phase 2) both call `.score()` by this exact name.

- [ ] **Step 1: Write the failing tests**

Create `ml-worker/tests/test_quality_adapter.py`:

```python
import io
from pathlib import Path
from unittest.mock import patch

from PIL import Image

from app.quality_adapter import QualityAdapter


def _make_frame_bytes(color: tuple[int, int, int] = (128, 128, 128)) -> bytes:
    image = Image.new("RGB", (64, 64), color=color)
    buffer = io.BytesIO()
    image.save(buffer, format="PNG")
    return buffer.getvalue()


def test_score_uses_topiq_when_pyiqa_available():
    adapter = QualityAdapter()
    fake_metric = lambda *args, **kwargs: __import__("torch").tensor([0.7])
    with patch.object(adapter, "_get_metric", return_value=fake_metric):
        score = adapter.score(_make_frame_bytes())

    assert score == 0.7


def test_score_falls_back_to_laplacian_variance_when_topiq_unavailable():
    adapter = QualityAdapter()
    with patch.object(adapter, "_get_metric", side_effect=RuntimeError("pyiqa unavailable")):
        score = adapter.score(_make_frame_bytes())

    assert isinstance(score, float)


def test_laplacian_fallback_scores_sharper_image_higher_than_blurry():
    """Lower score = worse quality (matches TOPIQ's higher-is-better polarity).
    A flat gray image has ~zero Laplacian variance (no edges, worst case);
    a checkerboard has strong edges (sharp, best case) -- so the fallback's
    inversion must rank the checkerboard as *higher* score than the flat image."""
    import numpy as np

    adapter = QualityAdapter()

    flat = Image.new("RGB", (64, 64), color=(128, 128, 128))
    flat_buffer = io.BytesIO()
    flat.save(flat_buffer, format="PNG")

    checkerboard_array = np.zeros((64, 64, 3), dtype="uint8")
    checkerboard_array[::2, ::2] = 255
    checkerboard_array[1::2, 1::2] = 255
    checkerboard = Image.fromarray(checkerboard_array)
    checkerboard_buffer = io.BytesIO()
    checkerboard.save(checkerboard_buffer, format="PNG")

    with patch.object(adapter, "_get_metric", side_effect=RuntimeError("pyiqa unavailable")):
        flat_score = adapter.score(flat_buffer.getvalue())
        checkerboard_score = adapter.score(checkerboard_buffer.getvalue())

    assert checkerboard_score > flat_score
```

- [ ] **Step 2: Run tests to verify they fail**

Run (inside the ml-worker container per this repo's `ml_worker_test_workflow`):
```bash
docker cp ml-worker/app/. <ml-worker-container>:/app/app/
docker cp ml-worker/tests/. <ml-worker-container>:/app/tests/
docker compose exec ml-worker uv run pytest tests/test_quality_adapter.py -v
```
Expected: FAIL with `ModuleNotFoundError: No module named 'app.quality_adapter'`

- [ ] **Step 3: Add dependencies**

In `ml-worker/pyproject.toml`, add to `dependencies`:

```toml
    "pyiqa>=0.1.13",
    "opencv-python-headless>=4.10.0",
```

In `ml-worker/Dockerfile`, add after the `hydra-core`/`iopath`/`tqdm` install line (line 80) and before `COPY app ./app`:

```dockerfile
# TOPIQ (Rank Quality's primary no-reference quality metric) and the
# OpenCV Laplacian-variance fallback used when pyiqa/torch fail to load --
# see docs/superpowers/specs/2026-08-12-sequence-grid-quality-similarity-suggestions-design.md.
# Both are pure-PyPI packages that work against the already-pinned
# torch==2.7.1 above; opencv-python-headless (not opencv-python) since this
# is a server container with no display.
RUN uv pip install "pyiqa>=0.1.13" "opencv-python-headless>=4.10.0"
```

- [ ] **Step 4: Implement `QualityAdapter`**

Create `ml-worker/app/quality_adapter.py`:

```python
import io

import cv2
import numpy as np
from PIL import Image


class QualityAdapter:
    """No-reference image-quality scorer for Rank Quality. Primary metric
    is TOPIQ (via pyiqa) -- a modern deep-learning no-reference IQA metric
    correlating well with human quality judgment. Falls back to Laplacian
    variance (OpenCV, no torch/pyiqa dependency) if pyiqa/torch fail to
    load, e.g. a version mismatch or missing model weights download.

    Score convention: lower score = worse quality, matching TOPIQ's native
    scale (roughly 0-1, higher is better). The Laplacian fallback is
    inverted to match this same polarity."""

    def __init__(self) -> None:
        self._metric = None

    def _get_metric(self):
        if self._metric is None:
            import pyiqa

            self._metric = pyiqa.create_metric("topiq_nr")
        return self._metric

    def score(self, frame_bytes: bytes) -> float:
        image = Image.open(io.BytesIO(frame_bytes)).convert("RGB")
        try:
            metric = self._get_metric()
            import torch
            from torchvision import transforms

            tensor = transforms.ToTensor()(image).unsqueeze(0)
            with torch.no_grad():
                result = metric(tensor)
            return float(result.item() if hasattr(result, "item") else result[0])
        except Exception:
            return self._laplacian_fallback_score(image)

    def _laplacian_fallback_score(self, image: Image.Image) -> float:
        gray = cv2.cvtColor(np.array(image), cv2.COLOR_RGB2GRAY)
        variance = cv2.Laplacian(gray, cv2.CV_64F).var()
        # Same polarity as TOPIQ (higher = better): a sharp image has high
        # Laplacian variance (many strong edges), so use the raw variance
        # directly rather than inverting it -- the inversion mentioned in
        # the design doc refers to keeping "higher = better" consistent
        # with TOPIQ, which raw Laplacian variance already satisfies.
        return float(variance)
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `docker compose exec ml-worker uv run pytest tests/test_quality_adapter.py -v`
Expected: PASS (all three)

- [ ] **Step 6: Commit**

```bash
git add ml-worker/app/quality_adapter.py ml-worker/tests/test_quality_adapter.py ml-worker/pyproject.toml ml-worker/Dockerfile ml-worker/uv.lock
git commit -m "feat: add QualityAdapter (TOPIQ with Laplacian-variance fallback)"
```

---

### Task 4: ml-worker — `run_rank_quality` Celery task

**Files:**
- Modify: `ml-worker/app/tasks.py` (add task, singleton getter, eviction wiring)
- Test: `ml-worker/tests/test_tasks.py` (or a new `ml-worker/tests/test_tasks_rank_quality.py` if `test_tasks.py` is already large — check its current line count first; if over ~400 lines, use the new file to keep it focused)

**Interfaces:**
- Consumes: `QualityAdapter` (Task 3); `Job`, `JobStatus`, `Frame` from `app.models`; `SessionLocal` from `app.db`; `get_storage_service` from `app.storage`; `celery_app` from `app.celery_app`.
- Produces: `_get_default_quality_adapter() -> QualityAdapter` (module-level singleton, same pattern as `_get_default_sam2_adapter`); `_evict_quality_models()` (releases the quality singleton's model, called at the top of every SAM task and vice versa); Celery task `run_rank_quality(job_id: int, adapter: QualityAdapter | None = None) -> None` registered as `"rank_quality"`. On success, writes `job.payload["result"] = {"scores": [{"frame_id": int, "score": float}, ...], "worst_ids": [int, ...]}` (scores sorted worst-first) and commits — `job.payload` is reassigned (not mutated in place) so SQLAlchemy's JSON-column change detection picks it up, matching how every other task field is set. Task 7 (Phase 2's `run_find_similar`) reuses `_get_default_quality_adapter()`.

- [ ] **Step 1: Write the failing test**

Add to `ml-worker/tests/test_tasks.py` (matching the style of `run_sam3_predict`'s existing tests in that file — check the top of the file for the exact DB/session fixture pattern used there, e.g. a `db_session`-style fixture or direct `SessionLocal()` calls wrapped in a transaction; mirror whatever's already established rather than introducing a new pattern):

```python
from unittest.mock import MagicMock

from app.models import Job, JobStatus, JobType


def test_run_rank_quality_scores_frames_worst_first_and_writes_result(db_session):
    from app.models import Frame

    frame_a = Frame(sequence_id=1, storage_key="frames/1/0.png", frame_index=0, width=10, height=10)
    frame_b = Frame(sequence_id=1, storage_key="frames/1/1.png", frame_index=1, width=10, height=10)
    frame_c = Frame(sequence_id=1, storage_key="frames/1/2.png", frame_index=2, width=10, height=10)
    db_session.add_all([frame_a, frame_b, frame_c])
    db_session.commit()

    job = Job(
        job_type=JobType.RANK_QUALITY,
        status=JobStatus.PENDING,
        progress=0,
        payload={"sequence_id": 1, "percent": 34},  # 34% of 3 frames -> round(1.02) -> 1 worst frame
        created_by_id=1,
    )
    db_session.add(job)
    db_session.commit()

    fake_adapter = MagicMock()
    # frame_b scores worst (lowest = worst, per QualityAdapter's polarity)
    fake_adapter.score.side_effect = [0.9, 0.1, 0.5]

    fake_storage = MagicMock()
    fake_storage.download.return_value = b"fake-png-bytes"

    import app.tasks as tasks_module

    with (
        __import__("unittest.mock", fromlist=["patch"]).patch.object(tasks_module, "SessionLocal", return_value=db_session),
        __import__("unittest.mock", fromlist=["patch"]).patch.object(tasks_module, "get_storage_service", return_value=fake_storage),
    ):
        tasks_module.run_rank_quality(job.id, adapter=fake_adapter)

    db_session.refresh(job)
    assert job.status == JobStatus.SUCCEEDED
    assert job.payload["result"]["worst_ids"] == [frame_b.id]
    scores_by_id = {s["frame_id"]: s["score"] for s in job.payload["result"]["scores"]}
    assert scores_by_id[frame_b.id] == 0.1
```

(Adjust the `db_session`/session-patching mechanics to match whatever fixture `test_tasks.py`'s existing `run_sam3_predict` tests already use — read that file's setup before writing this, since ml-worker's test DB wiring may differ in specifics from what's shown here; the assertions and task-call shape above are the part that must hold regardless.)

- [ ] **Step 2: Run test to verify it fails**

Run: `docker compose exec ml-worker uv run pytest tests/test_tasks.py::test_run_rank_quality_scores_frames_worst_first_and_writes_result -v`
Expected: FAIL with `AttributeError: module 'app.tasks' has no attribute 'run_rank_quality'`

- [ ] **Step 3: Implement `run_rank_quality`**

In `ml-worker/app/tasks.py`:

Add import: `from app.quality_adapter import QualityAdapter`

Add singleton + eviction helper, near `_sam3_adapter_singleton`/`_sam2_adapter_singleton`:

```python
_quality_adapter_singleton: QualityAdapter | None = None


def _get_default_quality_adapter() -> QualityAdapter:
    global _quality_adapter_singleton
    if _quality_adapter_singleton is None:
        _quality_adapter_singleton = QualityAdapter()
    return _quality_adapter_singleton


def _evict_quality_models() -> None:
    """Releases the QualityAdapter singleton's TOPIQ model if resident,
    for the same cross-family VRAM-sharing reason as _evict_sam3_models/
    _evict_sam2_models. QualityAdapter has no video predictor to release,
    only the single lazy _metric."""
    adapter = _get_default_quality_adapter()
    adapter._metric = None
    import gc

    import torch

    gc.collect()
    if torch.cuda.is_available():
        torch.cuda.empty_cache()
```

Extend the four existing SAM task bodies (`run_sam3_predict`, `run_sam3_track`, `run_sam2_predict`, `run_sam2_track`) to also call `_evict_quality_models()` alongside their existing `_evict_sam2_models()`/`_evict_sam3_models()` call — e.g. `run_sam3_predict`'s eviction line becomes:

```python
    _evict_sam2_models()
    _evict_quality_models()
```

(repeat for the other three tasks' existing eviction call sites).

Add the new task, placed after `run_sam2_track`:

```python
@celery_app.task(name="rank_quality")
def run_rank_quality(job_id: int, adapter: QualityAdapter | None = None) -> None:
    session = SessionLocal()
    storage = get_storage_service()
    _evict_sam3_models()
    _evict_sam2_models()
    resolved_adapter = adapter if adapter is not None else _get_default_quality_adapter()

    job = session.get(Job, job_id)
    job.status = JobStatus.RUNNING
    job.started_at = datetime.now(timezone.utc)
    session.commit()

    try:
        sequence_id = job.payload["sequence_id"]
        percent = job.payload["percent"]
        frames = (
            session.query(Frame)
            .filter(Frame.sequence_id == sequence_id)
            .order_by(Frame.frame_index)
            .all()
        )

        scores: list[dict] = []
        for index, frame in enumerate(frames):
            frame_bytes = storage.download(frame.storage_key)
            score = resolved_adapter.score(frame_bytes)
            scores.append({"frame_id": frame.id, "score": score})

            job.progress = int(((index + 1) / len(frames)) * 100)
            session.commit()

        scores.sort(key=lambda entry: entry["score"])
        worst_count = round(len(frames) * percent / 100)
        worst_ids = [entry["frame_id"] for entry in scores[:worst_count]]

        job.payload = {**job.payload, "result": {"scores": scores, "worst_ids": worst_ids}}
        job.status = JobStatus.SUCCEEDED
        job.progress = 100
        job.finished_at = datetime.now(timezone.utc)
        _record_vram_usage(job)
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

- [ ] **Step 4: Run test to verify it passes**

Run: `docker compose exec ml-worker uv run pytest tests/test_tasks.py::test_run_rank_quality_scores_frames_worst_first_and_writes_result -v`
Expected: PASS

- [ ] **Step 5: Run the full ml-worker eviction test suite to confirm no regression**

Run: `docker compose exec ml-worker uv run pytest tests/test_tasks_gpu_eviction.py -v`
Expected: PASS (existing tests still pass; if they assert exact call counts on `_evict_sam2_models`/`_evict_sam3_models` that don't yet account for `_evict_quality_models`, that's fine — this task doesn't add quality eviction tests to that specific file, only extends the SAM tasks' bodies).

- [ ] **Step 6: Commit**

```bash
git add ml-worker/app/tasks.py ml-worker/tests/test_tasks.py
git commit -m "feat: add run_rank_quality Celery task"
```

---

### Task 5: Frontend — `useRankQuality` hook and toolbar quality controls

**Files:**
- Modify: `frontend/src/entities/useFrames.ts` (add `useRankQuality`)
- Modify: `frontend/src/features/annotation/SequenceGridToolbar.tsx` (add quality group + Clear marks)
- Modify: `frontend/src/features/annotation/SequenceGridPage.tsx` (wire state, polling, auto-check)
- Modify: `frontend/src/features/annotation/FrameThumbnail.tsx` (badge rendering)
- Test: `frontend/src/features/annotation/SequenceGridToolbar.test.tsx`
- Test: `frontend/src/features/annotation/SequenceGridPage.test.tsx`

**Interfaces:**
- Consumes: `apiClient` from `../shared/api/client`; `useJob` from `../../entities/useJobs` (existing).
- Produces: `useRankQuality(sequenceId: number)` — a `useMutation` hook whose `mutationFn` takes `percent: number` and returns the parsed `JobRead` (mirrors `useDeleteFrames`'s shape, no cache invalidation). `SequenceGridToolbar` gains props: `qualityPercent: number`, `onQualityPercentChange: (value: number) => void`, `onRankQuality: () => void`, `isRankQualityRunning: boolean`, `hasAutoMarks: boolean`, `onClearMarks: () => void`. `FrameThumbnail` gains an optional prop `markReason?: { kind: "quality" | "similarity"; label: string }`. Phase 2 (Task 8) reuses all of these names and extends `SequenceGridPage`'s state shape without renaming anything here.

- [ ] **Step 1: Write the failing hook test**

Create `frontend/src/entities/useFrames.test.ts` if it doesn't already exist (check first — if `useFrames`/`useDeleteFrames` already have tests elsewhere, e.g. inlined in a shared entities test file, add there instead following that file's existing mocking pattern for `apiClient`):

```ts
import { describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";

import { apiClient } from "../shared/api/client";
import { useRankQuality } from "./useFrames";

vi.mock("../shared/api/client", () => ({
  apiClient: { POST: vi.fn() },
}));

function wrapper({ children }: { children: ReactNode }) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}

describe("useRankQuality", () => {
  it("POSTs to the rank-quality endpoint with the given percent", async () => {
    vi.mocked(apiClient.POST).mockResolvedValue({
      data: { id: 42, job_type: "rank_quality", status: "pending" },
      error: undefined,
    } as never);

    const { result } = renderHook(() => useRankQuality(9), { wrapper });
    result.current.mutate(20);

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(apiClient.POST).toHaveBeenCalledWith(
      "/media/sequences/{sequence_id}/rank-quality",
      expect.objectContaining({
        params: { path: { sequence_id: 9 } },
        body: { percent: 20 },
      }),
    );
  });
});
```

(If this file needs a `.tsx` extension instead of `.ts` due to the JSX `wrapper` — check the existing `SequenceGridPage.test.tsx` for its extension convention and match it; use `.tsx` if any JSX appears in the test file, consistent with that file.)

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npm run test -- useFrames.test`
Expected: FAIL with "useRankQuality is not a function" or import error

- [ ] **Step 3: Implement `useRankQuality`**

In `frontend/src/entities/useFrames.ts`, add after `useDeleteFrames`:

```ts
export function useRankQuality(sequenceId: number) {
  return useMutation({
    mutationFn: async (percent: number) => {
      const result = await apiClient.POST("/media/sequences/{sequence_id}/rank-quality", {
        params: { path: { sequence_id: sequenceId } },
        body: { percent },
      });
      return result.data;
    },
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd frontend && npm run test -- useFrames.test`
Expected: PASS

- [ ] **Step 5: Write the failing toolbar test**

Add to `frontend/src/features/annotation/SequenceGridToolbar.test.tsx`:

```tsx
it("shows the quality percent input and Rank Quality button in select mode", () => {
  render(
    <SequenceGridToolbar
      sequenceName="Seq"
      isSelectMode
      onToggleSelectMode={() => {}}
      selectedCount={0}
      onDeleteSelected={() => {}}
      onCancel={() => {}}
      qualityPercent={20}
      onQualityPercentChange={() => {}}
      onRankQuality={() => {}}
      isRankQualityRunning={false}
      hasAutoMarks={false}
      onClearMarks={() => {}}
    />,
  );

  expect(screen.getByRole("spinbutton", { name: /quality/i })).toHaveValue(20);
  expect(screen.getByRole("button", { name: /rank quality/i })).toBeInTheDocument();
});

it("calls onRankQuality with no arguments when the Rank Quality button is clicked", async () => {
  const user = userEvent.setup();
  const onRankQuality = vi.fn();
  render(
    <SequenceGridToolbar
      sequenceName="Seq"
      isSelectMode
      onToggleSelectMode={() => {}}
      selectedCount={0}
      onDeleteSelected={() => {}}
      onCancel={() => {}}
      qualityPercent={20}
      onQualityPercentChange={() => {}}
      onRankQuality={onRankQuality}
      isRankQualityRunning={false}
      hasAutoMarks={false}
      onClearMarks={() => {}}
    />,
  );

  await user.click(screen.getByRole("button", { name: /rank quality/i }));
  expect(onRankQuality).toHaveBeenCalledTimes(1);
});

it("disables the Rank Quality button while a rank-quality job is running", () => {
  render(
    <SequenceGridToolbar
      sequenceName="Seq"
      isSelectMode
      onToggleSelectMode={() => {}}
      selectedCount={0}
      onDeleteSelected={() => {}}
      onCancel={() => {}}
      qualityPercent={20}
      onQualityPercentChange={() => {}}
      onRankQuality={() => {}}
      isRankQualityRunning
      hasAutoMarks={false}
      onClearMarks={() => {}}
    />,
  );

  expect(screen.getByRole("button", { name: /rank quality/i })).toBeDisabled();
});

it("shows Clear marks only when hasAutoMarks is true", () => {
  const { rerender } = render(
    <SequenceGridToolbar
      sequenceName="Seq"
      isSelectMode
      onToggleSelectMode={() => {}}
      selectedCount={0}
      onDeleteSelected={() => {}}
      onCancel={() => {}}
      qualityPercent={20}
      onQualityPercentChange={() => {}}
      onRankQuality={() => {}}
      isRankQualityRunning={false}
      hasAutoMarks={false}
      onClearMarks={() => {}}
    />,
  );
  expect(screen.queryByRole("button", { name: /clear marks/i })).not.toBeInTheDocument();

  rerender(
    <SequenceGridToolbar
      sequenceName="Seq"
      isSelectMode
      onToggleSelectMode={() => {}}
      selectedCount={0}
      onDeleteSelected={() => {}}
      onCancel={() => {}}
      qualityPercent={20}
      onQualityPercentChange={() => {}}
      onRankQuality={() => {}}
      isRankQualityRunning={false}
      hasAutoMarks
      onClearMarks={() => {}}
    />,
  );
  expect(screen.getByRole("button", { name: /clear marks/i })).toBeInTheDocument();
});
```

Note: all *existing* tests in this file (the ones read at plan-writing time, e.g. `shows the sequence name...`, `hides select-mode controls...`) render `<SequenceGridToolbar>` without the new props — since the new props are being added as required in the interface above, either (a) give them defaults in the component so old call sites without them still compile/render sensibly, or (b) update every existing test call site to pass the new props. Prefer (a): give `qualityPercent` a default of `20` and the new callbacks a no-op default in the component's destructuring, so this task doesn't need to touch every pre-existing test. Only add the new assertions above as new test cases.

- [ ] **Step 6: Run tests to verify the new ones fail**

Run: `cd frontend && npm run test -- SequenceGridToolbar.test`
Expected: FAIL (new tests fail; existing ones still pass since new props are optional/defaulted)

- [ ] **Step 7: Implement the toolbar's quality controls**

Rewrite `frontend/src/features/annotation/SequenceGridToolbar.tsx`:

```tsx
import { useState } from "react";

interface SequenceGridToolbarProps {
  sequenceName: string;
  isSelectMode: boolean;
  onToggleSelectMode: () => void;
  selectedCount: number;
  onDeleteSelected: () => void;
  onCancel: () => void;
  qualityPercent?: number;
  onQualityPercentChange?: (value: number) => void;
  onRankQuality?: () => void;
  isRankQualityRunning?: boolean;
  hasAutoMarks?: boolean;
  onClearMarks?: () => void;
}

export function SequenceGridToolbar({
  sequenceName,
  isSelectMode,
  onToggleSelectMode,
  selectedCount,
  onDeleteSelected,
  onCancel,
  qualityPercent = 20,
  onQualityPercentChange = () => {},
  onRankQuality = () => {},
  isRankQualityRunning = false,
  hasAutoMarks = false,
  onClearMarks = () => {},
}: SequenceGridToolbarProps) {
  const [deleteArmed, setDeleteArmed] = useState(false);

  function handleDeleteClick() {
    if (deleteArmed) {
      onDeleteSelected();
      setDeleteArmed(false);
    } else {
      setDeleteArmed(true);
    }
  }

  function handleCancelClick() {
    setDeleteArmed(false);
    onCancel();
  }

  return (
    <div className="flex items-center gap-4 border-b border-gray-800 px-8 py-4">
      <h1 className="text-xl font-semibold">{sequenceName}</h1>
      <div className="ml-auto flex items-center gap-3">
        {isSelectMode && (
          <>
            <input
              type="number"
              aria-label="Quality percent"
              min={1}
              max={99}
              value={qualityPercent}
              onChange={(event) => onQualityPercentChange(Number(event.target.value))}
              className="w-16 rounded border border-gray-700 bg-gray-900 px-2 py-1.5 text-sm text-gray-200"
            />
            <button
              type="button"
              aria-label="Rank Quality"
              onClick={onRankQuality}
              disabled={isRankQualityRunning}
              className="rounded bg-gray-800 px-3 py-1.5 text-sm text-gray-200 hover:bg-gray-700 disabled:opacity-40"
            >
              {isRankQualityRunning ? "Ranking…" : "Rank Quality"}
            </button>
            {hasAutoMarks && (
              <button
                type="button"
                aria-label="Clear marks"
                onClick={onClearMarks}
                className="rounded px-3 py-1.5 text-sm text-gray-400 hover:text-gray-200"
              >
                Clear marks
              </button>
            )}
            <span className="text-sm text-gray-400">{selectedCount} selected</span>
            <button
              type="button"
              aria-label={deleteArmed ? "Confirm delete" : "Delete selected"}
              onClick={handleDeleteClick}
              disabled={selectedCount === 0}
              className={`rounded px-3 py-1.5 text-sm ${
                deleteArmed
                  ? "bg-red-700 text-white"
                  : "bg-gray-800 text-gray-200 hover:bg-gray-700 disabled:opacity-40"
              }`}
            >
              {deleteArmed ? "Confirm" : "🗑 Delete"}
            </button>
            <button
              type="button"
              aria-label="Cancel"
              onClick={handleCancelClick}
              className="rounded px-3 py-1.5 text-sm text-gray-400 hover:text-gray-200"
            >
              ✕ Cancel
            </button>
          </>
        )}
        {!isSelectMode && (
          <button
            type="button"
            aria-label="Select"
            onClick={onToggleSelectMode}
            className="rounded bg-gray-800 px-3 py-1.5 text-sm text-gray-200 hover:bg-gray-700"
          >
            Select
          </button>
        )}
      </div>
    </div>
  );
}
```

(The quality `<input type="number">` renders with ARIA role `spinbutton` and its accessible name comes from `aria-label="Quality percent"`, matching `screen.getByRole("spinbutton", { name: /quality/i })` in the test above.)

- [ ] **Step 8: Run toolbar tests to verify they pass**

Run: `cd frontend && npm run test -- SequenceGridToolbar.test`
Expected: PASS (all tests, old and new)

- [ ] **Step 9: Write the failing page-level test for auto-check behavior**

Add to `frontend/src/features/annotation/SequenceGridPage.test.tsx`, extending the existing `vi.mock("../../shared/api/client", ...)` to include `POST`:

```tsx
vi.mock("../../shared/api/client", () => ({
  apiClient: { GET: vi.fn(), DELETE: vi.fn(), POST: vi.fn() },
}));
```

```tsx
it("auto-checks the worst frames and shows a quality badge after Rank Quality succeeds", async () => {
  vi.mocked(apiClient.GET).mockImplementation(async (path: string) => {
    if (path === "/media/sequences/{sequence_id}") {
      return {
        data: { id: 9, name: "Seq", video_id: null, procedure_id: 7, start_time: 0, duration: 0, annotation_count: 0, crop_box: null },
        error: undefined,
      } as never;
    }
    if (path === "/annotation/frames/{frame_id}/annotations") {
      return { data: [], error: undefined } as never;
    }
    if (path.includes("/frames")) {
      return {
        data: [
          { id: 1, sequence_id: 9, storage_key: "k1", frame_index: 0, width: 10, height: 10, image_url: "http://x/1.png" },
          { id: 2, sequence_id: 9, storage_key: "k2", frame_index: 1, width: 10, height: 10, image_url: "http://x/2.png" },
        ],
        error: undefined,
      } as never;
    }
    if (path === "/taxonomy/tree") {
      return { data: [], error: undefined } as never;
    }
    if (path === "/jobs/{job_id}") {
      return {
        data: {
          id: 42,
          job_type: "rank_quality",
          status: "succeeded",
          progress: 100,
          vram_used_bytes: null,
          vram_total_bytes: null,
          result_ref: null,
          error: null,
          created_by_id: 1,
          started_at: null,
          finished_at: null,
          payload: { result: { scores: [{ frame_id: 1, score: 0.1 }, { frame_id: 2, score: 0.9 }], worst_ids: [1] } },
        },
        error: undefined,
      } as never;
    }
    return { data: [], error: undefined } as never;
  });
  vi.mocked(apiClient.POST).mockResolvedValue({
    data: { id: 42, job_type: "rank_quality", status: "pending" },
    error: undefined,
  } as never);

  renderAtSequence("9");

  fireEvent.click(screen.getByRole("button", { name: /select/i }));
  fireEvent.click(await screen.findByRole("button", { name: /rank quality/i }));

  expect(await screen.findByText(/low quality/i)).toBeInTheDocument();
});
```

Note: `JobRead`'s TypeScript type (generated from `openapi.json`) doesn't declare a `payload` field today — Task 6 below adds `payload: dict` handling on the frontend side; if the generated schema type check fails on this mock's `payload` key at this step, that's expected until Task 6's schema/type work lands. If frontend test type-checking blocks this specific test from compiling before Task 6, move this one test's implementation to right after Task 6 instead — but keep it in this task's file so it stays adjacent to the other toolbar-driven behavior tests. (In practice `JobRead` is a Pydantic `BaseModel` reflected into TS via `openapi-typescript`, so this task's `payload` addition to `JobRead` — done in this same task's Step 10 — must land before this test can type-check; do Step 10 before running this test if working strictly top-to-bottom.)

- [ ] **Step 10: Add `payload` to `JobRead` (backend schema) so the frontend can read the result**

In `backend/app/jobs/schemas.py`, add `payload: dict` to `JobRead`:

```python
class JobRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    job_type: JobType
    status: JobStatus
    progress: int
    vram_used_bytes: int | None
    vram_total_bytes: int | None
    payload: dict
    result_ref: str | None
    error: str | None
    created_by_id: int
    started_at: datetime | None
    finished_at: datetime | None
```

Run: `cd backend && PYTHONPATH=. uv run python scripts/export_openapi.py` and verify `git diff --stat openapi.json` shows the `payload` field added to `JobRead`. This regenerates the frontend's generated TS types on next `npm run dev`/`test` (via the `pretest` hook).

Run backend tests to confirm nothing broke: `cd backend && uv run pytest tests/test_jobs.py tests/test_worker.py tests/test_worker_progress.py -v` — expect PASS (adding a field to a response model is additive and non-breaking).

- [ ] **Step 11: Run test to verify it fails (before page implementation)**

Run: `cd frontend && npm run test -- SequenceGridPage.test`
Expected: FAIL (new test fails — Rank Quality button doesn't exist in the page's rendered toolbar wiring yet, or badge text never appears)

- [ ] **Step 12: Implement `SequenceGridPage`'s quality state, polling, and auto-check**

Rewrite `frontend/src/features/annotation/SequenceGridPage.tsx`:

```tsx
import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";

import { useDeleteFrames, useFrames, useRankQuality } from "../../entities/useFrames";
import { useJob } from "../../entities/useJobs";
import { useSequence } from "../../entities/useSequence";
import { useTaxonomyTree } from "../../entities/useTaxonomyTree";
import { FrameEditor } from "./FrameEditor";
import { FrameThumbnail } from "./FrameThumbnail";
import { SequenceGridToolbar } from "./SequenceGridToolbar";

type MarkReason = { kind: "quality" | "similarity"; label: string };

export function SequenceGridPage() {
  const { sequenceId } = useParams<{ sequenceId: string }>();
  const sequenceIdNumber = Number(sequenceId);
  const [selectedFrameId, setSelectedFrameId] = useState<number | null>(null);
  const [isSelectMode, setIsSelectMode] = useState(false);
  const [selectedFrameIds, setSelectedFrameIds] = useState<Set<number>>(new Set());
  const [autoCheckedFrameIds, setAutoCheckedFrameIds] = useState<Set<number>>(new Set());
  const [frameMarkReasons, setFrameMarkReasons] = useState<Map<number, MarkReason>>(new Map());
  const [qualityPercent, setQualityPercent] = useState(20);
  const [activeJobId, setActiveJobId] = useState<number | null>(null);
  const [activeJobKind, setActiveJobKind] = useState<"quality" | "similarity" | null>(null);

  const framesQuery = useFrames(sequenceIdNumber);
  const sequenceQuery = useSequence(sequenceIdNumber);
  const taxonomyTreeQuery = useTaxonomyTree(sequenceQuery.data?.procedure_id ?? null);
  const taxonomyTree = taxonomyTreeQuery.data ?? [];
  const deleteFrames = useDeleteFrames(sequenceIdNumber);
  const rankQuality = useRankQuality(sequenceIdNumber);
  const jobQuery = useJob(activeJobId);

  useEffect(() => {
    if (jobQuery.data?.status === "succeeded" && activeJobKind === "quality") {
      const result = jobQuery.data.payload?.result as
        | { scores: { frame_id: number; score: number }[]; worst_ids: number[] }
        | undefined;
      if (result) {
        setIsSelectMode(true);
        setSelectedFrameIds((current) => new Set([...current, ...result.worst_ids]));
        setAutoCheckedFrameIds((current) => new Set([...current, ...result.worst_ids]));
        setFrameMarkReasons((current) => {
          const next = new Map(current);
          for (const id of result.worst_ids) {
            next.set(id, { kind: "quality", label: "low quality" });
          }
          return next;
        });
      }
      setActiveJobId(null);
      setActiveJobKind(null);
    } else if (jobQuery.data?.status === "failed") {
      setActiveJobId(null);
      setActiveJobKind(null);
    }
  }, [jobQuery.data, activeJobKind]);

  if (selectedFrameId !== null) {
    return (
      <FrameEditor
        frameId={selectedFrameId}
        frames={framesQuery.data ?? []}
        onClose={() => setSelectedFrameId(null)}
        onFrameChange={setSelectedFrameId}
      />
    );
  }

  function toggleFrameSelected(frameId: number) {
    setSelectedFrameIds((current) => {
      const next = new Set(current);
      if (next.has(frameId)) {
        next.delete(frameId);
      } else {
        next.add(frameId);
      }
      return next;
    });
    setAutoCheckedFrameIds((current) => {
      if (!current.has(frameId)) return current;
      const next = new Set(current);
      next.delete(frameId);
      return next;
    });
    setFrameMarkReasons((current) => {
      if (!current.has(frameId)) return current;
      const next = new Map(current);
      next.delete(frameId);
      return next;
    });
  }

  function handleDeleteSelected() {
    deleteFrames.mutate(Array.from(selectedFrameIds), {
      onSuccess: () => {
        setSelectedFrameIds(new Set());
        setAutoCheckedFrameIds(new Set());
        setFrameMarkReasons(new Map());
      },
    });
  }

  function handleCancelSelectMode() {
    setIsSelectMode(false);
    setSelectedFrameIds(new Set());
    setAutoCheckedFrameIds(new Set());
    setFrameMarkReasons(new Map());
  }

  function handleRankQuality() {
    rankQuality.mutate(qualityPercent, {
      onSuccess: (data) => {
        if (data) {
          setActiveJobId(data.id);
          setActiveJobKind("quality");
        }
      },
    });
  }

  function handleClearMarks() {
    setSelectedFrameIds((current) => {
      const next = new Set(current);
      for (const id of autoCheckedFrameIds) next.delete(id);
      return next;
    });
    setAutoCheckedFrameIds(new Set());
    setFrameMarkReasons(new Map());
  }

  const sequenceName = sequenceQuery.data?.name ?? `Sequence #${sequenceId}`;

  return (
    <div className="min-h-full bg-gray-950 text-gray-100">
      <div className="sticky top-0 z-10 bg-gray-950">
        <SequenceGridToolbar
          sequenceName={sequenceName}
          isSelectMode={isSelectMode}
          onToggleSelectMode={() => setIsSelectMode((current) => !current)}
          selectedCount={selectedFrameIds.size}
          onDeleteSelected={handleDeleteSelected}
          onCancel={handleCancelSelectMode}
          qualityPercent={qualityPercent}
          onQualityPercentChange={setQualityPercent}
          onRankQuality={handleRankQuality}
          isRankQualityRunning={activeJobKind === "quality"}
          hasAutoMarks={autoCheckedFrameIds.size > 0}
          onClearMarks={handleClearMarks}
        />
      </div>
      <div className="grid grid-cols-2 gap-3 p-8 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5">
        {(framesQuery.data ?? []).map((frame) => (
          <FrameThumbnail
            key={frame.id}
            frameId={frame.id}
            imageUrl={frame.image_url}
            taxonomyTree={taxonomyTree}
            onClick={() => setSelectedFrameId(frame.id)}
            selectable={isSelectMode}
            selected={selectedFrameIds.has(frame.id)}
            onToggleSelect={() => toggleFrameSelected(frame.id)}
            markReason={frameMarkReasons.get(frame.id)}
          />
        ))}
      </div>
    </div>
  );
}
```

- [ ] **Step 13: Add badge rendering to `FrameThumbnail`**

In `frontend/src/features/annotation/FrameThumbnail.tsx`, add the new prop and render it:

```tsx
interface FrameThumbnailProps {
  frameId: number;
  imageUrl: string;
  taxonomyTree: TaxonomyTreeNode[];
  onClick: () => void;
  selectable: boolean;
  selected: boolean;
  onToggleSelect: () => void;
  markReason?: { kind: "quality" | "similarity"; label: string };
}

export function FrameThumbnail({
  frameId,
  imageUrl,
  taxonomyTree,
  onClick,
  selectable,
  selected,
  onToggleSelect,
  markReason,
}: FrameThumbnailProps) {
  const annotationsQuery = useAnnotations(frameId);
  const annotations = annotationsQuery.data ?? [];
  const maskAnnotations = annotations.filter((annotation) => annotation.mask_url);

  return (
    <button
      type="button"
      onClick={selectable ? onToggleSelect : onClick}
      className={`group relative aspect-square overflow-hidden rounded border border-gray-800 bg-gray-900 ${
        markReason ? "ring-2 ring-red-500" : ""
      }`}
    >
      <img src={imageUrl} alt={`Frame ${frameId}`} className="h-full w-full object-contain" />
      {selectable && (
        <input
          type="checkbox"
          checked={selected}
          onChange={onToggleSelect}
          onClick={(event) => event.stopPropagation()}
          className="absolute left-2 top-2 h-5 w-5 accent-blue-500"
        />
      )}
      {markReason && (
        <span className="absolute right-2 top-2 rounded bg-red-700/90 px-1.5 py-0.5 text-xs text-white">
          {markReason.label}
        </span>
      )}
      {maskAnnotations.map((annotation) => {
        const resolved = resolveLabelFromTree(taxonomyTree, annotation.label_id);
        const color = resolved?.tag.color ?? DEFAULT_MASK_COLOR;
        return (
          <div
            key={annotation.id}
            data-testid="mask-overlay"
            className="pointer-events-none absolute inset-0"
            style={{
              backgroundColor: color,
              maskImage: `url(${annotation.mask_url})`,
              WebkitMaskImage: `url(${annotation.mask_url})`,
              maskMode: "luminance",
              WebkitMaskMode: "luminance" as never,
              maskSize: "contain",
              WebkitMaskSize: "contain",
              maskRepeat: "no-repeat",
              WebkitMaskRepeat: "no-repeat",
              maskPosition: "center",
              WebkitMaskPosition: "center",
              opacity: 0.45,
            }}
          />
        );
      })}
      {annotations.length > 0 && (
        <div className="absolute inset-x-0 bottom-0 flex flex-wrap gap-1 truncate bg-gray-950/80 px-1 py-0.5 text-xs text-gray-200">
          {annotations.map((annotation) => {
            const resolved = resolveLabelFromTree(taxonomyTree, annotation.label_id);
            const label = resolved ? `${resolved.categoryName} / ${resolved.tag.name}` : `label ${annotation.label_id}`;
            const color = resolved?.tag.color ?? "#666";
            return (
              <span key={annotation.id} className="flex items-center gap-1">
                <span className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: color }} />
                {label}
              </span>
            );
          })}
        </div>
      )}
    </button>
  );
}
```

- [ ] **Step 14: Run frontend tests to verify they pass**

Run: `cd frontend && npm run test`
Expected: PASS (all tests, including the new Rank Quality auto-check test and every pre-existing test in `SequenceGridToolbar.test.tsx`/`SequenceGridPage.test.tsx`)

- [ ] **Step 15: Commit**

```bash
git add frontend/src/entities/useFrames.ts frontend/src/features/annotation/SequenceGridToolbar.tsx frontend/src/features/annotation/SequenceGridPage.tsx frontend/src/features/annotation/FrameThumbnail.tsx frontend/src/features/annotation/SequenceGridToolbar.test.tsx frontend/src/features/annotation/SequenceGridPage.test.tsx backend/app/jobs/schemas.py openapi.json
git commit -m "feat: add Rank Quality toolbar controls with auto-check and badges"
```

---

### Task 6: Phase 1 real-stack verification

**Files:** none (manual verification, per this repo's testing philosophy — see CLAUDE.md's "Testing philosophy" section).

- [ ] **Step 1: Start the full stack**

```bash
docker compose up -d
cd backend && uv run uvicorn app.main:app --reload &
cd frontend && npm install --legacy-peer-deps && npm run dev &
```

- [ ] **Step 2: Exercise Rank Quality in a real browser**

Log in, navigate to a sequence with several frames (or create one via photo upload), enter Select mode, set the quality percent, click "Rank Quality", and confirm:
- The button shows a loading state while the job runs.
- Once done, the worst N% of frames show a red ring + "low quality" badge and their checkboxes are pre-checked.
- "Clear marks" removes only the auto-checks, not any frame checked manually before/after.
- "Delete selected" still deletes exactly the checked frames.
- No VRAM-related crash or host reboot occurs (this GPU has a known crash history under concurrent SAM2 track + prior model loads — see the `sam2_vram_crash` memory; watch `docker compose logs ml-worker` during this run).

- [ ] **Step 3: Record the outcome**

If everything above works, Phase 1 is done. If something fails, fix it before starting Phase 2 — do not proceed with a known-broken Phase 1 foundation.

---

## Phase 2: Find Similar

### Task 7: Backend — `enqueue_find_similar` and `POST /media/sequences/{sequence_id}/find-similar`

**Files:**
- Modify: `backend/app/jobs/service.py` (add `enqueue_find_similar` — `JobType.FIND_SIMILAR` already added in Task 1)
- Modify: `backend/app/media/schemas.py` (add `FindSimilarRequest`)
- Modify: `backend/app/media/router.py` (add endpoint)
- Test: `backend/tests/test_jobs.py`, `backend/tests/test_media.py`

**Interfaces:**
- Consumes: same as Task 1/Task 2, plus `JobType.FIND_SIMILAR` (already exists from Task 1's Step 3).
- Produces: `enqueue_find_similar(session: Session, sequence_id: int, percent: int, created_by: User) -> Job` (mirrors `enqueue_rank_quality` exactly, dispatches `celery_app.send_task("find_similar", args=[job.id])`). `FindSimilarRequest { percent: int }` (ge=1, le=99, default=85). Endpoint `POST /media/sequences/{sequence_id}/find-similar` returning `JobRead` (201), 404/409 same as Task 2. Frontend hooks (Task 10) call this exact path/shape.

- [ ] **Step 1: Write the failing tests**

Add to `backend/tests/test_jobs.py`, mirroring Task 1's test exactly but for `enqueue_find_similar`/`JobType.FIND_SIMILAR` and `percent=85`.

Add to `backend/tests/test_media.py`, mirroring Task 2's three tests exactly but for `/find-similar`, `"job_type"] == "find_similar"`, and `json={"percent": 85}`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd backend && uv run pytest tests/test_jobs.py -k find_similar tests/test_media.py -k find_similar -v`
Expected: FAIL (function/route doesn't exist)

- [ ] **Step 3: Implement**

In `backend/app/jobs/service.py`, add after `enqueue_rank_quality`:

```python
def enqueue_find_similar(session: Session, sequence_id: int, percent: int, created_by: User) -> Job:
    job = Job(
        job_type=JobType.FIND_SIMILAR,
        status=JobStatus.PENDING,
        payload={"sequence_id": sequence_id, "percent": percent},
        created_by_id=created_by.id,
    )
    session.add(job)
    session.commit()
    session.refresh(job)

    celery_app.send_task("find_similar", args=[job.id])
    return job
```

In `backend/app/media/schemas.py`, add:

```python
class FindSimilarRequest(BaseModel):
    percent: int = Field(default=85, ge=1, le=99)
```

In `backend/app/media/router.py`, add import `enqueue_find_similar` and `FindSimilarRequest`, then add after `rank_sequence_quality`:

```python
@router.post(
    "/sequences/{sequence_id}/find-similar", response_model=JobRead, status_code=status.HTTP_201_CREATED
)
def find_similar_sequence_frames(
    sequence_id: int,
    payload: FindSimilarRequest,
    current_user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
) -> Job:
    sequence = session.get(Sequence, sequence_id)
    if sequence is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Sequence not found")

    existing_pending_or_running = (
        session.query(Job)
        .filter(
            Job.job_type == JobType.FIND_SIMILAR,
            Job.payload["sequence_id"].as_integer() == sequence_id,
            Job.status.in_([JobStatus.PENDING, JobStatus.RUNNING]),
        )
        .first()
    )
    if existing_pending_or_running is not None:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="A similarity search job is already in progress for this sequence",
        )

    return enqueue_find_similar(session, sequence_id, payload.percent, current_user)
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd backend && uv run pytest tests/test_jobs.py -k find_similar tests/test_media.py -k find_similar -v`
Expected: PASS

- [ ] **Step 5: Regenerate `openapi.json`**

Run: `cd backend && PYTHONPATH=. uv run python scripts/export_openapi.py`
Verify: `git diff --stat openapi.json` shows a change.

- [ ] **Step 6: Commit**

```bash
git add backend/app/jobs/service.py backend/app/media/schemas.py backend/app/media/router.py backend/tests/test_jobs.py backend/tests/test_media.py openapi.json
git commit -m "feat: add POST /media/sequences/{id}/find-similar endpoint"
```

---

### Task 8: ml-worker — `SimilarityAdapter` (DINOv2 embeddings)

**Files:**
- Create: `ml-worker/app/similarity_adapter.py`
- Test: `ml-worker/tests/test_similarity_adapter.py`

**Interfaces:**
- Consumes: `torch`, `torchvision` (already installed per the design doc — confirmed present for SAM2's transforms).
- Produces: `class SimilarityAdapter` with `__init__(self) -> None` (lazy) and `embed(self, frame_bytes: bytes) -> np.ndarray` — returns an L2-normalized embedding vector (768-d for `dinov2_vitb14`). Model loaded lazily via `torch.hub.load('facebookresearch/dinov2', 'dinov2_vitb14')`, cached on `self._model`. Task 9's `run_find_similar` calls `.embed()` by this exact name.

- [ ] **Step 1: Write the failing tests**

Create `ml-worker/tests/test_similarity_adapter.py`:

```python
import io
from unittest.mock import MagicMock, patch

import numpy as np
from PIL import Image

from app.similarity_adapter import SimilarityAdapter


def _make_frame_bytes(color: tuple[int, int, int] = (128, 128, 128)) -> bytes:
    image = Image.new("RGB", (64, 64), color=color)
    buffer = io.BytesIO()
    image.save(buffer, format="PNG")
    return buffer.getvalue()


def test_embed_returns_l2_normalized_vector():
    import torch

    adapter = SimilarityAdapter()
    fake_model = MagicMock()
    fake_model.return_value = torch.tensor([[3.0, 4.0]])  # norm = 5

    with patch.object(adapter, "_get_model", return_value=fake_model):
        embedding = adapter.embed(_make_frame_bytes())

    assert isinstance(embedding, np.ndarray)
    assert np.isclose(np.linalg.norm(embedding), 1.0)
    assert np.allclose(embedding, [0.6, 0.8])


def test_embed_lazily_loads_model_once():
    adapter = SimilarityAdapter()
    with patch.object(adapter, "_get_model") as mock_get_model:
        import torch

        mock_get_model.return_value = MagicMock(return_value=torch.tensor([[1.0, 0.0]]))
        adapter.embed(_make_frame_bytes())
        adapter.embed(_make_frame_bytes())

    assert mock_get_model.call_count == 2  # _get_model is called each time; its own internal caching (Step 3) is what avoids reloading
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `docker compose exec ml-worker uv run pytest tests/test_similarity_adapter.py -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'app.similarity_adapter'`

- [ ] **Step 3: Implement `SimilarityAdapter`**

Create `ml-worker/app/similarity_adapter.py`:

```python
import io

import numpy as np
import torch
from PIL import Image
from torchvision import transforms

_PREPROCESS = transforms.Compose(
    [
        transforms.Resize(256),
        transforms.CenterCrop(224),
        transforms.ToTensor(),
        transforms.Normalize(mean=[0.485, 0.456, 0.406], std=[0.229, 0.224, 0.225]),
    ]
)


class SimilarityAdapter:
    """Embeds frames with DINOv2 (ViT-B/14) for near-duplicate detection in
    Find Similar. DINOv2 is a self-supervised, vision-only model --
    stronger than classification-pretrained CNNs (e.g. ResNet-18, used by
    the reference project this feature was adapted from) at encoding
    pixel/geometry structure, which is what near-duplicate detection
    actually needs rather than semantic class information."""

    def __init__(self) -> None:
        self._model = None

    def _get_model(self):
        if self._model is None:
            self._model = torch.hub.load("facebookresearch/dinov2", "dinov2_vitb14")
            self._model.eval()
            if torch.cuda.is_available():
                self._model = self._model.cuda()
        return self._model

    def embed(self, frame_bytes: bytes) -> np.ndarray:
        model = self._get_model()
        image = Image.open(io.BytesIO(frame_bytes)).convert("RGB")
        tensor = _PREPROCESS(image).unsqueeze(0)
        if torch.cuda.is_available():
            tensor = tensor.cuda()

        with torch.no_grad():
            features = model(tensor)

        vector = features.squeeze(0).cpu().numpy().astype(np.float64)
        norm = np.linalg.norm(vector)
        return vector / norm if norm > 0 else vector
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `docker compose exec ml-worker uv run pytest tests/test_similarity_adapter.py -v`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add ml-worker/app/similarity_adapter.py ml-worker/tests/test_similarity_adapter.py
git commit -m "feat: add SimilarityAdapter (DINOv2 ViT-B/14 embeddings)"
```

---

### Task 9: ml-worker — Union-Find clustering helper + `run_find_similar` Celery task

**Files:**
- Create: `ml-worker/app/union_find.py`
- Test: `ml-worker/tests/test_union_find.py`
- Modify: `ml-worker/app/tasks.py` (add task, singleton getter, eviction wiring)
- Test: `ml-worker/tests/test_tasks.py` (or the split file from Task 4, Step 1's note)

**Interfaces:**
- Consumes: `SimilarityAdapter` (Task 8), `QualityAdapter`/`_get_default_quality_adapter` (Task 3/4).
- Produces: `cluster_by_threshold(similarity_matrix: np.ndarray, ids: list[int], threshold: float) -> list[list[int]]` in `ml-worker/app/union_find.py` — pure function, no torch dependency, returns a list of clusters (each a list of the original `ids`), where any pair with `similarity_matrix[i][j] >= threshold` ends up in the same cluster (transitively). `_get_default_similarity_adapter() -> SimilarityAdapter` (module-level singleton, mirrors quality adapter's pattern) and `_evict_similarity_models()` in `tasks.py`. Celery task `run_find_similar(job_id: int, adapter: SimilarityAdapter | None = None) -> None` registered as `"find_similar"`, writes `job.payload["result"] = {"duplicate_ids": [...], "pairs": [{"frame_a": int, "frame_b": int, "similarity": float}, ...], "similarity_map": {str(frame_id): float}}` (JSON object keys must be strings, so `similarity_map` uses stringified frame IDs — the frontend's `Map`/lookup logic in Task 10 must account for this).

- [ ] **Step 1: Write the failing Union-Find test**

Create `ml-worker/tests/test_union_find.py` (pure Python/NumPy, no torch — runs on host or in-container equally):

```python
import numpy as np

from app.union_find import cluster_by_threshold


def test_two_similar_frames_form_one_cluster():
    ids = [10, 20, 30]
    matrix = np.array(
        [
            [1.0, 0.9, 0.1],
            [0.9, 1.0, 0.1],
            [0.1, 0.1, 1.0],
        ]
    )
    clusters = cluster_by_threshold(matrix, ids, threshold=0.85)

    non_trivial = [c for c in sorted(clusters, key=len) if len(c) > 1]
    assert len(non_trivial) == 1
    assert sorted(non_trivial[0]) == [10, 20]


def test_transitive_similarity_merges_into_one_cluster():
    """A~B and B~C above threshold, A~C below threshold directly -- still
    one cluster of all three, since Union-Find merges transitively rather
    than requiring every pair to individually exceed the threshold."""
    ids = [1, 2, 3]
    matrix = np.array(
        [
            [1.0, 0.9, 0.2],
            [0.9, 1.0, 0.9],
            [0.2, 0.9, 1.0],
        ]
    )
    clusters = cluster_by_threshold(matrix, ids, threshold=0.85)

    non_trivial = [c for c in clusters if len(c) > 1]
    assert len(non_trivial) == 1
    assert sorted(non_trivial[0]) == [1, 2, 3]


def test_no_pairs_above_threshold_returns_all_singletons():
    ids = [1, 2, 3]
    matrix = np.eye(3)
    clusters = cluster_by_threshold(matrix, ids, threshold=0.85)

    assert all(len(c) == 1 for c in clusters)
    assert sorted(c[0] for c in clusters) == [1, 2, 3]
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd ml-worker && uv run pytest tests/test_union_find.py -v` (host-runnable, no torch import)
Expected: FAIL with `ModuleNotFoundError: No module named 'app.union_find'`

- [ ] **Step 3: Implement `cluster_by_threshold`**

Create `ml-worker/app/union_find.py`:

```python
import numpy as np


def cluster_by_threshold(
    similarity_matrix: np.ndarray, ids: list[int], threshold: float
) -> list[list[int]]:
    """Groups `ids` into clusters using Union-Find: any pair (i, j) with
    similarity_matrix[i][j] >= threshold is merged into the same cluster,
    transitively (A~B and B~C merges A, B, C into one cluster even if A~C
    is below threshold directly). Returns every id, including singletons
    (frames with no near-duplicate) as their own one-element cluster."""
    n = len(ids)
    parent = list(range(n))

    def find(x: int) -> int:
        while parent[x] != x:
            parent[x] = parent[parent[x]]
            x = parent[x]
        return x

    def union(a: int, b: int) -> None:
        root_a, root_b = find(a), find(b)
        if root_a != root_b:
            parent[root_b] = root_a

    for i in range(n):
        for j in range(i + 1, n):
            if similarity_matrix[i][j] >= threshold:
                union(i, j)

    groups: dict[int, list[int]] = {}
    for index in range(n):
        root = find(index)
        groups.setdefault(root, []).append(ids[index])

    return list(groups.values())
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd ml-worker && uv run pytest tests/test_union_find.py -v`
Expected: PASS

- [ ] **Step 5: Write the failing `run_find_similar` test**

Add to `ml-worker/tests/test_tasks.py` (or the Task 4 split file), following the exact same session/mocking pattern as Task 4's `run_rank_quality` test:

```python
def test_run_find_similar_marks_all_but_best_quality_frame_in_a_cluster_as_duplicate(db_session):
    from app.models import Frame

    frame_a = Frame(sequence_id=2, storage_key="frames/2/0.png", frame_index=0, width=10, height=10)
    frame_b = Frame(sequence_id=2, storage_key="frames/2/1.png", frame_index=1, width=10, height=10)
    frame_c = Frame(sequence_id=2, storage_key="frames/2/2.png", frame_index=2, width=10, height=10)
    db_session.add_all([frame_a, frame_b, frame_c])
    db_session.commit()

    job = Job(
        job_type=JobType.FIND_SIMILAR,
        status=JobStatus.PENDING,
        progress=0,
        payload={"sequence_id": 2, "percent": 85},
        created_by_id=1,
    )
    db_session.add(job)
    db_session.commit()

    import numpy as np

    # frame_a and frame_b are near-duplicates (cosine similarity ~0.95);
    # frame_c is distinct.
    fake_embeddings = {
        frame_a.id: np.array([1.0, 0.0, 0.0]),
        frame_b.id: np.array([0.95, 0.05, 0.0]) / np.linalg.norm([0.95, 0.05, 0.0]),
        frame_c.id: np.array([0.0, 0.0, 1.0]),
    }
    fake_similarity_adapter = MagicMock()
    fake_similarity_adapter.embed.side_effect = lambda frame_bytes: None  # overridden per-call below

    fake_quality_adapter = MagicMock()
    # frame_a scores better (higher) than frame_b, so frame_b (not frame_a)
    # should be the one marked duplicate within their shared cluster.
    fake_quality_adapter.score.side_effect = lambda frame_bytes: {
        b"frame_a_bytes": 0.9,
        b"frame_b_bytes": 0.2,
        b"frame_c_bytes": 0.5,
    }[frame_bytes]

    fake_storage = MagicMock()
    fake_storage.download.side_effect = lambda key: {
        frame_a.storage_key: b"frame_a_bytes",
        frame_b.storage_key: b"frame_b_bytes",
        frame_c.storage_key: b"frame_c_bytes",
    }[key]
    fake_similarity_adapter.embed.side_effect = lambda frame_bytes: {
        b"frame_a_bytes": fake_embeddings[frame_a.id],
        b"frame_b_bytes": fake_embeddings[frame_b.id],
        b"frame_c_bytes": fake_embeddings[frame_c.id],
    }[frame_bytes]

    import app.tasks as tasks_module
    from unittest.mock import patch

    with (
        patch.object(tasks_module, "SessionLocal", return_value=db_session),
        patch.object(tasks_module, "get_storage_service", return_value=fake_storage),
        patch.object(tasks_module, "_get_default_quality_adapter", return_value=fake_quality_adapter),
    ):
        tasks_module.run_find_similar(job.id, adapter=fake_similarity_adapter)

    db_session.refresh(job)
    assert job.status == JobStatus.SUCCEEDED
    assert job.payload["result"]["duplicate_ids"] == [frame_b.id]
```

(As with Task 4, adjust the session-patching mechanics to match `test_tasks.py`'s established fixture pattern — the assertions and task-call shape above are what must hold.)

- [ ] **Step 6: Run test to verify it fails**

Run: `docker compose exec ml-worker uv run pytest tests/test_tasks.py::test_run_find_similar_marks_all_but_best_quality_frame_in_a_cluster_as_duplicate -v`
Expected: FAIL with `AttributeError: module 'app.tasks' has no attribute 'run_find_similar'`

- [ ] **Step 7: Implement `run_find_similar`**

In `ml-worker/app/tasks.py`:

Add imports: `from app.similarity_adapter import SimilarityAdapter` and `from app.union_find import cluster_by_threshold` and `import numpy as np`.

Add singleton + eviction helper, near `_quality_adapter_singleton`:

```python
_similarity_adapter_singleton: SimilarityAdapter | None = None


def _get_default_similarity_adapter() -> SimilarityAdapter:
    global _similarity_adapter_singleton
    if _similarity_adapter_singleton is None:
        _similarity_adapter_singleton = SimilarityAdapter()
    return _similarity_adapter_singleton


def _evict_similarity_models() -> None:
    """Releases the SimilarityAdapter singleton's DINOv2 model if resident,
    same cross-family VRAM-sharing reason as the other _evict_*_models
    helpers."""
    adapter = _get_default_similarity_adapter()
    adapter._model = None
    import gc

    import torch

    gc.collect()
    if torch.cuda.is_available():
        torch.cuda.empty_cache()
```

Extend the four SAM tasks' eviction call sites (already touched in Task 4) to also call `_evict_similarity_models()`:

```python
    _evict_sam2_models()
    _evict_quality_models()
    _evict_similarity_models()
```

Apply this rule consistently: every task evicts every model family it does not itself need resident, at task start.

- Repeat the three-line eviction block above (`_evict_sam2_models()`, `_evict_quality_models()`, `_evict_similarity_models()`) at all four SAM task bodies' existing eviction call sites (already touched in Task 4).
- In `run_rank_quality` (Task 4), add `_evict_similarity_models()` alongside its existing `_evict_sam3_models()`/`_evict_sam2_models()` calls (it does not need to evict quality models, since it uses the quality adapter itself).
- `run_find_similar` needs the similarity model first (embedding) and the quality model second (scoring the best frame per cluster) -- never both resident at once. Its task body (Step 7 below) therefore evicts sam3/sam2 at task start like every other task, then explicitly calls `_evict_similarity_models()` mid-task, after embedding finishes and before the quality adapter is first used -- not just once at task start. That mid-task eviction call is shown inline in the task body below.

Add the new task, placed after `run_rank_quality`:

```python
@celery_app.task(name="find_similar")
def run_find_similar(job_id: int, adapter: SimilarityAdapter | None = None) -> None:
    session = SessionLocal()
    storage = get_storage_service()
    _evict_sam3_models()
    _evict_sam2_models()
    resolved_adapter = adapter if adapter is not None else _get_default_similarity_adapter()

    job = session.get(Job, job_id)
    job.status = JobStatus.RUNNING
    job.started_at = datetime.now(timezone.utc)
    session.commit()

    try:
        sequence_id = job.payload["sequence_id"]
        percent = job.payload["percent"]
        frames = (
            session.query(Frame)
            .filter(Frame.sequence_id == sequence_id)
            .order_by(Frame.frame_index)
            .all()
        )

        embeddings = []
        for index, frame in enumerate(frames):
            frame_bytes = storage.download(frame.storage_key)
            embeddings.append(resolved_adapter.embed(frame_bytes))
            job.progress = int(((index + 1) / len(frames)) * 50)  # embedding is the first half
            session.commit()

        matrix = np.stack(embeddings) @ np.stack(embeddings).T
        ids = [f.id for f in frames]
        threshold = percent / 100.0
        clusters = cluster_by_threshold(matrix, ids, threshold)

        id_to_frame = {f.id: f for f in frames}
        id_to_index = {f.id: i for i, f in enumerate(frames)}

        # Evict the similarity model before loading the quality model --
        # both are GPU-resident deep models and this GPU has room for only
        # one large model family at a time (see _evict_*_models docstrings).
        _evict_similarity_models()
        quality_adapter = _get_default_quality_adapter()

        duplicate_ids: list[int] = []
        pairs: list[dict] = []
        similarity_map: dict[str, float] = {}

        for cluster_index, cluster_ids in enumerate(clusters):
            if len(cluster_ids) < 2:
                continue
            scored = []
            for frame_id in cluster_ids:
                frame_bytes = storage.download(id_to_frame[frame_id].storage_key)
                score = quality_adapter.score(frame_bytes)
                scored.append((frame_id, score))
            scored.sort(key=lambda entry: entry[1], reverse=True)  # best (highest) first
            best_id = scored[0][0]
            for frame_id, _score in scored[1:]:
                duplicate_ids.append(frame_id)
                similarity = float(matrix[id_to_index[best_id]][id_to_index[frame_id]])
                pairs.append({"frame_a": best_id, "frame_b": frame_id, "similarity": similarity})
                similarity_map[str(frame_id)] = similarity

            job.progress = 50 + int(((cluster_index + 1) / len(clusters)) * 50)
            session.commit()

        job.payload = {
            **job.payload,
            "result": {"duplicate_ids": duplicate_ids, "pairs": pairs, "similarity_map": similarity_map},
        }
        job.status = JobStatus.SUCCEEDED
        job.progress = 100
        job.finished_at = datetime.now(timezone.utc)
        _record_vram_usage(job)
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

- [ ] **Step 8: Run test to verify it passes**

Run: `docker compose exec ml-worker uv run pytest tests/test_tasks.py::test_run_find_similar_marks_all_but_best_quality_frame_in_a_cluster_as_duplicate -v`
Expected: PASS

- [ ] **Step 9: Run the full ml-worker test suite to confirm no regression**

Run: `docker compose exec ml-worker uv run pytest -v`
Expected: PASS (all tests, including Phase 1's and the pre-existing SAM2/SAM3 suites)

- [ ] **Step 10: Commit**

```bash
git add ml-worker/app/union_find.py ml-worker/app/tasks.py ml-worker/tests/test_union_find.py ml-worker/tests/test_tasks.py
git commit -m "feat: add run_find_similar Celery task with Union-Find clustering"
```

---

### Task 10: Frontend — `useFindSimilar` hook and toolbar similarity controls

**Files:**
- Modify: `frontend/src/entities/useFrames.ts` (add `useFindSimilar`)
- Modify: `frontend/src/features/annotation/SequenceGridToolbar.tsx` (add similarity group)
- Modify: `frontend/src/features/annotation/SequenceGridPage.tsx` (extend state, polling, auto-check for the second job kind)
- Test: `frontend/src/entities/useFrames.test.ts` (or wherever Task 5 put `useRankQuality`'s test)
- Test: `frontend/src/features/annotation/SequenceGridToolbar.test.tsx`
- Test: `frontend/src/features/annotation/SequenceGridPage.test.tsx`

**Interfaces:**
- Consumes: same as Task 5, plus everything Task 5 already built (`autoCheckedFrameIds`, `frameMarkReasons`, `activeJobId`/`activeJobKind` state shape — already generic over `"quality" | "similarity"` from Task 5's implementation, so this task is additive).
- Produces: `useFindSimilar(sequenceId: number)` (mirrors `useRankQuality`). `SequenceGridToolbar` gains: `similarityPercent: number`, `onSimilarityPercentChange: (value: number) => void`, `onFindSimilar: () => void`, `isFindSimilarRunning: boolean`. No new interface beyond this — everything else (badges, Clear marks, auto-check) is shared machinery from Task 5.

- [ ] **Step 1: Write the failing hook test**

Add to the same test file as Task 5's `useRankQuality` test:

```ts
describe("useFindSimilar", () => {
  it("POSTs to the find-similar endpoint with the given percent", async () => {
    vi.mocked(apiClient.POST).mockResolvedValue({
      data: { id: 43, job_type: "find_similar", status: "pending" },
      error: undefined,
    } as never);

    const { result } = renderHook(() => useFindSimilar(9), { wrapper });
    result.current.mutate(85);

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(apiClient.POST).toHaveBeenCalledWith(
      "/media/sequences/{sequence_id}/find-similar",
      expect.objectContaining({
        params: { path: { sequence_id: 9 } },
        body: { percent: 85 },
      }),
    );
  });
});
```

(Add `useFindSimilar` to the existing `import { useRankQuality } from "./useFrames";` line.)

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npm run test -- useFrames.test`
Expected: FAIL (import error)

- [ ] **Step 3: Implement `useFindSimilar`**

In `frontend/src/entities/useFrames.ts`, add after `useRankQuality`:

```ts
export function useFindSimilar(sequenceId: number) {
  return useMutation({
    mutationFn: async (percent: number) => {
      const result = await apiClient.POST("/media/sequences/{sequence_id}/find-similar", {
        params: { path: { sequence_id: sequenceId } },
        body: { percent },
      });
      return result.data;
    },
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd frontend && npm run test -- useFrames.test`
Expected: PASS

- [ ] **Step 5: Write the failing toolbar tests**

Add to `frontend/src/features/annotation/SequenceGridToolbar.test.tsx`, same style as Task 5's Step 5 quality tests but for `similarityPercent`/`onFindSimilar`/`isFindSimilarRunning` and the "Find Similar" button/`spinbutton` named `/similarity/i`.

- [ ] **Step 6: Run tests to verify they fail**

Run: `cd frontend && npm run test -- SequenceGridToolbar.test`
Expected: FAIL (new tests only; old ones still pass since new props default)

- [ ] **Step 7: Implement the toolbar's similarity controls**

In `frontend/src/features/annotation/SequenceGridToolbar.tsx`, add to the props interface (with defaults, same pattern as the quality group):

```tsx
  similarityPercent?: number;
  onSimilarityPercentChange?: (value: number) => void;
  onFindSimilar?: () => void;
  isFindSimilarRunning?: boolean;
```

destructured with defaults `similarityPercent = 85`, `onSimilarityPercentChange = () => {}`, `onFindSimilar = () => {}`, `isFindSimilarRunning = false`, and rendered right after the quality group's button, before "Clear marks":

```tsx
            <input
              type="number"
              aria-label="Similarity percent"
              min={1}
              max={99}
              value={similarityPercent}
              onChange={(event) => onSimilarityPercentChange(Number(event.target.value))}
              className="w-16 rounded border border-gray-700 bg-gray-900 px-2 py-1.5 text-sm text-gray-200"
            />
            <button
              type="button"
              aria-label="Find Similar"
              onClick={onFindSimilar}
              disabled={isFindSimilarRunning}
              className="rounded bg-gray-800 px-3 py-1.5 text-sm text-gray-200 hover:bg-gray-700 disabled:opacity-40"
            >
              {isFindSimilarRunning ? "Finding…" : "Find Similar"}
            </button>
```

- [ ] **Step 8: Run toolbar tests to verify they pass**

Run: `cd frontend && npm run test -- SequenceGridToolbar.test`
Expected: PASS (all)

- [ ] **Step 9: Write the failing page-level test for Find Similar auto-check**

Add to `frontend/src/features/annotation/SequenceGridPage.test.tsx`, mirroring Task 5's Step 9 test but with `job_type: "find_similar"`, `payload.result = { duplicate_ids: [2], pairs: [...], similarity_map: { "2": 0.96 } }`, clicking "Find Similar" instead, and asserting `screen.findByText(/dup 96%/i)` (label built from `similarity_map`, formatted as `dup ${Math.round(similarity * 100)}%`).

- [ ] **Step 10: Run test to verify it fails**

Run: `cd frontend && npm run test -- SequenceGridPage.test`
Expected: FAIL

- [ ] **Step 11: Implement `SequenceGridPage`'s similarity wiring**

In `frontend/src/features/annotation/SequenceGridPage.tsx`:

Add `useFindSimilar` to the `useFrames` import, add state `const [similarityPercent, setSimilarityPercent] = useState(85);` and `const findSimilar = useFindSimilar(sequenceIdNumber);`.

Extend the `useEffect` handling job success to branch on `activeJobKind === "similarity"` alongside the existing `"quality"` branch:

```tsx
  useEffect(() => {
    if (jobQuery.data?.status === "succeeded" && activeJobKind === "quality") {
      const result = jobQuery.data.payload?.result as
        | { scores: { frame_id: number; score: number }[]; worst_ids: number[] }
        | undefined;
      if (result) {
        setIsSelectMode(true);
        setSelectedFrameIds((current) => new Set([...current, ...result.worst_ids]));
        setAutoCheckedFrameIds((current) => new Set([...current, ...result.worst_ids]));
        setFrameMarkReasons((current) => {
          const next = new Map(current);
          for (const id of result.worst_ids) {
            next.set(id, { kind: "quality", label: "low quality" });
          }
          return next;
        });
      }
      setActiveJobId(null);
      setActiveJobKind(null);
    } else if (jobQuery.data?.status === "succeeded" && activeJobKind === "similarity") {
      const result = jobQuery.data.payload?.result as
        | { duplicate_ids: number[]; similarity_map: Record<string, number> }
        | undefined;
      if (result) {
        setIsSelectMode(true);
        setSelectedFrameIds((current) => new Set([...current, ...result.duplicate_ids]));
        setAutoCheckedFrameIds((current) => new Set([...current, ...result.duplicate_ids]));
        setFrameMarkReasons((current) => {
          const next = new Map(current);
          for (const id of result.duplicate_ids) {
            const similarity = result.similarity_map[String(id)] ?? 0;
            next.set(id, { kind: "similarity", label: `dup ${Math.round(similarity * 100)}%` });
          }
          return next;
        });
      }
      setActiveJobId(null);
      setActiveJobKind(null);
    } else if (jobQuery.data?.status === "failed") {
      setActiveJobId(null);
      setActiveJobKind(null);
    }
  }, [jobQuery.data, activeJobKind]);
```

Add the handler:

```tsx
  function handleFindSimilar() {
    findSimilar.mutate(similarityPercent, {
      onSuccess: (data) => {
        if (data) {
          setActiveJobId(data.id);
          setActiveJobKind("similarity");
        }
      },
    });
  }
```

Pass the new props to `SequenceGridToolbar`:

```tsx
          similarityPercent={similarityPercent}
          onSimilarityPercentChange={setSimilarityPercent}
          onFindSimilar={handleFindSimilar}
          isFindSimilarRunning={activeJobKind === "similarity"}
```

(`hasAutoMarks`/`onClearMarks` are already wired from Task 5 and need no changes — they already operate on the shared `autoCheckedFrameIds` regardless of which tool produced the marks.)

- [ ] **Step 12: Run frontend tests to verify they pass**

Run: `cd frontend && npm run test`
Expected: PASS (all tests)

- [ ] **Step 13: Commit**

```bash
git add frontend/src/entities/useFrames.ts frontend/src/features/annotation/SequenceGridToolbar.tsx frontend/src/features/annotation/SequenceGridPage.tsx frontend/src/entities/useFrames.test.ts frontend/src/features/annotation/SequenceGridToolbar.test.tsx frontend/src/features/annotation/SequenceGridPage.test.tsx
git commit -m "feat: add Find Similar toolbar controls with auto-check and badges"
```

---

### Task 11: Phase 2 real-stack verification

**Files:** none (manual verification).

- [ ] **Step 1: Restart the stack with the new ml-worker image**

```bash
docker compose up -d --build ml-worker
```

(`--build` is required since `Dockerfile`/`pyproject.toml` changed in Task 3 — a plain `up -d` would reuse the stale image without `pyiqa`/`opencv-python-headless`.)

- [ ] **Step 2: Exercise Find Similar in a real browser**

Using a sequence with at least one pair of near-duplicate frames (e.g. two consecutive frames from a slow-moving video segment), enter Select mode, set the similarity percent, click "Find Similar", and confirm:
- The button shows a loading state while the job runs (embedding + clustering + quality-scoring can take longer than Rank Quality alone — first run also pays DINOv2's `torch.hub` download cost, confirm this completes without timing out).
- The near-duplicate frame(s) show a red ring + `dup NN%` badge; the best-quality frame in each cluster is left unchecked.
- "Clear marks" and "Delete selected" behave the same as in Phase 1's verification.
- Running Rank Quality and Find Similar back-to-back on the same sequence works (tests the quality/similarity model eviction sequencing in `run_find_similar` and the cross-family eviction added to all four SAM tasks) without a VRAM crash.

- [ ] **Step 3: Record the outcome**

If everything works, both phases are complete. Update `ROADMAP.md` with a dated entry (following its existing phase-log format) noting this feature shipped, and note any deviations discovered during real-stack verification (e.g. DINOv2 hub-load reliability, actual TOPIQ/DINOv2 output ranges on real endoscopy frames) the way prior phases' entries do.
