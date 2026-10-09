# Train Workspace, Plan 2 of 3: History — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the Train screen into a dataset-centred workspace: a runs history per dataset, run details (overview, metrics, readable log, model), a live curve for the active run, a pinned active-run strip, repeat-with-changes and run delete, with the state in the URL.

**Architecture:** Part A (backend + worker) makes a run a self-contained experiment record: per-class metrics and the confusion matrix are copied onto `TrainingRun` (so deleting a model keeps them), `GET /training/runs` gains `dataset_id`/`limit` and exposes `model_version_id`, plus `GET /training/runs/{id}/metrics` and `DELETE /training/runs/{id}`. Part B replaces the page shell: `TrainPage` becomes a router-driven workspace (dataset rail left; tabs "Runs" and "New run" right; an active-run strip on top) built from small components and data hooks; the launch form from Plan 1 becomes the "New run" tab; the old log panel, versions table and model-info panel are replaced.

**Tech Stack:** FastAPI, SQLAlchemy, Alembic, Celery ml-worker, React + react-router-dom (`useSearchParams`), vitest, `openapi-typescript`.

**Spec:** [docs/superpowers/specs/2026-10-08-train-workspace-design.md](../specs/2026-10-08-train-workspace-design.md) — sections "Data model and API", "Worker", "Screen" (sizing rules, URL state, active-run strip, left rail, Runs tab, run details, empty and error states). Plan 1 (launch form) is done: [2026-10-08-train-workspace-1-launch.md](2026-10-08-train-workspace-1-launch.md).

## Global Constraints

- Work directly on `master`; no branches, no worktrees (CLAUDE.md). Untracked `yolo_qc_playground_architecture.pdf` and any `*.png` in the repo root are never committed.
- English only in code, comments, UI copy, commit messages. Dark theme only (no light-background Tailwind classes).
- TDD: a failing test before every implementation step.
- Backend tests use `import app.db as db_module` + `db_module.SessionLocal()` (never `from app.db import SessionLocal`) against `endoscopy_test`; a test file that imports no models needs `import app.main  # noqa: F401` for conftest's `create_all`.
- ml-worker tests run through `docker cp` + `docker compose exec` (container `endoscopy-platform-ml-worker-1`, interpreter `/app/.venv/bin/python`); `docker cp` is a test mechanism, not a deploy. They touch the real dev DB through their fixtures: compare `select count(*) from training_runs / model_versions / jobs` before and after, expected unchanged. **They need migration `e6f7a8b9c0d1` applied to the dev DB first** (the ml-worker mirror gains two columns); applying a migration to the real `endoscopy` DB, rebuilding the `ml-worker` image and starting dev servers each need the user's explicit approval at execution time. Stop and ask; earlier approvals do not carry over.
- Never leave rows in the real `endoscopy` DB or objects in MinIO; clean up unprompted after backing up to the scratchpad. Do not touch :5173/:5174 or running dev servers without asking (a Vite on :5173 and uvicorn on :8000 may be running from the previous phase).
- All HTTP in the frontend via `apiClient`; never hand-edit `frontend/src/shared/api/generated/`. After backend schema/route changes: `cd backend && PYTHONPATH=. uv run python scripts/export_openapi.py`, check `git diff --stat openapi.json`, then `cd frontend && npm run generate-api`.
- Known pre-existing failures (ignore): `backend/tests/test_training_models.py::test_training_run_defaults` and `::test_model_version_links_to_run`; jest-dom `TS2339` matcher type errors and a `qc/RunStatus.test.tsx` TS2739 under `tsc`.
- Frontend checks after each task: `cd frontend && npx vitest run src/features/training` and `npx tsc -p tsconfig.app.json --noEmit 2>&1 | grep -v TS2339 | grep features/training` (must print nothing).
- Commit trailer: `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`.

## Review Focus

1. Deleting a model must keep its run's per-class metrics and confusion matrix visible (they live on the run).
2. `DELETE /training/runs/{id}` refuses an active run and a run that still owns a model version (409 with a readable message) and never deletes a model's weights; it removes the run's own finished `Job` row.
3. A stale response (dataset switched quickly, run switched quickly) must never overwrite the newer one: every data hook uses a request counter.
4. Polling must stop when the run is terminal and must not re-fetch the whole log: only the tail past the stored offset (`offset` ≤ length, a server reset to 0 handled).
5. Log cleaning is display-only: the stored log stays raw; folding must never drop the last line of a progress bar group, never merge the training bar with the validation bar, and must not eat real lines that merely contain a percentage.
6. The URL is the source of truth: refresh and Back/Forward restore dataset, tab, run and sub-tab; an invalid or foreign `run` id (another dataset, deleted) falls back to the table with a message, never a blank page or a crash.
7. "Repeat with changes" must copy the base model (version still existing, else fall back to the first pretrained) and the run's full settings into the form, keep unknown/removed settings out, and never start a run by itself.
8. After a successful Start the name and note are cleared, the settings are kept, and the new run's details open.
9. The whole page scrolls as a unit; only the log pane and the class list scroll inside themselves; no block is stretched to the viewport height or collapsed to a sliver.

## File Structure

Backend/worker:
- Create `backend/alembic/versions/e6f7a8b9c0d1_add_training_run_per_class_confusion.py`.
- Modify `backend/app/training/{models,schemas,service,router}.py`; tests in `backend/tests/test_training_api.py` (+ `test_training_service.py` where needed).
- Modify `ml-worker/app/models.py`, `ml-worker/app/tasks.py`; test `ml-worker/tests/test_tasks_training.py`.

Frontend (`frontend/src/features/training/`):
- Create `cleanLog.ts`, `LogView.tsx` (+ tests).
- Create `runLogic.ts` (headline metric, durations, settings line, prefill), `useTrainUrl.ts` (+ tests).
- Create `useRuns.ts`, `useActiveRun.ts`, `useRunMetrics.ts`, `useRunLog.ts` (+ tests).
- Modify `TrainConfigForm.tsx` (dataset becomes a prop; prefill; clear signal), `DatasetCard.tsx` (`runCount`); create `DatasetRail.tsx`.
- Create `RunsTable.tsx`, `PerClassTable.tsx`, `RunDetail.tsx` with `RunOverview.tsx`, `RunMetricsView.tsx`, `RunLogView.tsx`, `RunModelView.tsx`, `ActiveRunStrip.tsx` (+ tests).
- Rewrite `TrainPage.tsx`; delete `TrainRunPanel.tsx`, `ModelVersionsTable.tsx`, `ModelInfoPanel.tsx` and their tests (their logic is moved, not lost).
- Modify `ROADMAP.md`; regenerate `openapi.json`.

---

# Part A — Run records (backend and worker)

### Task 1: Run-level metrics, runs list filters, run delete

**Files:**
- Create: `backend/alembic/versions/e6f7a8b9c0d1_add_training_run_per_class_confusion.py`
- Modify: `backend/app/training/models.py`, `schemas.py`, `service.py`, `router.py`
- Test: `backend/tests/test_training_api.py`
- Regenerate: `openapi.json`

**Interfaces:**
- Produces:
  - `TrainingRun.per_class_metrics: list`, `TrainingRun.confusion_matrix: dict | None`; read-only `TrainingRun.model_versions` relationship and property `TrainingRun.model_version_id: int | None`
  - `TrainingRunRead.model_version_id: int | None`
  - `RunMetricsRead { metrics: dict, history: list[dict], per_class: list[dict], confusion: dict | None }`
  - `service.list_runs(session, status=None, dataset_id=None, limit=None)`; `service.get_run_metrics(session, run_id) -> dict`; `service.delete_run(session, run_id)` raising `service.RunNotDeletable`
  - `GET /training/runs?dataset_id=&status=&limit=`; `GET /training/runs/{id}/metrics`; `DELETE /training/runs/{id}` (204 / 404 / 409)

- [ ] **Step 1: Write the failing tests** (append to `backend/tests/test_training_api.py`, reusing its helpers `_session`, `client`, `_register_and_login`, `_make_dataset`, `_succeeded_export`, `_cleanup`, `_user_id`, `_make_parent_version`, `_stub_send_task`, `_create`)

```python
def _make_run(session, dataset, user_id, *, status=TrainingRunStatus.SUCCEEDED, **fields):
    run = TrainingRun(
        dataset_id=dataset.id,
        adapter="ultralytics_yolo",
        base_model="yolo11n.pt",
        task_type=dataset.task_type,
        config={"epochs": 2},
        status=status,
        total_epochs=2,
        created_by_id=user_id,
        **fields,
    )
    session.add(run)
    session.commit()
    session.refresh(run)
    return run


def test_runs_list_filters_by_dataset_and_limits_and_exposes_the_model_version():
    email = "train-hist1@example.com"
    headers = _register_and_login(email)
    session = _session()
    user_id = _user_id(session, email)
    a = _make_dataset(session, user_id)
    b = _make_dataset(session, user_id)
    try:
        run_a1 = _make_run(session, a, user_id)
        run_a2 = _make_run(session, a, user_id)
        _make_run(session, b, user_id)
        version = ModelVersion(
            training_run_id=run_a1.id, name="m1", task_type=a.task_type,
            storage_key="models/x/best.pt", metrics={},
        )
        session.add(version)
        session.commit()

        listed = client.get(f"/training/runs?dataset_id={a.id}", headers=headers).json()

        assert [r["id"] for r in listed] == [run_a2.id, run_a1.id]  # newest first, only dataset a
        by_id = {r["id"]: r for r in listed}
        assert by_id[run_a1.id]["model_version_id"] == version.id
        assert by_id[run_a2.id]["model_version_id"] is None

        limited = client.get(f"/training/runs?dataset_id={a.id}&limit=1", headers=headers).json()
        assert [r["id"] for r in limited] == [run_a2.id]
        assert client.get("/training/runs?limit=0", headers=headers).status_code == 422
    finally:
        _cleanup(session, a.id)
        _cleanup(session, b.id)
        session.close()


def test_run_metrics_come_from_the_run_and_survive_deleting_the_model():
    email = "train-hist2@example.com"
    headers = _register_and_login(email)
    session = _session()
    user_id = _user_id(session, email)
    dataset = _make_dataset(session, user_id)
    try:
        run = _make_run(
            session, dataset, user_id,
            metrics={"metrics/mAP50(B)": 0.5},
            metrics_history=[{"epoch": 1, "train/box_loss": 1.2}, {"epoch": 2, "train/box_loss": 0.9}],
            per_class_metrics=[{"class": "polyp", "mAP50": 0.5}],
            confusion_matrix={"labels": ["polyp", "background"], "matrix": [[4, 1], [0, 2]]},
        )
        version = ModelVersion(
            training_run_id=run.id, name="m", task_type=dataset.task_type,
            storage_key=f"models/{run.id}/best.pt", metrics={},
        )
        session.add(version)
        session.commit()

        before = client.get(f"/training/runs/{run.id}/metrics", headers=headers).json()
        assert before["metrics"] == {"metrics/mAP50(B)": 0.5}
        assert [p["epoch"] for p in before["history"]] == [1, 2]
        assert before["per_class"][0]["class"] == "polyp"
        assert before["confusion"]["labels"] == ["polyp", "background"]

        class _Storage:
            def delete(self, key):
                pass

        app.dependency_overrides[get_storage_service] = lambda: _Storage()
        try:
            assert client.delete(f"/training/models/{version.id}", headers=headers).status_code == 204
        finally:
            app.dependency_overrides.pop(get_storage_service, None)

        after = client.get(f"/training/runs/{run.id}/metrics", headers=headers).json()
        assert after == before  # the experiment record outlives the weights
        assert client.get("/training/runs/99999999/metrics", headers=headers).status_code == 404
    finally:
        _cleanup(session, dataset.id)
        session.close()


def test_delete_run_removes_a_finished_run_and_its_job_only():
    email = "train-hist3@example.com"
    headers = _register_and_login(email)
    session = _session()
    user_id = _user_id(session, email)
    dataset = _make_dataset(session, user_id)
    try:
        job = Job(job_type=JobType.MODEL_TRAIN, status=JobStatus.FAILED,
                  payload={"dataset_id": dataset.id}, created_by_id=user_id)
        session.add(job)
        session.commit()
        run = _make_run(session, dataset, user_id, status=TrainingRunStatus.FAILED, job_id=job.id)
        run_id, job_id = run.id, job.id

        response = client.delete(f"/training/runs/{run_id}", headers=headers)

        assert response.status_code == 204
        session.expire_all()
        assert session.get(TrainingRun, run_id) is None
        assert session.get(Job, job_id) is None
        assert client.delete(f"/training/runs/{run_id}", headers=headers).status_code == 404
    finally:
        _cleanup(session, dataset.id)
        session.close()


@pytest.mark.parametrize("status", [TrainingRunStatus.PENDING, TrainingRunStatus.RUNNING])
def test_delete_run_refuses_an_active_run(status):
    email = "train-hist4@example.com"
    headers = _register_and_login(email)
    session = _session()
    user_id = _user_id(session, email)
    dataset = _make_dataset(session, user_id)
    try:
        run = _make_run(session, dataset, user_id, status=status)

        response = client.delete(f"/training/runs/{run.id}", headers=headers)

        assert response.status_code == 409
        assert "stop" in response.json()["detail"].lower()
        assert session.get(TrainingRun, run.id) is not None
    finally:
        _cleanup(session, dataset.id)
        session.close()


def test_delete_run_refuses_a_run_that_still_owns_a_model():
    email = "train-hist5@example.com"
    headers = _register_and_login(email)
    session = _session()
    user_id = _user_id(session, email)
    dataset = _make_dataset(session, user_id)
    try:
        parent = _make_parent_version(session, dataset, user_id, "keeper")
        response = client.delete(f"/training/runs/{parent.training_run_id}", headers=headers)

        assert response.status_code == 409
        assert "keeper" in response.json()["detail"]
        assert session.get(ModelVersion, parent.id) is not None
    finally:
        _cleanup(session, dataset.id)
        session.close()
```

(`pytest`, `Job`, `JobType`, `JobStatus` are already imported in this file; add `app`/`get_storage_service` only if missing. If `_cleanup` deletes `Job` rows by `payload["dataset_id"]`, the job created above is covered; leave it.)

- [ ] **Step 2: Run to verify failure**

Run: `cd backend && uv run pytest tests/test_training_api.py -q -k "hist or runs_list or run_metrics or delete_run"`
Expected: FAIL (columns/routes missing).

- [ ] **Step 3: Implement**

`models.py`, in `TrainingRun` (import `relationship` is already present):

```python
    # Facts of the experiment, copied from the trainer's result: they belong to
    # the run, not to its weights, so deleting a model never erases them.
    per_class_metrics: Mapped[list] = mapped_column(JSON, default=list)
    confusion_matrix: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    # Read-only view of the model this run produced (zero or one in practice).
    # foreign_keys is required: runs and versions also reference each other
    # through base_model_version_id.
    model_versions: Mapped[list["ModelVersion"]] = relationship(
        "ModelVersion", foreign_keys="ModelVersion.training_run_id", viewonly=True
    )

    @property
    def model_version_id(self) -> int | None:
        return self.model_versions[0].id if self.model_versions else None
```

Migration:

```python
# backend/alembic/versions/e6f7a8b9c0d1_add_training_run_per_class_confusion.py
"""add training run per-class metrics and confusion matrix

Revision ID: e6f7a8b9c0d1
Revises: d5e6f7a8b9c0
Create Date: 2026-10-09 12:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "e6f7a8b9c0d1"
down_revision: Union[str, Sequence[str], None] = "d5e6f7a8b9c0"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "training_runs",
        sa.Column("per_class_metrics", sa.JSON(), nullable=False, server_default="[]"),
    )
    op.add_column("training_runs", sa.Column("confusion_matrix", sa.JSON(), nullable=True))
    # The server default only backfilled existing rows; the application always
    # supplies a value.
    op.alter_column("training_runs", "per_class_metrics", server_default=None)
    # Runs that already produced a model: copy its per-class numbers and matrix.
    op.execute(
        """
        UPDATE training_runs
        SET per_class_metrics = v.per_class_metrics,
            confusion_matrix = v.confusion_matrix
        FROM model_versions v
        WHERE v.training_run_id = training_runs.id
        """
    )


def downgrade() -> None:
    op.drop_column("training_runs", "confusion_matrix")
    op.drop_column("training_runs", "per_class_metrics")
```

`schemas.py`: add `model_version_id: int | None` to `TrainingRunRead` (after `base_model_version_id`), and

```python
class RunMetricsRead(BaseModel):
    """Everything about how a run went, read from the run itself (not from its
    weights), so it survives deleting the model."""

    metrics: dict
    history: list[dict]
    per_class: list[dict]
    confusion: dict | None
```

`service.py` (import `selectinload` from `sqlalchemy.orm`):

```python
class RunNotDeletable(Exception):
    """The run is still active or still owns a model version."""


def list_runs(
    session: Session,
    status: TrainingRunStatus | None = None,
    dataset_id: int | None = None,
    limit: int | None = None,
) -> list[TrainingRun]:
    statement = (
        select(TrainingRun)
        .options(selectinload(TrainingRun.model_versions))
        .order_by(TrainingRun.id.desc())
    )
    if status is not None:
        statement = statement.where(TrainingRun.status == status)
    if dataset_id is not None:
        statement = statement.where(TrainingRun.dataset_id == dataset_id)
    if limit is not None:
        statement = statement.limit(limit)
    return list(session.scalars(statement))


def get_run_metrics(session: Session, run_id: int) -> dict:
    run = get_run(session, run_id)
    return {
        "metrics": run.metrics or {},
        "history": run.metrics_history or [],
        "per_class": run.per_class_metrics or [],
        "confusion": run.confusion_matrix,
    }


def delete_run(session: Session, run_id: int) -> None:
    """Remove a finished run that produced no model.

    The history is a record of experiments, so a run with weights is deleted by
    deleting the model first (a deliberate two-step: weights are the expensive
    artifact). The run's own finished Job row goes with it; nothing in storage
    belongs to a run without a model.
    """
    run = get_run(session, run_id)
    if run.status in ACTIVE_STATUSES:
        raise RunNotDeletable(f"Training run {run_id} is {run.status.value}; stop it first")
    if run.model_versions:
        raise RunNotDeletable(
            f"Training run {run_id} produced model version '{run.model_versions[0].name}'; "
            "delete the model first"
        )
    job_id = run.job_id
    session.delete(run)
    session.flush()
    if job_id is not None:
        job = session.get(Job, job_id)
        if job is not None and job.status in (JobStatus.SUCCEEDED, JobStatus.FAILED):
            session.delete(job)
    session.commit()
```

`router.py` (import `RunMetricsRead`):

```python
@router.get("/runs", response_model=list[TrainingRunRead])
def list_runs(
    run_status: TrainingRunStatus | None = Query(default=None, alias="status"),
    dataset_id: int | None = Query(default=None),
    limit: int | None = Query(default=None, ge=1, le=500),
    session: Session = Depends(get_session),
):
    return service.list_runs(session, run_status, dataset_id, limit)


@router.get("/runs/{run_id}/metrics", response_model=RunMetricsRead)
def read_run_metrics(run_id: int, session: Session = Depends(get_session)):
    try:
        return service.get_run_metrics(session, run_id)
    except service.TrainingRunNotFound as exc:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(exc))


@router.delete("/runs/{run_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_run(run_id: int, session: Session = Depends(get_session)):
    try:
        service.delete_run(session, run_id)
    except service.TrainingRunNotFound as exc:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(exc))
    except service.RunNotDeletable as exc:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=str(exc))
```

(Replace the existing `list_runs` route; keep `/runs/{run_id}`, log, stop unchanged.)

- [ ] **Step 4: Run to verify pass, regenerate OpenAPI**

Run: `cd backend && uv run pytest tests/test_training_api.py tests/test_training_service.py tests/test_training_params.py tests/test_training_catalog.py -q` — Expected: PASS (the two known `test_training_models.py` failures excluded).
Run: `cd backend && uv run alembic heads` — Expected: `e6f7a8b9c0d1 (head)`. Do NOT run `alembic upgrade`.
Run: `cd backend && PYTHONPATH=. uv run python scripts/export_openapi.py && cd .. && git diff --stat openapi.json` — Expected: changed (`RunMetricsRead`, `model_version_id`, the new routes).

- [ ] **Step 5: Commit**

```bash
git add backend openapi.json
git commit -m "feat: run-level metrics, runs list filters, model_version_id and run delete

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Worker copies per-class metrics and the confusion matrix onto the run

**Files:**
- Modify: `ml-worker/app/models.py`, `ml-worker/app/tasks.py`
- Test: `ml-worker/tests/test_tasks_training.py`

**Interfaces:**
- Consumes: DB columns `training_runs.per_class_metrics`, `training_runs.confusion_matrix` (Task 1; the migration must be applied to the dev DB before this task's tests run — **stop and ask the user to approve `alembic upgrade head` on `endoscopy`**, back up `training_runs` to the scratchpad first).
- Produces: ml-worker's `TrainingRun.per_class_metrics` / `.confusion_matrix`; `model_train` writes both to the run on success (and on a stopped run that still yields weights).

- [ ] **Step 1: Write the failing tests** (in `ml-worker/tests/test_tasks_training.py`)

Extend `test_history_accumulates_during_training` (the one whose adapter returns `per_class=[{"class": "polyp", "mAP50": 0.7}]` and a confusion matrix) with:

```python
    assert run.per_class_metrics[0]["class"] == "polyp"
    assert run.confusion_matrix["labels"][-1] == "background"
```

and add:

```python
def test_a_failed_run_leaves_per_class_and_confusion_empty(db_session, make_job_and_run, fake_storage):
    from app.tasks import model_train

    class _Crashing:
        def train(self, request, on_log, on_epoch, should_stop):
            on_epoch(1, 3, {"train/loss": 0.9})
            raise RuntimeError("CUDA out of memory")

    job, run = make_job_and_run()
    model_train(job.id, adapter=_Crashing())
    db_session.refresh(run)

    assert run.status == TrainingRunStatus.FAILED
    assert run.per_class_metrics == []
    assert run.confusion_matrix is None


def test_the_run_keeps_its_per_class_numbers_when_the_model_is_deleted(
    db_session, make_job_and_run, fake_storage
):
    from app.tasks import model_train

    class _Adapter:
        def train(self, request, on_log, on_epoch, should_stop):
            weights = request.output_dir / "best.pt"
            weights.write_bytes(b"w")
            return TrainingResult(
                weights_path=weights,
                per_class=[{"class": "polyp", "mAP50": 0.7}],
                confusion={"labels": ["polyp", "background"], "matrix": [[1, 0], [0, 1]]},
            )

    job, run = make_job_and_run()
    model_train(job.id, adapter=_Adapter())
    version = db_session.query(ModelVersion).filter_by(training_run_id=run.id).one()
    db_session.delete(version)
    db_session.commit()
    db_session.refresh(run)

    assert run.per_class_metrics[0]["class"] == "polyp"
    assert run.confusion_matrix["matrix"] == [[1, 0], [0, 1]]
```

- [ ] **Step 2: Run to verify failure**

Run (docker cp workflow): `docker cp ml-worker/app/. endoscopy-platform-ml-worker-1:/app/app/ && docker cp ml-worker/tests/. endoscopy-platform-ml-worker-1:/app/tests/ && docker compose exec -T ml-worker /app/.venv/bin/python -m pytest tests/test_tasks_training.py -v`
Expected: FAIL (`AttributeError`: the mirror has no such columns).

- [ ] **Step 3: Implement**

`ml-worker/app/models.py`, in `TrainingRun` after `metrics_history`:

```python
    per_class_metrics: Mapped[list] = mapped_column(JSON, default=list)
    confusion_matrix: Mapped[dict | None] = mapped_column(JSON, nullable=True)
```

`ml-worker/app/tasks.py`, in `model_train`'s success path next to `run.metrics = result.metrics`:

```python
        # Facts of the experiment live on the run too: deleting the model later
        # must not erase how well each class did.
        run.per_class_metrics = result.per_class
        run.confusion_matrix = result.confusion
```

- [ ] **Step 4: Run to verify pass**

Re-run the Step 2 command, then `... pytest tests/test_tasks_training.py tests/test_training_adapter.py tests/test_ultralytics_yolo_adapter.py -v`. Compare the real-DB counts before and after: unchanged.
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add ml-worker
git commit -m "feat: copy per-class metrics and the confusion matrix onto the training run

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

# Part B — Workspace (frontend)

Run `cd frontend && npm run generate-api` before starting Part B so the new generated types (`RunMetricsRead`, `model_version_id`, the new routes) exist.

### Task 3: Readable log

**Files:**
- Create: `frontend/src/features/training/cleanLog.ts`, `cleanLog.test.ts`, `LogView.tsx`, `LogView.test.tsx`

**Interfaces:**
- Produces: `cleanLog(raw: string): string`; `LogView({ text, className? })` (a `<pre>` that renders `cleanLog(text)` and follows the tail unless the reader scrolled up); `shouldStickToBottom(scrollTop, clientHeight, scrollHeight, tolerance?)` and `STICK_TO_BOTTOM_TOLERANCE_PX` (moved here from `TrainRunPanel.tsx` together with their tests from `TrainRunPanel.test.tsx`).

The stored log is raw and stays raw. In a real run each progress-bar update is a line that begins with `\r` and an `ESC[K` code and carries the whole bar; many updates of the same bar follow one another.

- [ ] **Step 1: Write the failing tests**

```ts
// cleanLog.test.ts
import { describe, expect, it } from "vitest";

import { cleanLog } from "./cleanLog";

const ESC = "\x1b";
const trainBar = (percent: number, step: number) =>
  `\r${ESC}[K        2/3      0.613G      1.116      3.393      1.478          7        640: ${percent}% ━╸───── ${step}/16 6.6it/s 0.4s<2.0s`;
const valBar = (percent: number, step: number) =>
  `\r${ESC}[K                 Class     Images  Instances      Box(P          R      mAP50  mAP50-95): ${percent}% ━━━──── ${step}/3 21.6it/s 0.1s`;

describe("cleanLog", () => {
  it("removes ANSI codes and carriage returns", () => {
    const raw = `\r${ESC}[K${ESC}[34m${ESC}[1mtrain: ${ESC}[0mScanning labels`;

    expect(cleanLog(raw)).toBe("train: Scanning labels");
  });

  it("keeps only the last update of one progress bar", () => {
    const raw = [trainBar(6, 1), trainBar(18, 3), trainBar(100, 16)].join("\n");

    expect(cleanLog(raw).split("\n")).toEqual([
      expect.stringContaining("100%"),
    ]);
  });

  it("keeps the training bar and the validation bar that follows it apart", () => {
    const raw = [trainBar(50, 8), trainBar(100, 16), valBar(33, 1), valBar(100, 3)].join("\n");

    const lines = cleanLog(raw).split("\n");

    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain("2/3");
    expect(lines[0]).toContain("16/16");
    expect(lines[1]).toContain("Class");
    expect(lines[1]).toContain("3/3");
  });

  it("starts a new group after an ordinary line, so the next epoch keeps its own bar", () => {
    const raw = [trainBar(100, 16), "all   24   26   0.9", trainBar(10, 2)].join("\n");

    expect(cleanLog(raw).split("\n")).toHaveLength(3);
  });

  it("never treats a plain line that merely mentions a percentage as a progress bar", () => {
    const raw = ["Accuracy improved 12% over baseline", "Accuracy improved 14% over baseline"].join("\n");

    expect(cleanLog(raw).split("\n")).toEqual([
      "Accuracy improved 12% over baseline",
      "Accuracy improved 14% over baseline",
    ]);
  });

  it("keeps the first and the last line even when the log ends mid-bar", () => {
    const raw = ["Epoch    GPU_mem", trainBar(18, 3)].join("\n");

    expect(cleanLog(raw).split("\n")).toEqual([
      "Epoch    GPU_mem",
      expect.stringContaining("18%"),
    ]);
  });

  it("collapses runs of blank lines to one and drops trailing whitespace", () => {
    expect(cleanLog("a   \n\n\n\nb")).toBe("a\n\nb");
  });

  it("returns an empty string for an empty log", () => {
    expect(cleanLog("")).toBe("");
  });
});
```

```tsx
// LogView.test.tsx
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { LogView, shouldStickToBottom } from "./LogView";

describe("LogView", () => {
  it("renders the cleaned log, not the raw one", () => {
    render(<LogView text={"\r\x1b[K\x1b[34mhello\x1b[0m"} />);

    expect(screen.getByRole("log")).toHaveTextContent("hello");
    expect(screen.getByRole("log").textContent).not.toContain("\x1b");
  });

  it("says when there is nothing yet", () => {
    render(<LogView text="" />);

    expect(screen.getByText(/no log output yet/i)).toBeInTheDocument();
  });
});

describe("shouldStickToBottom", () => {
  it("follows the tail when the reader is within the tolerance of the bottom", () => {
    expect(shouldStickToBottom(900, 100, 1000)).toBe(true);
    expect(shouldStickToBottom(880, 100, 1000)).toBe(true);
  });

  it("lets go when the reader scrolled up", () => {
    expect(shouldStickToBottom(500, 100, 1000)).toBe(false);
  });
});
```

Also move the existing `shouldStickToBottom` tests from `TrainRunPanel.test.tsx` into `LogView.test.tsx` (keep their cases).

- [ ] **Step 2: Run to verify failure**

Run: `cd frontend && npx vitest run src/features/training/cleanLog.test.ts src/features/training/LogView.test.tsx`
Expected: FAIL (modules missing).

- [ ] **Step 3: Implement**

```ts
// cleanLog.ts
/** Readable form of a raw trainer log, for display only (the stored log stays raw).
 *
 * Ultralytics writes every progress-bar update as its own line that starts with a
 * carriage return and an ANSI "erase line" code and carries the whole bar. Shown
 * verbatim that is hundreds of near-identical lines full of control characters.
 * Here the control codes are removed and consecutive updates of the same bar are
 * folded into the last one. */

const ANSI = /\x1b\[[0-9;?]*[A-Za-z]/g;
// A bar is "<digits>% " followed by a run of box-drawing glyphs: a plain line that
// merely mentions a percentage is not a bar.
const PROGRESS = /\d+%\s*[━─╸╺╾╼]{3,}/;

function firstToken(line: string): string {
  return line.trim().split(/\s+/)[0] ?? "";
}

export function cleanLog(raw: string): string {
  if (raw === "") {
    return "";
  }
  const out: string[] = [];
  let barKey: string | null = null;
  for (const rawLine of raw.split("\n")) {
    // A carriage return rewinds the cursor, so only what follows the last one is visible.
    const visible = rawLine.split("\r").filter((part) => part !== "").pop() ?? "";
    const line = visible.replace(ANSI, "").replace(/\s+$/, "");
    if (line === "") {
      if (out.length > 0 && out[out.length - 1] !== "") {
        out.push("");
      }
      barKey = null;
      continue;
    }
    if (PROGRESS.test(line)) {
      // Updates of one bar share their first token (the epoch "2/3", "Class", "train:").
      const key = firstToken(line);
      if (barKey === key) {
        out[out.length - 1] = line;
      } else {
        out.push(line);
        barKey = key;
      }
    } else {
      out.push(line);
      barKey = null;
    }
  }
  return out.join("\n").replace(/\n+$/, "");
}
```

```tsx
// LogView.tsx
import { useEffect, useMemo, useRef } from "react";

import { cleanLog } from "./cleanLog";

/** Pixels of slack between the visible bottom edge and the true bottom of the
 * content before the reader no longer counts as "at the bottom" (sub-pixel
 * rounding and zoom make scrollTop + clientHeight rarely equal scrollHeight). */
export const STICK_TO_BOTTOM_TOLERANCE_PX = 24;

/** Pure decision for the follow-the-tail pattern, separate so it can be tested
 * without jsdom layout (jsdom reports 0 for every scroll metric). */
export function shouldStickToBottom(
  scrollTop: number,
  clientHeight: number,
  scrollHeight: number,
  tolerance: number = STICK_TO_BOTTOM_TOLERANCE_PX,
): boolean {
  return scrollHeight - (scrollTop + clientHeight) <= tolerance;
}

interface LogViewProps {
  text: string;
  className?: string;
}

export function LogView({ text, className = "" }: LogViewProps) {
  const ref = useRef<HTMLPreElement>(null);
  // Whether the reader was at the bottom just before this update, so new
  // output only moves the view when they were following it.
  const followingRef = useRef(true);
  const cleaned = useMemo(() => cleanLog(text), [text]);

  useEffect(() => {
    const el = ref.current;
    if (el && followingRef.current) {
      el.scrollTop = el.scrollHeight;
    }
  }, [cleaned]);

  return (
    <pre
      ref={ref}
      role="log"
      aria-live="off"
      onScroll={(event) => {
        const el = event.currentTarget;
        followingRef.current = shouldStickToBottom(el.scrollTop, el.clientHeight, el.scrollHeight);
      }}
      className={`min-h-[24rem] overflow-auto whitespace-pre-wrap rounded border border-gray-800 bg-gray-950 p-3 font-mono text-xs text-gray-300 ${className}`}
    >
      {cleaned === "" ? "No log output yet." : cleaned}
    </pre>
  );
}
```

(The "No log output yet." fallback must match `/no log output yet/i`; `TrainRunPanel.tsx` still imports its own copy of these helpers until Task 9 deletes it — leave it untouched here.)

- [ ] **Step 4: Run to verify pass**

Run: `cd frontend && npx vitest run src/features/training/cleanLog.test.ts src/features/training/LogView.test.tsx` — Expected: PASS. If a test about `PROGRESS` fails on the glyph set, check the exact glyphs in a real log (`docker compose exec -T postgres psql -U endoscopy -t -A -c "select log_text from training_runs where id=268" | head -50 | cat -v`) and keep the intent: a bar line is `<digits>%` followed by box glyphs.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/features/training
git commit -m "feat: readable training log (ANSI removed, progress bars folded)

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Run logic and URL state

**Files:**
- Create: `frontend/src/features/training/runLogic.ts`, `runLogic.test.ts`, `useTrainUrl.ts`, `useTrainUrl.test.tsx`

**Interfaces:**
- Consumes: `SettingsSchema`, `SettingsValues`, `defaultValues`, `allFields` from `settingsLogic.ts`; generated `TrainingRunRead`.
- Produces:
  - `headlineScore(taskType, metrics): { label; value }` — **moved verbatim** from `ModelVersionsTable.tsx` (same behaviour, same fallback rules); `headlineValue(taskType, metrics): number | null` (the number behind a *known* key: `metrics/accuracy_top1` / `accuracy_top1` for classification, `metrics/mAP50(B)` / `mAP50` otherwise; `null` for an unknown vocabulary)
  - `formatDuration(startedAt: string | null, finishedAt: string | null, now?: Date): string`
  - `settingsLine(config: Record<string, unknown>): string`
  - `bestRunId(runs: TrainingRunRead[]): number | null`
  - `baseKeyFromRun(run): string` (`version:<id>` or `pretrained:<name>`), `valuesFromConfig(schema, config): SettingsValues`
  - `useTrainUrl(): [TrainUrlState, (patch: Partial<TrainUrlState>, options?: { replace?: boolean }) => void]` with `TrainUrlState = { dataset: number | null; tab: "runs" | "new"; run: number | null; view: "overview" | "metrics" | "log" | "model" }`

- [ ] **Step 1: Write the failing tests**

```ts
// runLogic.test.ts
import { describe, expect, it } from "vitest";

import {
  baseKeyFromRun,
  bestRunId,
  formatDuration,
  headlineScore,
  headlineValue,
  settingsLine,
  valuesFromConfig,
} from "./runLogic";
import { settingsSchemaFixture as schema } from "./testFixtures";

const run = (over: Record<string, unknown>) =>
  ({
    id: 1,
    status: "succeeded",
    task_type: "detection",
    metrics: {},
    base_model: "yolo11n.pt",
    base_model_version_id: null,
    config: {},
    ...over,
  }) as never;

describe("headline metric", () => {
  it("picks the known key per task", () => {
    expect(headlineScore("detection", { "metrics/mAP50(B)": 0.712 })).toEqual({
      label: "mAP50",
      value: "0.712",
    });
    expect(headlineScore("classification", { "metrics/accuracy_top1": 0.957 })).toEqual({
      label: "top-1",
      value: "0.957",
    });
  });

  it("falls back to the first numeric entry with its own key, and to a dash", () => {
    expect(headlineScore("detection", { ap_50: 0.4 })).toEqual({ label: "ap_50", value: "0.400" });
    expect(headlineScore("detection", {})).toEqual({ label: "", value: "—" });
  });

  it("exposes the raw number only for a known key", () => {
    expect(headlineValue("detection", { "metrics/mAP50(B)": 0.5 })).toBe(0.5);
    expect(headlineValue("classification", { "metrics/accuracy_top1": 0.9 })).toBe(0.9);
    expect(headlineValue("detection", { ap_50: 0.4 })).toBeNull();
  });
});

describe("formatDuration", () => {
  it("formats finished runs", () => {
    expect(formatDuration("2026-10-09T10:00:00Z", "2026-10-09T10:01:05Z")).toBe("1m 05s");
    expect(formatDuration("2026-10-09T10:00:00Z", "2026-10-09T11:02:03Z")).toBe("1h 02m");
    expect(formatDuration("2026-10-09T10:00:00Z", "2026-10-09T10:00:07Z")).toBe("7s");
  });

  it("counts a running run up to now, and shows a dash before it started", () => {
    expect(
      formatDuration("2026-10-09T10:00:00Z", null, new Date("2026-10-09T10:00:30Z")),
    ).toBe("30s");
    expect(formatDuration(null, null)).toBe("—");
  });
});

describe("settingsLine", () => {
  it("summarises the settings that matter in one line", () => {
    expect(
      settingsLine({ imgsz: 640, batch: 4, epochs: 50, freeze: 10, optimizer: "AdamW" }),
    ).toBe("640 · b4 · 50 ep · freeze 10 · AdamW");
  });

  it("leaves out what is absent or automatic", () => {
    expect(settingsLine({ imgsz: 640, batch: 8, epochs: 3, optimizer: "auto" })).toBe(
      "640 · b8 · 3 ep",
    );
    expect(settingsLine({})).toBe("");
  });
});

describe("bestRunId", () => {
  it("is the finished run with the highest known headline value", () => {
    const runs = [
      run({ id: 1, metrics: { "metrics/mAP50(B)": 0.3 } }),
      run({ id: 2, metrics: { "metrics/mAP50(B)": 0.7 } }),
      run({ id: 3, status: "failed", metrics: { "metrics/mAP50(B)": 0.99 } }),
    ];

    expect(bestRunId(runs)).toBe(2);
  });

  it("is null when no run has a comparable number or only one run exists", () => {
    expect(bestRunId([run({ id: 1, metrics: { ap_50: 0.4 } }), run({ id: 2 })])).toBeNull();
    expect(bestRunId([run({ id: 1, metrics: { "metrics/mAP50(B)": 0.3 } })])).toBeNull();
  });
});

describe("prefill from a run", () => {
  it("uses the version when the run was a fine-tune, the weights name otherwise", () => {
    expect(baseKeyFromRun(run({ base_model_version_id: 7, base_model: "parent" }))).toBe("version:7");
    expect(baseKeyFromRun(run({}))).toBe("pretrained:yolo11n.pt");
  });

  it("copies known settings over the defaults and ignores unknown keys", () => {
    const values = valuesFromConfig(schema, { epochs: 12, optimizer: "AdamW", removed_key: 1 });

    expect(values.epochs).toBe(12);
    expect(values.optimizer).toBe("AdamW");
    expect(values.batch).toBe(8); // not in the config -> default
    expect("removed_key" in values).toBe(false);
    expect(values.freeze).toBeNull();
  });
});
```

```tsx
// useTrainUrl.test.tsx
import { act, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";

import { useTrainUrl } from "./useTrainUrl";

const wrapper = (initial: string) =>
  function Wrapper({ children }: { children: ReactNode }) {
    return <MemoryRouter initialEntries={[initial]}>{children}</MemoryRouter>;
  };

describe("useTrainUrl", () => {
  it("defaults to the runs tab with nothing selected", () => {
    const { result } = renderHook(() => useTrainUrl(), { wrapper: wrapper("/train") });

    expect(result.current[0]).toEqual({ dataset: null, tab: "runs", run: null, view: "overview" });
  });

  it("reads dataset, tab, run and view from the query string", () => {
    const { result } = renderHook(() => useTrainUrl(), {
      wrapper: wrapper("/train?dataset=496&tab=new&run=268&view=log"),
    });

    expect(result.current[0]).toEqual({ dataset: 496, tab: "new", run: 268, view: "log" });
  });

  it("ignores nonsense values", () => {
    const { result } = renderHook(() => useTrainUrl(), {
      wrapper: wrapper("/train?dataset=abc&tab=zzz&run=-3&view=x"),
    });

    expect(result.current[0]).toEqual({ dataset: null, tab: "runs", run: null, view: "overview" });
  });

  it("merges a patch and omits defaults from the URL", () => {
    const { result } = renderHook(() => useTrainUrl(), { wrapper: wrapper("/train?dataset=496") });

    act(() => result.current[1]({ run: 268, view: "metrics" }));
    expect(result.current[0]).toEqual({ dataset: 496, tab: "runs", run: 268, view: "metrics" });

    act(() => result.current[1]({ run: null }));
    expect(result.current[0].run).toBeNull();
    expect(result.current[0].dataset).toBe(496);
  });

  it("switching dataset clears the selected run", () => {
    const { result } = renderHook(() => useTrainUrl(), {
      wrapper: wrapper("/train?dataset=496&run=268"),
    });

    act(() => result.current[1]({ dataset: 497 }));

    expect(result.current[0]).toEqual({ dataset: 497, tab: "runs", run: null, view: "overview" });
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd frontend && npx vitest run src/features/training/runLogic.test.ts src/features/training/useTrainUrl.test.tsx`
Expected: FAIL (modules missing).

- [ ] **Step 3: Implement**

`runLogic.ts`: move `headlineScore` from `ModelVersionsTable.tsx` verbatim (keep its long doc comment), leaving `ModelVersionsTable.tsx` importing it for now (it is deleted in Task 9), and add:

```ts
import type { components } from "../../shared/api/generated/schema";
import { allFields, defaultValues, type SettingsSchema, type SettingsValues } from "./settingsLogic";

type TrainingRunRead = components["schemas"]["TrainingRunRead"];

export function headlineValue(taskType: string, metrics: Record<string, unknown>): number | null {
  const raw =
    taskType === "classification"
      ? (metrics["metrics/accuracy_top1"] ?? metrics["accuracy_top1"])
      : (metrics["metrics/mAP50(B)"] ?? metrics["mAP50"]);
  return typeof raw === "number" ? raw : null;
}

export function formatDuration(
  startedAt: string | null,
  finishedAt: string | null,
  now: Date = new Date(),
): string {
  if (!startedAt) return "—";
  const end = finishedAt ? new Date(finishedAt) : now;
  const seconds = Math.max(0, Math.round((end.getTime() - new Date(startedAt).getTime()) / 1000));
  if (seconds >= 3600) {
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    return `${hours}h ${String(minutes).padStart(2, "0")}m`;
  }
  if (seconds >= 60) {
    const minutes = Math.floor(seconds / 60);
    return `${minutes}m ${String(seconds % 60).padStart(2, "0")}s`;
  }
  return `${seconds}s`;
}

export function settingsLine(config: Record<string, unknown>): string {
  const parts: string[] = [];
  if (config.imgsz !== undefined) parts.push(String(config.imgsz));
  if (config.batch !== undefined) parts.push(`b${config.batch}`);
  if (config.epochs !== undefined) parts.push(`${config.epochs} ep`);
  if (config.freeze !== undefined && config.freeze !== null) parts.push(`freeze ${config.freeze}`);
  if (typeof config.optimizer === "string" && config.optimizer !== "auto") parts.push(config.optimizer);
  return parts.join(" · ");
}

/** The best finished run by a *known* headline metric, or null when fewer than two
 * runs are comparable (an unknown vocabulary has no agreed direction). */
export function bestRunId(runs: TrainingRunRead[]): number | null {
  const scored = runs
    .filter((run) => run.status === "succeeded" || run.status === "stopped")
    .map((run) => ({ id: run.id, value: headlineValue(run.task_type, run.metrics as Record<string, unknown>) }))
    .filter((entry): entry is { id: number; value: number } => entry.value !== null);
  if (scored.length < 2) return null;
  return scored.reduce((best, entry) => (entry.value > best.value ? entry : best)).id;
}

export function baseKeyFromRun(run: TrainingRunRead): string {
  return run.base_model_version_id !== null && run.base_model_version_id !== undefined
    ? `version:${run.base_model_version_id}`
    : `pretrained:${run.base_model}`;
}

export function valuesFromConfig(schema: SettingsSchema, config: Record<string, unknown>): SettingsValues {
  const values = defaultValues(schema);
  for (const field of allFields(schema)) {
    if (field.key in config) {
      const value = config[field.key];
      values[field.key] = (value ?? null) as SettingsValues[string];
    }
  }
  return values;
}
```

`useTrainUrl.ts`:

```ts
import { useCallback, useMemo } from "react";
import { useSearchParams } from "react-router-dom";

export type TrainTab = "runs" | "new";
export type RunView = "overview" | "metrics" | "log" | "model";

export interface TrainUrlState {
  dataset: number | null;
  tab: TrainTab;
  run: number | null;
  view: RunView;
}

const TABS: TrainTab[] = ["runs", "new"];
const VIEWS: RunView[] = ["overview", "metrics", "log", "model"];

function positiveInt(value: string | null): number | null {
  if (value === null || !/^\d+$/.test(value)) return null;
  const number = Number(value);
  return number > 0 ? number : null;
}

export function useTrainUrl(): [
  TrainUrlState,
  (patch: Partial<TrainUrlState>, options?: { replace?: boolean }) => void,
] {
  const [params, setParams] = useSearchParams();

  const state = useMemo<TrainUrlState>(() => {
    const tab = params.get("tab");
    const view = params.get("view");
    return {
      dataset: positiveInt(params.get("dataset")),
      tab: TABS.includes(tab as TrainTab) ? (tab as TrainTab) : "runs",
      run: positiveInt(params.get("run")),
      view: VIEWS.includes(view as RunView) ? (view as RunView) : "overview",
    };
  }, [params]);

  const update = useCallback(
    (patch: Partial<TrainUrlState>, options: { replace?: boolean } = {}) => {
      // A run belongs to one dataset: switching dataset drops the selected run.
      const next: TrainUrlState = {
        ...state,
        ...patch,
        ...(patch.dataset !== undefined && patch.dataset !== state.dataset && patch.run === undefined
          ? { run: null, view: "overview" as RunView }
          : {}),
      };
      const search = new URLSearchParams();
      if (next.dataset !== null) search.set("dataset", String(next.dataset));
      if (next.tab !== "runs") search.set("tab", next.tab);
      if (next.run !== null) search.set("run", String(next.run));
      if (next.view !== "overview") search.set("view", next.view);
      setParams(search, { replace: options.replace ?? false });
    },
    [state, setParams],
  );

  return [state, update];
}
```

- [ ] **Step 4: Run to verify pass**

Run: `cd frontend && npx vitest run src/features/training/runLogic.test.ts src/features/training/useTrainUrl.test.tsx src/features/training/ModelVersionsTable.test.tsx` — Expected: PASS (the table still works through the moved `headlineScore`; its own test file keeps passing until Task 9).

- [ ] **Step 5: Commit**

```bash
git add frontend/src/features/training
git commit -m "feat: run logic helpers and URL state for the Train workspace

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Data hooks

**Files:**
- Create: `frontend/src/features/training/{useRuns.ts, useActiveRun.ts, useRunMetrics.ts, useRunLog.ts}` and a test file for each.

**Interfaces:**
- Consumes: `apiClient`, generated types.
- Produces (all hooks guard against stale responses with a request counter):
  - `useRuns(datasetId: number | null): { runs: TrainingRunRead[]; loading: boolean; error: string | null; refresh: () => Promise<void> }` — `GET /training/runs` with `query: { dataset_id, limit: 200 }`; clears `runs` when `datasetId` changes; `null` dataset → empty, no request
  - `useActiveRun(onFinished: (run: TrainingRunRead) => void): { run: TrainingRunRead | null; refresh: () => Promise<void> }` — finds a pending/running run with `GET /training/runs` (`query: { limit: 20 }`), polls `GET /training/runs/{run_id}` every 2000 ms while active, calls `onFinished` once when it turns terminal
  - `useRunMetrics(runId: number | null, active: boolean, epoch: number): { data: RunMetricsRead | null; error: boolean; loading: boolean }` — loads on id change, reloads when `epoch` changes while `active`, loads once more when `active` flips to false
  - `useRunLog(runId: number | null, active: boolean): { text: string; error: boolean }` — loads the log from offset 0 on id change; while `active` polls the tail past the stored offset every 2000 ms; an `offset` smaller than the stored one (server reset) restarts from 0

- [ ] **Step 1: Write the failing tests**

Mock `apiClient` the way `TrainPage.test.tsx` does (`vi.mock("../../shared/api/client", () => ({ apiClient: { GET: vi.fn(), POST: vi.fn(), DELETE: vi.fn() } }))`) and use `renderHook`; fake timers (`vi.useFakeTimers({ shouldAdvanceTime: true })`) for polling. Tests to write (one `describe` per hook):

`useRuns.test.ts`:
```ts
it("requests the runs of the dataset, newest first from the server, with a limit", async () => {
  vi.mocked(apiClient.GET).mockResolvedValue({ data: [{ id: 2 }, { id: 1 }], error: undefined } as never);
  const { result } = renderHook(() => useRuns(496));
  await waitFor(() => expect(result.current.runs).toHaveLength(2));
  expect(apiClient.GET).toHaveBeenCalledWith("/training/runs", {
    params: { query: { dataset_id: 496, limit: 200 } },
  });
});
it("does nothing without a dataset", ...);                         // runs [], GET not called
it("empties the list when the dataset changes and ignores a late answer for the old one", ...);
// two deferred promises: dataset 1 resolves AFTER dataset 2 -> result shows dataset 2's runs
it("reports a failed request", ...);                              // error "Could not load runs." and runs []
it("refresh() reloads", ...);
```
`useActiveRun.test.ts`: picks the pending/running run from the list; no polling when none; polls `/training/runs/{run_id}` every 2 s while active; on a terminal response calls `onFinished` exactly once and stops polling; `refresh()` re-discovers a newly started run.
`useRunMetrics.test.ts`: requests `/training/runs/{run_id}/metrics`; reloads when `epoch` increments while active; does not reload on unrelated re-render; one final load when `active` becomes false; ignores a stale answer after the run id changed; `runId === null` → `data: null`, no request.
`useRunLog.test.ts`: first request has `offset: 0`; while active each tick asks for `offset` = the last returned offset and appends `text`; a returned `offset` smaller than the stored one replaces the text from a fresh request with `offset: 0`; stops polling when `active` is false; ignores a stale answer after the run id changed; resets `text` on id change.

Each test asserts the exact `apiClient.GET` arguments (`"/training/runs/{run_id}/log"` with `params: { path: { run_id }, query: { offset } }`).

- [ ] **Step 2: Run to verify failure**

Run: `cd frontend && npx vitest run src/features/training/use`
Expected: FAIL (modules missing).

- [ ] **Step 3: Implement**

Common pattern for each hook (shown for `useRuns`; apply the same counter to every async load):

```ts
// useRuns.ts
import { useCallback, useEffect, useRef, useState } from "react";

import { apiClient } from "../../shared/api/client";
import type { components } from "../../shared/api/generated/schema";

type TrainingRunRead = components["schemas"]["TrainingRunRead"];

export function useRuns(datasetId: number | null) {
  const [runs, setRuns] = useState<TrainingRunRead[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Only the newest request may write state: a slower answer for a dataset the
  // user has already left must not replace the current list.
  const requestRef = useRef(0);

  const load = useCallback(async () => {
    const requestId = ++requestRef.current;
    if (datasetId === null) {
      setRuns([]);
      setError(null);
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const { data, error: failed } = await apiClient.GET("/training/runs", {
        params: { query: { dataset_id: datasetId, limit: 200 } },
      });
      if (requestId !== requestRef.current) return;
      if (failed || !data) {
        setRuns([]);
        setError("Could not load runs.");
      } else {
        setRuns(data);
      }
    } catch {
      if (requestId === requestRef.current) {
        setRuns([]);
        setError("Could not load runs.");
      }
    } finally {
      if (requestId === requestRef.current) setLoading(false);
    }
  }, [datasetId]);

  useEffect(() => {
    setRuns([]);
    void load();
  }, [load]);

  return { runs, loading, error, refresh: load };
}
```

`useActiveRun.ts`: state `run`; `discover()` = `GET /training/runs` with `limit: 20`, choose the first run whose status is `pending` or `running` (else `null`); an effect runs `discover` once on mount; a second effect keyed on `run?.id` + `run?.status` sets an interval (2000 ms) calling `GET /training/runs/{run_id}`, guarded by a counter, `setRun(data)`; when `data.status` is terminal (`succeeded`/`failed`/`stopped`) clear the interval, call `onFinished(data)` (kept in a ref so the effect does not re-run when the callback identity changes) and keep the finished run in state until `refresh()` finds none. `refresh` = `discover`.

`useRunMetrics.ts`: effect keyed on `[runId, epoch (only when active), active]` loading `GET /training/runs/{run_id}/metrics`, counter-guarded; `data` reset to `null` when `runId` changes; the dependency `epoch` is ignored when `!active` (use `active ? epoch : -1`).

`useRunLog.ts`: refs `offsetRef`, `requestRef`; effect on `[runId]` resets `text`, `offsetRef=0` and loads the full log; effect on `[runId, active]` sets the polling interval only when `active`; `fetchTail()` reads `data.offset`; if `data.offset < offsetRef.current` (log was reset) set `text` to `data.text`-from-offset-0 by re-requesting with offset 0; else append `data.text` and store `data.offset`.

- [ ] **Step 4: Run to verify pass**

Run: `cd frontend && npx vitest run src/features/training/use` and the tsc filter. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/features/training
git commit -m "feat: data hooks for runs, the active run, run metrics and the run log

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Dataset rail and the launch form without its own dataset select

**Files:**
- Create: `frontend/src/features/training/DatasetRail.tsx`, `DatasetRail.test.tsx`
- Modify: `DatasetCard.tsx` (+ test), `TrainConfigForm.tsx` (+ `TrainConfigForm.test.tsx`)

**Interfaces:**
- Consumes: `DatasetOption`, `DatasetCard`, `SettingsValues`, `valuesFromConfig`.
- Produces:
  - `DatasetCard` gains an optional `runCount?: number` prop rendering "N runs" (singular "1 run") on its first row; absent when `undefined`
  - `DatasetRail({ datasets, selectedId, onSelect, runCount })` — one `<select id="train-dataset">` (label "Dataset"; option text `${name} · ${taskType} · ${itemCount} frames`; datasets without an export are disabled with " — export it first"; a "Select a dataset" placeholder) and `<DatasetCard dataset={selected} runCount={runCount}/>`
  - `TrainConfigForm` props change to `{ dataset: DatasetOption | null; disabled; onSubmit; baseModels?; baseModelsError?; settingsSchema?; settingsSchemaError?; prefill?: { nonce: number; baseKey: string; values: SettingsValues } | null; clearTextSignal?: number }`; `TrainConfigValues.datasetId` comes from `dataset.id`; the form no longer renders the dataset select or the dataset card, and no longer has `datasets`/`onDatasetChange`/the preselect effect

- [ ] **Step 1: Write the failing tests**

`DatasetRail.test.tsx`:
```tsx
it("lists datasets with task and frame count and disables the ones without an export", ...);
it("reports the chosen dataset id, and null for the placeholder", ...);
it("shows the card of the selected dataset with its run count", ...);   // "3 runs", "1 run"
it("shows nothing but the select when no dataset is selected", ...);
```
`DatasetCard.test.tsx`: add "shows the run count when given (plural and singular) and nothing when omitted".

`TrainConfigForm.test.tsx` (update the existing file; the dataset-preselect, manual-choice, not-exported-option, dataset-announce and dataset-card tests move to `DatasetRail`/Page tests and are removed here):
```tsx
it("is disabled until a dataset is given, and for a dataset without an export", ...);
it("submits the dataset id of the dataset prop", ...);               // dataset={...id: 1} -> datasetId: 1
it("applies a prefill once its base model and schema are available", async () => {
  // render with baseModels + schema + prefill {nonce: 1, baseKey: "version:7", values: {..., epochs: 12}}
  // expect base select value "version:7" and Epochs field 12; the summary lists "Epochs 12 (default 50)"
});
it("applies a prefill that arrives before the catalog and schema as soon as both are loaded", ...);
it("falls back to the first pretrained model when the prefilled base is no longer offered", ...);
it("does not re-apply the same prefill nonce, so later edits survive", ...);
it("clears the name and the note, but keeps the settings, when clearTextSignal changes", async () => {
  // type name + note + Epochs 25; rerender with clearTextSignal 1 -> name "" note "" Epochs still 25
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd frontend && npx vitest run src/features/training/DatasetRail.test.tsx src/features/training/DatasetCard.test.tsx src/features/training/TrainConfigForm.test.tsx`
Expected: FAIL.

- [ ] **Step 3: Implement**

`DatasetCard.tsx`: add `runCount?: number` to the props; in the first row, between the task badge and the frame count, render `{runCount !== undefined && <span>{runCount} {runCount === 1 ? "run" : "runs"}</span>}`.

`DatasetRail.tsx`:
```tsx
import { DatasetCard, type DatasetOption } from "./DatasetCard";

interface DatasetRailProps {
  datasets: DatasetOption[];
  selectedId: number | null;
  onSelect: (id: number | null) => void;
  runCount?: number;
}

export function DatasetRail({ datasets, selectedId, onSelect, runCount }: DatasetRailProps) {
  const selected = datasets.find((dataset) => dataset.id === selectedId) ?? null;
  return (
    <div className="flex flex-col gap-3">
      <label htmlFor="train-dataset" className="text-xs uppercase tracking-wide text-gray-400">
        Dataset
      </label>
      <select
        id="train-dataset"
        className="rounded border border-gray-700 bg-gray-950 px-2 py-1 text-sm text-gray-100"
        value={selectedId ?? ""}
        onChange={(event) => onSelect(event.target.value === "" ? null : Number(event.target.value))}
      >
        <option value="" disabled>
          Select a dataset
        </option>
        {datasets.map((dataset) => (
          <option key={dataset.id} value={dataset.id} disabled={!dataset.exported}>
            {`${dataset.name} · ${dataset.taskType} · ${dataset.itemCount} frames`}
            {!dataset.exported ? " — export it first" : ""}
          </option>
        ))}
      </select>
      <DatasetCard dataset={selected} runCount={runCount} />
    </div>
  );
}
```

`TrainConfigForm.tsx`: read the file first. Remove: the `datasets` prop, `datasetId` state, the preselect effect, the announce effect, the Dataset `<select>` block and the `<DatasetCard/>`. Use `dataset?.id` where `datasetId` was used; Start is disabled when `disabled || !dataset || !dataset.exported || baseKey === "" || !settingsSchema || errors`. Prefill:

```tsx
const appliedPrefillRef = useRef<number | null>(null);
useEffect(() => {
  if (!prefill || appliedPrefillRef.current === prefill.nonce) return;
  // Wait until the catalog and the schema belong to the dataset the run was on.
  if (baseModels.length === 0 || !settingsSchema) return;
  appliedPrefillRef.current = prefill.nonce;
  setBaseKey(baseModels.some((option) => keyOf(option) === prefill.baseKey) ? prefill.baseKey : firstPretrainedKey(baseModels));
  setValues(prefill.values);
}, [prefill, baseModels, settingsSchema]);
```
(`firstPretrainedKey` is the existing "first pretrained option" selection logic, extracted into a helper; the existing effect that resets `baseKey` when the list changes must not undo an applied prefill: keep it as is — a prefilled key that is offered stays valid.) The existing effect that resets `values` when `settingsSchema` changes runs on schema identity; make it skip while a not-yet-applied prefill is pending for the new schema by ordering: the prefill effect is declared AFTER it and overwrites. Clear signal:

```tsx
const firstSignalRef = useRef(true);
useEffect(() => {
  if (firstSignalRef.current) { firstSignalRef.current = false; return; }
  setName("");
  setNote("");
}, [clearTextSignal]);
```

- [ ] **Step 4: Run to verify pass**

Run: `cd frontend && npx vitest run src/features/training/DatasetRail.test.tsx src/features/training/DatasetCard.test.tsx src/features/training/TrainConfigForm.test.tsx src/features/training/RunSummary.test.tsx src/features/training/SettingsForm.test.tsx` plus the tsc filter. `TrainPage.tsx`/`TrainPage.test.tsx` fail to compile against the new props until Task 9; to keep this commit green, adapt `TrainPage.tsx` minimally here (render a `DatasetRail` above the form in the left column, own the selected dataset id in `useState`, pass `dataset` to the form) and keep its tests green by updating the dataset selection steps (`getByLabelText(/dataset/i)` now belongs to the rail). Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/features/training
git commit -m "feat: dataset rail; launch form takes the dataset, a prefill and a clear signal

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 7: Runs table

**Files:**
- Create: `frontend/src/features/training/RunsTable.tsx`, `RunsTable.test.tsx`

**Interfaces:**
- Consumes: `formatDuration`, `settingsLine`, `headlineScore`, `bestRunId`, `TrainingRunRead`.
- Produces: `RunsTable({ runs, selectedRunId, loading, error, onOpen(runId), onRepeat(run), onDelete(run), deleteError })`:
  - empty state "No runs on this dataset yet. Start one from the New run tab." (not shown while `loading`, and replaced by `error` text when set)
  - one row per run: `#id`, name (note beneath, muted and truncated), base (`yolo11n.pt` or `↳ <base_model>` for a fine-tune), `settingsLine(config)`, a status badge (colours as in the old panel: pending gray, running blue, succeeded green, failed red, stopped yellow), headline metric (`value label`, the best run's value emphasised with `font-semibold text-green-300` and `title="Best on this dataset"`), duration (running runs use now), created date, actions: **Open** (button, `aria-label="Open run <id>"`), **Repeat with changes**, **Delete** (arm/confirm like the old table: first press "Delete" → "Confirm"; disabled with `title="Delete the model first"` when `model_version_id !== null`, and `title="Stop the run first"` when pending/running)
  - the selected row has `aria-current="true"` and a highlighted background; the row is also clickable to open
  - `deleteError` (string | null) renders in a `role="alert"` line above the table

- [ ] **Step 1: Write the failing tests**

```tsx
const base = {
  id: 1, dataset_id: 496, status: "succeeded", task_type: "detection", name: null, note: null,
  base_model: "yolo11n.pt", base_model_version_id: null, model_version_id: null,
  config: { imgsz: 640, batch: 4, epochs: 50 }, metrics: { "metrics/mAP50(B)": 0.5 },
  started_at: "2026-10-09T10:00:00Z", finished_at: "2026-10-09T10:01:05Z",
  created_at: "2026-10-09T09:59:00Z", current_epoch: 50, total_epochs: 50, error: null,
};

it("shows an empty state, a loading state and an error instead of a blank table", ...);
it("renders id, name with its note, base, settings line, status, metric and duration", ...);
// "#1", "big frames", note text, "yolo11n.pt", "640 · b4 · 50 ep", "succeeded", "0.500", "1m 05s"
it("marks a fine-tune with the parent", ...);                       // "↳ parent-model"
it("emphasises only the best run's metric", ...);                   // two runs: 0.3 and 0.7 -> only 0.7 has the title "Best on this dataset"
it("opens a run from the Open button and from a click on the row", ...);
it("repeats with changes", ...);                                    // onRepeat called with the run
it("arms before deleting", async () => {
  // click Delete -> onDelete not called; button now says Confirm; click Confirm -> onDelete(run)
});
it("disables Delete for a run that owns a model and for an active run, with the reason", ...);
it("highlights the selected row", ...);                             // aria-current
it("shows the delete error", ...);                                  // role="alert" with the text
```

- [ ] **Step 2: Run to verify failure**

Run: `cd frontend && npx vitest run src/features/training/RunsTable.test.tsx` — Expected: FAIL.

- [ ] **Step 3: Implement**

`RunsTable.tsx` following the contract above. Keep `STATUS_STYLES` (copy from `TrainRunPanel.tsx`). Row click handler on the `<tr>` must not fire when the click came from a button inside the row (`event.target.closest("button")`). Local state `armed: number | null` (one run armed at a time; disarm when `runs` changes). Dark theme classes only; table `w-full text-left text-sm`; the table lives in a container that scrolls horizontally when narrow (`overflow-x-auto`).

- [ ] **Step 4: Run to verify pass**

Run: `cd frontend && npx vitest run src/features/training/RunsTable.test.tsx` and the tsc filter. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/features/training
git commit -m "feat: runs history table with best-run emphasis, repeat and delete

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 8: Run details

**Files:**
- Create: `frontend/src/features/training/{PerClassTable.tsx, RunDetail.tsx, RunOverview.tsx, RunMetricsView.tsx, RunLogView.tsx, RunModelView.tsx}` and a test file for each of `PerClassTable`, `RunOverview`, `RunMetricsView`, `RunLogView`, `RunModelView`, `RunDetail`.

**Interfaces:**
- Consumes: `useRunMetrics`, `useRunLog`, `MetricsChart`, `ConfusionMatrix`, `ArtifactGallery`, `LogView`, `runLogic`, `SettingsSchema`, `apiClient`.
- Produces:
  - `PerClassTable({ rows })` — the per-class table with `deriveColumns` and sortable columns **extracted unchanged** (code and tests) from `ModelInfoPanel.tsx` / `ModelInfoPanel.test.tsx`
  - `RunDetail({ run, view, onViewChange, onBack, schema, onRepeat(run), onDeleteRun(run), onChanged(), deleteError })` — a header (`← Runs`, `#id`, name, status badge), the four sub-tabs (`role="tablist"`: Overview, Metrics, Log, Model; `Model` disabled with a hint when the run has no model), and the active view:
    - `RunOverview({ run, schema, ..., onChanged })`: name (input, saved on blur through `PATCH /training/runs/{run_id}` only when it changed; Escape restores) and note (textarea, same), error banner when `run.error`, live progress (bar + "Epoch n / total") while the run is active, the configuration grouped by schema groups (`schema` may be null: then one flat "Settings" list of raw keys) showing label and value, with non-default values emphasised and "(default X)", keys missing from the schema shown raw; final metrics table (all numeric keys of `run.metrics`); the training curve (`MetricsChart`, from `useRunMetrics`, live while active); actions: Repeat with changes, Download model (when a model exists), Delete run (arm/confirm; disabled as in the table)
    - `RunMetricsView({ run })`: `useRunMetrics`; curve, confusion matrix (`ConfusionMatrix`), per-class table; each section has a one-line caption of what it shows; empty states ("No per-class metrics for this run", "No confusion matrix")
    - `RunLogView({ run })`: `useRunLog(run.id, active)` into `LogView`; a caption "Cleaned view of the trainer's output; the stored log is raw."
    - `RunModelView({ run, onChanged })`: the model's name, task, headline score (from `GET /training/models` filtered by `run.model_version_id`), the artifact gallery (artifacts from `GET /training/models/{version_id}/metrics`), Download, Delete model (arm/confirm; a 409 shows the server's message in a `role="alert"` line; on success calls `onChanged()`)

- [ ] **Step 1: Write the failing tests**

`PerClassTable.test.tsx`: move the per-class cases from `ModelInfoPanel.test.tsx` (columns derived from rows, sorting, empty).

`RunOverview.test.tsx` (mock `apiClient`, `useRunMetrics` real over the mock):
```tsx
it("shows the settings grouped by the schema, emphasising non-default values and showing the default", ...);
it("shows raw keys for settings the schema does not know and still works with no schema", ...);
it("saves a changed name on blur with PATCH and does not call it when unchanged", async () => {
  // type a new name, blur -> apiClient.PATCH("/training/runs/{run_id}", { params: { path: { run_id: 1 } }, body: { name: "new" } }); onChanged called
});
it("restores the name on Escape without saving", ...);
it("shows the run's error and live progress for an active run, and no progress for a finished one", ...);
it("lists the final numeric metrics", ...);
it("repeats with changes and deletes with an arm/confirm step; delete is disabled with the reason when the run owns a model", ...);
it("offers a model download only when a model exists", ...);
```
`RunMetricsView.test.tsx`: renders curve/matrix/per-class from the metrics response; empty states; still shows everything for a run whose model was deleted (`model_version_id: null` but metrics present).
`RunLogView.test.tsx`: renders the cleaned log from the hook; polls only while active.
`RunModelView.test.tsx`: shows model details and artifacts; Delete model needs a confirm; a 409 message appears and `onChanged` is not called; success calls `onChanged`.
`RunDetail.test.tsx`: tab switching reports `onViewChange`; `Model` tab disabled without a model; `← Runs` calls `onBack`.

- [ ] **Step 2: Run to verify failure**

Run: `cd frontend && npx vitest run src/features/training/PerClassTable.test.tsx src/features/training/RunOverview.test.tsx src/features/training/RunMetricsView.test.tsx src/features/training/RunLogView.test.tsx src/features/training/RunModelView.test.tsx src/features/training/RunDetail.test.tsx`
Expected: FAIL.

- [ ] **Step 3: Implement**

Build each component to the contract above. Notes that matter:
- `PerClassTable.tsx`: cut `deriveColumns`, `formatCell`, `SortState` and the table markup out of `ModelInfoPanel.tsx` unchanged; `ModelInfoPanel.tsx` keeps working (importing it) until Task 9 deletes it.
- Name/note inline edit: local state initialised from `run.name ?? ""`/`run.note ?? ""`, re-synced when `run.id` or the server value changes while not focused; blank saves as `null`-equivalent (the backend turns blank into null).
- The PATCH call: `apiClient.PATCH("/training/runs/{run_id}", { params: { path: { run_id: run.id } }, body: { name } })` — add `PATCH: vi.fn()` to the mock objects of existing page tests.
- Overview configuration table: the schema's `groups[].fields[]` give label and default; for a value use `String(run.config[key])`; `isChanged` semantics from `settingsLogic` (`value !== default`); emphasis `text-blue-300`.
- "Delete run": `apiClient.DELETE("/training/runs/{run_id}", …)` is performed by the parent (`onDeleteRun`), the component only arms/confirms.
- `RunModelView`: Download uses `GET /training/models/{version_id}/download` then `window.open(url, "_blank", "noopener,noreferrer")` (same as the old page); Delete model uses `DELETE /training/models/{version_id}` and shows `detail` from a 409.
- All dark-theme classes; sections `rounded border border-gray-800 bg-gray-900 p-4`; charts keep their own fixed 640×280 viewBox and render inside a container with `max-w-full` so they scale down but never collapse (minimum height ~280 px).

- [ ] **Step 4: Run to verify pass**

Run the Step 2 command and the tsc filter. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/features/training
git commit -m "feat: run details with overview, metrics, readable log and model views

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 9: The workspace shell, the active-run strip and removal of the old panels

**Files:**
- Create: `frontend/src/features/training/ActiveRunStrip.tsx`, `ActiveRunStrip.test.tsx`
- Rewrite: `frontend/src/features/training/TrainPage.tsx`, `TrainPage.test.tsx`
- Delete: `TrainRunPanel.tsx`, `TrainRunPanel.test.tsx`, `ModelVersionsTable.tsx`, `ModelVersionsTable.test.tsx`, `ModelInfoPanel.tsx`, `ModelInfoPanel.test.tsx`

**Interfaces:**
- Consumes: everything above.
- Produces:
  - `ActiveRunStrip({ run, headline, onStop, stopPending, onOpen })` — rendered only for a pending/running run: `▶ #id · <name or base> · epoch n / total · <headline label value> · [Stop]`, a thin progress bar (`role="progressbar"`), the sentence "Stops after the current epoch finishes." beside Stop, clicking the text area calls `onOpen`; `stopPending || run.stop_requested` → "Stopping…" disabled
  - `TrainPage` — the workspace: header "Train", the family tab strip ("YOLO"), the strip, then a two-column layout: **left rail** (fixed width `w-72 shrink-0`, `DatasetRail`) and **main** (`min-w-0 flex-1`) with the two tabs "Runs" / "New run"; `Runs` shows `RunsTable` or, when `run` is set in the URL and found among this dataset's runs, `RunDetail`; `New run` shows `TrainConfigForm` in a `max-w-3xl` container. The page itself scrolls (no `h-full overflow-hidden` ancestors; remove the old fixed-height grid)

- [ ] **Step 1: Write the failing tests**

`ActiveRunStrip.test.tsx`: renders id/name/epoch/headline; progress value; Stop calls `onStop` and shows "Stopping…" disabled when `stop_requested`; the epoch-boundary sentence; click opens; renders nothing for a finished run.

`TrainPage.test.tsx` — rewrite around `MemoryRouter` (`initialEntries=["/train?dataset=496"]`) with `apiClient` mocked by path (reuse the existing branch-by-path mock style; every GET the page makes needs a branch: `/datasets`, `/training/runs`, `/training/runs/{run_id}`, `/training/runs/{run_id}/log`, `/training/runs/{run_id}/metrics`, `/training/base-models`, `/training/settings-schema`, `/training/models`). Tests:
```tsx
it("preselects the first exported dataset in the URL when none is given, without adding a history entry", ...);
it("shows the datasets in the rail, and this dataset's runs in the Runs tab", ...);
it("shows the run count in the dataset card", ...);
it("opens a run's details when its row is opened and puts it in the URL; Back returns to the table", ...);
it("falls back to the table with a message when the run in the URL is not one of this dataset's runs", ...);
it("switches to the New run tab, loads the catalog and the schema for the dataset and submits the new body", ...);
it("after a successful Start it opens the new run, clears name and note and keeps the settings", ...);
it("repeat with changes switches to the New run tab with the run's base model and settings", ...);
it("shows the active-run strip on every tab and Stop posts to the stop endpoint", ...);
it("refreshes the runs table when the active run finishes", ...);
it("deletes a run after confirmation and refreshes the table; shows the server's message on a 409", ...);
it("a late answer for a previously selected dataset never replaces the current dataset's runs", ...);
it("keeps in-progress edits in the form while the active run is polled", ...);   // carried over from Plan 1
```
Carry over from the old `TrainPage.test.tsx` every still-relevant behaviour (catalog and schema stale-response guards, base-model catalog reload when versions change, POST body shape); reuse their mock scaffolding.

- [ ] **Step 2: Run to verify failure**

Run: `cd frontend && npx vitest run src/features/training/ActiveRunStrip.test.tsx src/features/training/TrainPage.test.tsx` — Expected: FAIL.

- [ ] **Step 3: Implement**

`ActiveRunStrip.tsx` per the contract (dark classes, `sticky top-0 z-10`? no: a normal full-width bar `rounded border border-blue-900 bg-gray-900 px-4 py-2`, so it never overlays content).

`TrainPage.tsx`: read the current file first and keep the following logic (move it into the new structure, do not lose it): the catalog loader with its request counter and the reload when the versions list changes, the settings-schema loader with its request counter, `handleStop`, `handleSubmit` body shape. New structure:
- `const [url, setUrl] = useTrainUrl();` datasets via `GET /datasets` (mapping from Plan 1); when `url.dataset === null` and datasets arrive, `setUrl({ dataset: <first exported id> }, { replace: true })`.
- `const { runs, loading, error, refresh: refreshRuns } = useRuns(url.dataset);`
- `const active = useActiveRun((finished) => { void refreshRuns(); void refreshVersionsCatalog(); })`.
- `const activeMetrics = useRunMetrics(active.run?.id ?? null, Boolean(active.run && isActive(active.run)), active.run?.current_epoch ?? 0)`; the strip's headline = `headlineScore(run.task_type, lastHistoryPoint)` where the last history point is `activeMetrics.data?.history.at(-1)` (a flat numeric dict; unknown vocabulary falls back to its first numeric entry like `headlineScore` does), shown as `—` before the first epoch.
- When `url.dataset` changes: `loadBaseModels(dataset)` and `loadSettingsSchema(dataset)` (as in Plan 1).
- Open run: `setUrl({ tab: "runs", run: id })`; back: `setUrl({ run: null, view: "overview" })`; sub-tab: `setUrl({ view })`.
- Start: on success `await refreshRuns(); active.refresh(); setUrl({ tab: "runs", run: data.id, view: "overview" }); setClearSignal(n => n + 1)`.
- Repeat: `setPrefill({ nonce: ++nonceRef.current, baseKey: baseKeyFromRun(run), values: schema ? valuesFromConfig(schema, run.config) : {} })` — but the schema belongs to the dataset of the run, which is the selected dataset (runs list is per dataset), so it is already loaded; then `setUrl({ tab: "new" })`.
- Delete run: `apiClient.DELETE("/training/runs/{run_id}", …)`; on error show `detail`; on success `refreshRuns()` and, if it was the open run, `setUrl({ run: null })`.
- Run in the URL not among `runs` (after loading finished, no error): render the table and a muted line "Run #N is not on this dataset (it may have been deleted)."
- The Runs and New run tab buttons are `role="tab"` inside `role="tablist"`; the tab panel containers are `role="tabpanel"`.
- Remove the old versions list/`ModelInfoPanel` wiring; the old fixed-height grid is replaced by normal flow: `<div className="flex flex-col gap-4 bg-gray-950 p-8 text-gray-100">` … and a body `flex gap-6 items-start` with the rail (`sticky top-4 w-72 shrink-0`) and the main area.
Then delete the six old files listed above (their tests go with them; every behaviour they covered is covered by the new tests: log scrolling in `LogView.test`, per-class in `PerClassTable.test`, model delete/409 in `RunModelView.test`, stop in `ActiveRunStrip.test`).

- [ ] **Step 4: Run to verify pass**

Run: `cd frontend && npx vitest run src/features/training`, the tsc filter, and `grep -rn "TrainRunPanel\|ModelVersionsTable\|ModelInfoPanel" frontend/src` (must print nothing outside git history).
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A frontend/src/features/training
git commit -m "feat: Train workspace shell with dataset rail, runs history and active-run strip

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 10: Live verification and ROADMAP

No new code unless the live pass finds a defect (then use superpowers:systematic-debugging, fix test-first, record it as a deviation). Controller-executed. **Each step that touches the real DB, rebuilds `ml-worker` or starts servers needs the user's approval at the time.**

- [ ] **Step 1: Deploy in this order.** (a) Back up `training_runs` and `model_versions` to the scratchpad; apply `alembic upgrade head` (head `e6f7a8b9c0d1`); check that the existing run 268 now carries its version's per-class metrics and confusion matrix (`select jsonb_array_length(per_class_metrics::jsonb), confusion_matrix is not null from training_runs where id=268`). (b) Rebuild and recreate `ml-worker`; check the image holds the new `tasks.py` (`grep -c per_class_metrics /app/app/tasks.py`). (c) Only then (re)start the backend and the Vite dev server (if not already running; a running uvicorn with `--reload` picks the code up, check `/openapi.json` lists `/training/runs/{run_id}/metrics`).
- [ ] **Step 2: Real browser pass** (`manualcheck@example.com` / `manual-check-pass`), 1920×1080 and a narrow viewport (about 900 px): the page scrolls as a whole; the rail stays beside the main area; no block is stretched to the viewport height or collapsed. Walk through: dataset switch (URL changes, run cleared), the Runs table for dataset 496 (existing run 268 with its model: Delete disabled with the reason), run details (Overview: grouped settings with defaults, metrics, curve; Metrics: per-class table and confusion matrix from the run; Log: cleaned output of run 268, compare with the raw log; Model: artifacts, download), refresh the page on a run detail (state restored from the URL), browser Back/Forward, an invalid `?run=99999` (message, no crash).
- [ ] **Step 3: Real runs, size n only.** Start a Quick check run from the New run tab (name + note), watch the active-run strip and the live curve update per epoch, open its Log tab while it runs (tail only, cleaned), after it finishes check the table row (headline metric, duration, name and note), use Repeat with changes (the form opens with the run's base and settings; the form must not start anything by itself), change one value and start a second run, then verify the best-run emphasis between the two. Delete one run's model from its Model tab and confirm its Metrics tab still shows the per-class table and matrix; then delete the run (allowed now) and check the row, the job and MinIO are gone.
- [ ] **Step 4: Clean up unprompted:** versions via the API, runs and their jobs by precise predicate, MinIO `models/<run id>/` prefixes; compare against the Step 1 backup (original columns only: the migration added two).
- [ ] **Step 5: ROADMAP.** Add "Phase 2b: Train workspace, plan 2 (history) — DONE (date)" with spec/plan links, the commit range, what Steps 1–4 actually verified, every deviation found, and the open items (Plan 3 compare view; the preset numbers; whether the active-run strip's headline vocabulary needs more known keys).
- [ ] **Step 6: Commit** `docs: record Train workspace plan 2`.

---

## Self-Review

- **Spec coverage:** per-class/confusion on the run with backfill (Tasks 1–2); `GET /training/runs?dataset_id&limit`, `model_version_id`, run metrics endpoint, run delete (Task 1); log cleaning (Task 3); URL state, best-run emphasis, duration, settings line, repeat prefill logic (Task 4); live curve and tail-only polling hooks (Task 5); dataset rail with run count, form clear-after-start and prefill (Task 6); runs table (Task 7); run details with Overview/Metrics/Log/Model, inline name and note, delete model (Task 8); active-run strip, page shell, sizing rules, removal of the old panels (Task 9); live verification (Task 10). Plan 3 items (compare view and its checkboxes) are absent by design.
- **Placeholder scan:** hook tests and component tests for Tasks 5, 6, 8 and 9 are listed by behaviour with the exact `apiClient` argument shapes and the assertions they must make; the implementer writes their bodies in the style of the existing `TrainPage.test.tsx` mocks. Pure logic, backend and worker code is given in full.
- **Type consistency:** `TrainUrlState`, `useTrainUrl`, `headlineScore`/`headlineValue`, `valuesFromConfig`, `baseKeyFromRun`, the hooks' return shapes, the `prefill` object (`{ nonce, baseKey, values }`), `RunMetricsRead` and `model_version_id` are used identically across Tasks 1–9.
