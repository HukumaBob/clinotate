# Training Base Models and Fine-tuning Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The Train screen's Base model field lists real, task-aware YOLO11 weights (n/s/m/l/x for detection, `-seg`, `-cls`) and can start from an existing `ModelVersion` (fine-tuning).

**Architecture:** A backend catalog module (keyed by adapter name) feeds a new `GET /training/base-models` endpoint; `TrainingRun` gains a nullable `base_model_version_id` FK. `ml-worker` downloads the parent's `.pt` into the run's temp dir and passes the path to the unchanged `TrainingAdapter`. The frontend form becomes a consumer of the catalog; `TrainPage` owns the fetch.

**Tech Stack:** FastAPI, SQLAlchemy, Alembic, Celery (ml-worker), Ultralytics 8.4.123, React + Vite + vitest, `openapi-typescript`.

**Spec:** [docs/superpowers/specs/2026-10-08-training-base-models-design.md](../specs/2026-10-08-training-base-models-design.md)

## Global Constraints

- Work directly on `master`; no branches, no worktrees (CLAUDE.md).
- English only in code, comments, UI copy, commit messages.
- Dark theme only; no light-background Tailwind classes.
- TDD: a failing test before every implementation step.
- Backend tests: `import app.db as db_module` + `db_module.SessionLocal()`, never `from app.db import SessionLocal`. They run against `endoscopy_test`.
- Never leave rows in the real `endoscopy` DB; do not truncate it without asking.
- Frontend calls go through `apiClient`; never hand-edit `frontend/src/shared/api/generated/`.
- After any backend schema/route change, regenerate `openapi.json`: `cd backend && PYTHONPATH=. uv run python scripts/export_openapi.py`, then check `git diff --stat openapi.json`.
- `ml-worker` tests: its Dockerfile does not COPY `tests/`; run them with `docker cp` + `docker compose exec` (see the "ml-worker test workflow" memory). `docker cp` does NOT deploy code; rebuild the image for live use.
- Do not stop or start dev servers or touch :5173/:5174 without asking.
- Commit trailer: `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`.

## Review Focus

1. A legacy client posts `base_model: "yolo11s.pt"` for a segmentation dataset: must be normalised to `yolo11s-seg.pt`, not rejected and not silently trained as detection.
2. Both `base_model` and `base_model_version_id` sent, or neither: 422, never a guess.
3. Deleting a version that a later run was fine-tuned from: 409 naming the run, and the weights stay in storage.
4. The parent's weights object is missing from MinIO when the worker starts: run ends FAILED with a readable message, not an Ultralytics path error.
5. A local weights path (`/tmp/.../best.pt`) must never get a `-seg`/`-cls` suffix appended.

## File Structure

- Create `backend/app/training/catalog.py` — adapter-keyed pretrained catalog; pure functions, no DB.
- Create `backend/alembic/versions/c4d5e6f7a8b9_add_training_run_base_model_version.py` — migration.
- Modify `backend/app/training/models.py` — FK column on `TrainingRun`; `ModelVersion.training_run` relationship + two read-only properties.
- Modify `backend/app/training/schemas.py` — `BaseModelOption`, `TrainingRunCreate`, `TrainingRunRead`, `ModelVersionRead`.
- Modify `backend/app/training/service.py` — `list_base_models`, new create rules, delete guard.
- Modify `backend/app/training/router.py` — new endpoint, exception mapping.
- Create `backend/tests/test_training_catalog.py`; modify `backend/tests/test_training_api.py`.
- Modify `ml-worker/app/models.py`, `ml-worker/app/tasks.py`, `ml-worker/app/ultralytics_yolo_adapter.py`; tests in `ml-worker/tests/test_tasks_training.py`, `ml-worker/tests/test_ultralytics_yolo_adapter.py`.
- Modify `frontend/src/features/training/{TrainConfigForm,TrainPage,ModelVersionsTable}.tsx` and their tests.
- Modify `ROADMAP.md`, regenerate `openapi.json`.

---

### Task 1: Backend catalog module

**Files:**
- Create: `backend/app/training/catalog.py`
- Test: `backend/tests/test_training_catalog.py`

**Interfaces:**
- Produces:
  - `ADAPTER_NAME: str = "ultralytics_yolo"`
  - `@dataclass(frozen=True) class PretrainedModel: weights: str; family: str; size: str; note: str | None`
  - `pretrained_models(adapter: str, task_type: TaskType) -> list[PretrainedModel]` (order n, s, m, l, x; empty list for an unknown adapter)
  - `resolve_pretrained(adapter: str, task_type: TaskType, name: str) -> str | None` (the catalog's weights name for `name`, accepting the legacy un-suffixed form; `None` if not in the catalog)
  - `VRAM_NOTE: str = "may not fit in 8 GB"`

- [ ] **Step 1: Write the failing tests**

```python
# backend/tests/test_training_catalog.py
import pytest

from app.datasets.models import TaskType
from app.training import catalog


@pytest.mark.parametrize(
    "task_type, suffix",
    [
        (TaskType.DETECTION, ""),
        (TaskType.SEGMENTATION, "-seg"),
        (TaskType.CLASSIFICATION, "-cls"),
    ],
)
def test_five_sizes_with_the_task_suffix(task_type, suffix):
    models = catalog.pretrained_models(catalog.ADAPTER_NAME, task_type)

    assert [m.weights for m in models] == [
        f"yolo11{size}{suffix}.pt" for size in ("n", "s", "m", "l", "x")
    ]
    assert {m.family for m in models} == {"yolo11"}
    assert [m.size for m in models] == ["n", "s", "m", "l", "x"]


def test_only_l_and_x_carry_the_vram_note():
    models = catalog.pretrained_models(catalog.ADAPTER_NAME, TaskType.DETECTION)

    notes = {m.size: m.note for m in models}
    assert notes == {
        "n": None,
        "s": None,
        "m": None,
        "l": catalog.VRAM_NOTE,
        "x": catalog.VRAM_NOTE,
    }
    assert catalog.VRAM_NOTE == "may not fit in 8 GB"


def test_unknown_adapter_has_no_models():
    assert catalog.pretrained_models("no_such_adapter", TaskType.DETECTION) == []


def test_resolve_accepts_the_exact_catalog_name():
    assert (
        catalog.resolve_pretrained(catalog.ADAPTER_NAME, TaskType.SEGMENTATION, "yolo11m-seg.pt")
        == "yolo11m-seg.pt"
    )


def test_resolve_normalises_the_legacy_unsuffixed_name():
    assert (
        catalog.resolve_pretrained(catalog.ADAPTER_NAME, TaskType.SEGMENTATION, "yolo11s.pt")
        == "yolo11s-seg.pt"
    )
    assert (
        catalog.resolve_pretrained(catalog.ADAPTER_NAME, TaskType.CLASSIFICATION, "yolo11n.pt")
        == "yolo11n-cls.pt"
    )


@pytest.mark.parametrize(
    "task_type, name",
    [
        (TaskType.DETECTION, "yolo11n-seg.pt"),  # wrong task suffix
        (TaskType.SEGMENTATION, "yolo11n-cls.pt"),
        (TaskType.DETECTION, "yolov8n.pt"),  # other family
        (TaskType.DETECTION, "../../etc/passwd"),
        (TaskType.DETECTION, ""),
    ],
)
def test_resolve_rejects_anything_not_in_the_catalog(task_type, name):
    assert catalog.resolve_pretrained(catalog.ADAPTER_NAME, task_type, name) is None
```

- [ ] **Step 2: Run to verify failure**

Run: `cd backend && uv run pytest tests/test_training_catalog.py -v`
Expected: FAIL (`ImportError`/`ModuleNotFoundError: app.training.catalog`).

- [ ] **Step 3: Implement**

```python
# backend/app/training/catalog.py
"""Pretrained base models each training adapter can start from.

Lives in the backend, keyed by adapter name, because the adapters
themselves live in ml-worker and the backend cannot import them. The
worker receives an already-resolved weights name. A second adapter adds an
entry to _TABLES; the Train form does not change.

Weight names were checked against ultralytics 8.4.123 in the ml-worker
image: every size x task combination below exists upstream.
"""

from dataclasses import dataclass

from app.datasets.models import TaskType

ADAPTER_NAME = "ultralytics_yolo"

# The host GPU is 8 GB and has hard-rebooted under VRAM pressure. The note
# warns; it never blocks -- the person decides.
VRAM_NOTE = "may not fit in 8 GB"


@dataclass(frozen=True)
class PretrainedModel:
    weights: str
    family: str
    size: str
    note: str | None


_YOLO11_SIZES = ("n", "s", "m", "l", "x")
_YOLO11_SUFFIX = {
    TaskType.DETECTION: "",
    TaskType.SEGMENTATION: "-seg",
    TaskType.CLASSIFICATION: "-cls",
}


def _yolo11(task_type: TaskType) -> list[PretrainedModel]:
    suffix = _YOLO11_SUFFIX[task_type]
    return [
        PretrainedModel(
            weights=f"yolo11{size}{suffix}.pt",
            family="yolo11",
            size=size,
            note=VRAM_NOTE if size in ("l", "x") else None,
        )
        for size in _YOLO11_SIZES
    ]


_TABLES = {ADAPTER_NAME: _yolo11}


def pretrained_models(adapter: str, task_type: TaskType) -> list[PretrainedModel]:
    build = _TABLES.get(adapter)
    return build(task_type) if build else []


def resolve_pretrained(adapter: str, task_type: TaskType, name: str) -> str | None:
    """The catalog's weights name for `name`, or None if it is not offered.

    Accepts the legacy un-suffixed form ("yolo11s.pt" on a segmentation
    dataset) because earlier clients sent it and the worker used to add the
    suffix silently; it now resolves to what will actually be trained.
    """
    for model in pretrained_models(adapter, task_type):
        legacy = f"{model.family}{model.size}.pt"
        if name in (model.weights, legacy):
            return model.weights
    return None
```

- [ ] **Step 4: Run to verify pass**

Run: `cd backend && uv run pytest tests/test_training_catalog.py -v`
Expected: PASS (all tests).

- [ ] **Step 5: Commit**

```bash
git add backend/app/training/catalog.py backend/tests/test_training_catalog.py
git commit -m "feat: adapter-keyed pretrained base-model catalog

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Data model, migration, create-run rules, catalog endpoint

**Files:**
- Modify: `backend/app/training/models.py`, `schemas.py`, `service.py`, `router.py`
- Create: `backend/alembic/versions/c4d5e6f7a8b9_add_training_run_base_model_version.py`
- Test: `backend/tests/test_training_api.py`

**Interfaces:**
- Consumes: `catalog.ADAPTER_NAME`, `catalog.pretrained_models`, `catalog.resolve_pretrained`.
- Produces:
  - `TrainingRun.base_model_version_id: int | None` (FK `model_versions.id`)
  - `ModelVersion.training_run` relationship; read-only properties `ModelVersion.base_model: str` and `ModelVersion.base_model_version_id: int | None` (delegating to the run)
  - `schemas.BaseModelOption` (`kind: Literal["pretrained","model_version"]`, `weights: str | None`, `label: str`, `family: str | None`, `size: str | None`, `note: str | None`, `model_version_id: int | None`)
  - `service.list_base_models(session, dataset_id) -> list[BaseModelOption-shaped dict]`; raises `service.DatasetNotFound`
  - `service.create_training_run(session, *, dataset_id, base_model: str | None, base_model_version_id: int | None, config, created_by)`; raises `service.InvalidBaseModel` (router → 422)
  - `GET /training/base-models?dataset_id=N`
  - `TrainingRunRead.base_model_version_id`, `ModelVersionRead.base_model`, `ModelVersionRead.base_model_version_id`
  - `ADAPTER_NAME` in `service.py` becomes `catalog.ADAPTER_NAME`

- [ ] **Step 1: Write the failing tests** (append to `backend/tests/test_training_api.py`; reuse its `_session`, `client`, `_register_and_login`, `_make_dataset`, `_succeeded_export`, `_cleanup`)

First extend `_cleanup` so a child run never blocks deleting its parent version: insert, right after `session.rollback()`:

```python
    session.query(TrainingRun).filter(TrainingRun.dataset_id == dataset_id).update(
        {TrainingRun.base_model_version_id: None}, synchronize_session=False
    )
    session.commit()
```

Then add:

```python
def _user_id(session, email: str) -> int:
    from app.auth.models import User

    return session.query(User).filter(User.email == email).one().id


def _make_version(session, dataset: Dataset, user_id: int, name: str, task_type=TaskType.DETECTION):
    run = TrainingRun(
        dataset_id=dataset.id,
        adapter="ultralytics_yolo",
        base_model="yolo11n.pt",
        task_type=task_type,
        config={},
        status=TrainingRunStatus.SUCCEEDED,
        total_epochs=1,
        created_by_id=user_id,
    )
    session.add(run)
    session.commit()
    version = ModelVersion(
        training_run_id=run.id,
        name=name,
        task_type=task_type,
        storage_key=f"models/{run.id}/best.pt",
        metrics={"metrics/mAP50(B)": 0.61},
    )
    session.add(version)
    session.commit()
    session.refresh(version)
    return version


def _stub_send_task(monkeypatch):
    sent = []
    monkeypatch.setattr(service.celery_app, "send_task", lambda *a, **k: sent.append(a))
    return sent


def test_base_models_lists_five_pretrained_for_the_datasets_task_type():
    email = "train-bm1@example.com"
    headers = _register_and_login(email)
    session = _session()
    dataset = _make_dataset(session, _user_id(session, email))
    try:
        response = client.get(f"/training/base-models?dataset_id={dataset.id}", headers=headers)

        assert response.status_code == 200
        pretrained = [o for o in response.json() if o["kind"] == "pretrained"]
        assert [o["weights"] for o in pretrained] == [
            f"yolo11{s}.pt" for s in ("n", "s", "m", "l", "x")
        ]
        assert [o["note"] for o in pretrained][3:] == ["may not fit in 8 GB"] * 2
    finally:
        _cleanup(session, dataset.id)
        session.close()


def test_base_models_adds_only_versions_of_the_same_task_type():
    email = "train-bm2@example.com"
    headers = _register_and_login(email)
    session = _session()
    user_id = _user_id(session, email)
    dataset = _make_dataset(session, user_id)
    other = _make_dataset(session, user_id)
    try:
        mine = _make_version(session, dataset, user_id, "det-v1", TaskType.DETECTION)
        _make_version(session, other, user_id, "seg-v1", TaskType.SEGMENTATION)

        response = client.get(f"/training/base-models?dataset_id={dataset.id}", headers=headers)

        versions = [o for o in response.json() if o["kind"] == "model_version"]
        assert [(v["model_version_id"], v["label"]) for v in versions] == [(mine.id, "det-v1")]
        assert versions[0]["weights"] is None
        assert "mAP50 0.610" in versions[0]["note"]
    finally:
        _cleanup(session, dataset.id)
        _cleanup(session, other.id)
        session.close()


def test_base_models_unknown_dataset_is_404():
    headers = _register_and_login("train-bm3@example.com")

    assert client.get("/training/base-models?dataset_id=99999999", headers=headers).status_code == 404


def _create(headers, dataset_id, **overrides):
    body = {"dataset_id": dataset_id, "epochs": 1, "batch": 2, **overrides}
    return client.post("/training/runs", json=body, headers=headers)


def test_create_run_requires_exactly_one_base(monkeypatch):
    email = "train-bm4@example.com"
    headers = _register_and_login(email)
    session = _session()
    user_id = _user_id(session, email)
    dataset = _make_dataset(session, user_id)
    _succeeded_export(session, dataset.id, user_id)
    _stub_send_task(monkeypatch)
    try:
        neither = _create(headers, dataset.id)
        both = _create(headers, dataset.id, base_model="yolo11n.pt", base_model_version_id=1)

        assert neither.status_code == 422
        assert both.status_code == 422
    finally:
        _cleanup(session, dataset.id)
        session.close()


def test_create_run_rejects_a_name_not_in_the_catalog(monkeypatch):
    email = "train-bm5@example.com"
    headers = _register_and_login(email)
    session = _session()
    user_id = _user_id(session, email)
    dataset = _make_dataset(session, user_id)
    _succeeded_export(session, dataset.id, user_id)
    _stub_send_task(monkeypatch)
    try:
        response = _create(headers, dataset.id, base_model="yolo11n-cls.pt")  # wrong task

        assert response.status_code == 422
    finally:
        _cleanup(session, dataset.id)
        session.close()


def test_create_run_normalises_the_legacy_name_for_segmentation(monkeypatch):
    email = "train-bm6@example.com"
    headers = _register_and_login(email)
    session = _session()
    user_id = _user_id(session, email)
    dataset = _make_dataset(session, user_id)
    dataset.task_type = TaskType.SEGMENTATION
    session.commit()
    _succeeded_export(session, dataset.id, user_id)
    _stub_send_task(monkeypatch)
    try:
        response = _create(headers, dataset.id, base_model="yolo11s.pt")

        assert response.status_code == 202
        assert response.json()["base_model"] == "yolo11s-seg.pt"
        assert response.json()["base_model_version_id"] is None
    finally:
        _cleanup(session, dataset.id)
        session.close()


def test_create_run_from_a_version_records_the_parent(monkeypatch):
    email = "train-bm7@example.com"
    headers = _register_and_login(email)
    session = _session()
    user_id = _user_id(session, email)
    dataset = _make_dataset(session, user_id)
    _succeeded_export(session, dataset.id, user_id)
    parent = _make_version(session, dataset, user_id, "det-parent")
    _stub_send_task(monkeypatch)
    try:
        response = _create(headers, dataset.id, base_model_version_id=parent.id)

        assert response.status_code == 202
        assert response.json()["base_model_version_id"] == parent.id
        assert response.json()["base_model"] == "det-parent"
    finally:
        _cleanup(session, dataset.id)
        session.close()


def test_create_run_rejects_a_version_of_another_task_type(monkeypatch):
    email = "train-bm8@example.com"
    headers = _register_and_login(email)
    session = _session()
    user_id = _user_id(session, email)
    dataset = _make_dataset(session, user_id)
    _succeeded_export(session, dataset.id, user_id)
    seg_parent = _make_version(session, dataset, user_id, "seg-parent", TaskType.SEGMENTATION)
    _stub_send_task(monkeypatch)
    try:
        response = _create(headers, dataset.id, base_model_version_id=seg_parent.id)

        assert response.status_code == 422
        assert "segmentation" in response.json()["detail"].lower()
    finally:
        _cleanup(session, dataset.id)
        session.close()


def test_create_run_rejects_an_unknown_version(monkeypatch):
    email = "train-bm9@example.com"
    headers = _register_and_login(email)
    session = _session()
    user_id = _user_id(session, email)
    dataset = _make_dataset(session, user_id)
    _succeeded_export(session, dataset.id, user_id)
    _stub_send_task(monkeypatch)
    try:
        assert _create(headers, dataset.id, base_model_version_id=99999999).status_code == 422
    finally:
        _cleanup(session, dataset.id)
        session.close()
```

Existing tests in this file post `base_model: "yolo11n.pt"` for a detection dataset: they must keep passing unchanged (the legacy-compatible name is in the catalog).

- [ ] **Step 2: Run to verify failure**

Run: `cd backend && uv run pytest tests/test_training_api.py -v -k "base_models or base or legacy or parent"`
Expected: FAIL (404 on the new route / `base_model_version_id` unknown).

- [ ] **Step 3: Implement**

`models.py` — add to `TrainingRun` after `base_model`:

```python
    # Set when the run starts from an earlier ModelVersion (fine-tuning);
    # base_model then holds that version's name as a readable label. No
    # ondelete cascade on purpose: deleting a parent that a run was trained
    # from is refused by the service (409), so lineage never dangles.
    base_model_version_id: Mapped[int | None] = mapped_column(
        ForeignKey("model_versions.id"), nullable=True
    )
```

`TrainingRun` is defined before `ModelVersion`; a string FK is fine. Add to `ModelVersion`, using `relationship` (add it to the `sqlalchemy.orm` import):

```python
    training_run: Mapped["TrainingRun"] = relationship(
        foreign_keys=[training_run_id], lazy="joined"
    )

    @property
    def base_model(self) -> str:
        return self.training_run.base_model

    @property
    def base_model_version_id(self) -> int | None:
        return self.training_run.base_model_version_id
```

`foreign_keys=[training_run_id]` is required: `training_runs` and `model_versions` now reference each other, so SQLAlchemy cannot pick the join path unaided.

Migration:

```python
# backend/alembic/versions/c4d5e6f7a8b9_add_training_run_base_model_version.py
"""add training run base model version

Revision ID: c4d5e6f7a8b9
Revises: a7b8c9d0e1f2
Create Date: 2026-10-08 12:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "c4d5e6f7a8b9"
down_revision: Union[str, Sequence[str], None] = "a7b8c9d0e1f2"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "training_runs",
        sa.Column("base_model_version_id", sa.Integer(), nullable=True),
    )
    op.create_foreign_key(
        "fk_training_runs_base_model_version_id",
        "training_runs",
        "model_versions",
        ["base_model_version_id"],
        ["id"],
    )


def downgrade() -> None:
    op.drop_constraint(
        "fk_training_runs_base_model_version_id", "training_runs", type_="foreignkey"
    )
    op.drop_column("training_runs", "base_model_version_id")
```

`schemas.py`:

```python
from typing import Literal

from pydantic import model_validator

class TrainingRunCreate(BaseModel):
    dataset_id: int
    # Exactly one of base_model / base_model_version_id: a pretrained
    # weights name, or an earlier ModelVersion to fine-tune from.
    base_model: str | None = Field(default=None, min_length=1, max_length=200)
    base_model_version_id: int | None = None
    epochs: int = Field(ge=1, le=1000)
    batch: int = Field(ge=1, le=256)
    imgsz: int = Field(default=640, ge=32, le=4096)
    advanced: dict = Field(default_factory=dict)

    @model_validator(mode="after")
    def _exactly_one_base(self):
        if (self.base_model is None) == (self.base_model_version_id is None):
            raise ValueError("Provide exactly one of base_model and base_model_version_id")
        return self
```

Add `base_model_version_id: int | None` to `TrainingRunRead` (after `base_model`), and `base_model: str` + `base_model_version_id: int | None` to `ModelVersionRead` (after `name`). Add:

```python
class BaseModelOption(BaseModel):
    kind: Literal["pretrained", "model_version"]
    weights: str | None
    label: str
    family: str | None
    size: str | None
    note: str | None
    model_version_id: int | None
```

`service.py`: replace `ADAPTER_NAME = "ultralytics_yolo"` with `from app.training import catalog` and `ADAPTER_NAME = catalog.ADAPTER_NAME`; add exceptions and functions:

```python
class DatasetNotFound(Exception):
    """No such dataset."""


class InvalidBaseModel(Exception):
    """The requested starting point is not usable for this dataset."""


def _headline(task_type: TaskType, metrics: dict) -> str | None:
    if task_type == TaskType.CLASSIFICATION:
        value, label = metrics.get("metrics/accuracy_top1"), "top-1"
    else:
        value, label = metrics.get("metrics/mAP50(B)"), "mAP50"
    return f"{label} {value:.3f}" if isinstance(value, (int, float)) else None


def list_base_models(session: Session, dataset_id: int) -> list[dict]:
    dataset = session.get(Dataset, dataset_id)
    if dataset is None:
        raise DatasetNotFound(f"Dataset {dataset_id} not found")

    options = [
        {
            "kind": "pretrained",
            "weights": model.weights,
            "label": model.weights,
            "family": model.family,
            "size": model.size,
            "note": model.note,
            "model_version_id": None,
        }
        for model in catalog.pretrained_models(ADAPTER_NAME, dataset.task_type)
    ]
    versions = session.scalars(
        select(ModelVersion)
        .join(TrainingRun, ModelVersion.training_run_id == TrainingRun.id)
        .where(
            ModelVersion.task_type == dataset.task_type,
            TrainingRun.adapter == ADAPTER_NAME,
        )
        .order_by(ModelVersion.id.desc())
    )
    for version in versions:
        parts = [
            _headline(version.task_type, version.metrics or {}),
            version.created_at.date().isoformat(),
        ]
        options.append(
            {
                "kind": "model_version",
                "weights": None,
                "label": version.name,
                "family": None,
                "size": None,
                "note": " · ".join(p for p in parts if p),
                "model_version_id": version.id,
            }
        )
    return options
```

(import `TaskType` from `app.datasets.models` alongside `Dataset`). In `create_training_run`, change the signature to `base_model: str | None, base_model_version_id: int | None, config, created_by`, and after the active-run guard (before building `run`) resolve the base:

```python
    parent_id = None
    if base_model_version_id is not None:
        parent = session.get(ModelVersion, base_model_version_id)
        if parent is None:
            raise InvalidBaseModel(f"Model version {base_model_version_id} not found")
        parent_run = session.get(TrainingRun, parent.training_run_id)
        if parent.task_type != dataset.task_type:
            raise InvalidBaseModel(
                f"Model version {parent.id} is a {parent.task_type.value} model; "
                f"this dataset is {dataset.task_type.value}"
            )
        if parent_run is None or parent_run.adapter != ADAPTER_NAME:
            raise InvalidBaseModel(f"Model version {parent.id} was not trained by {ADAPTER_NAME}")
        parent_id = parent.id
        resolved_base = parent.name
    else:
        resolved_base = catalog.resolve_pretrained(ADAPTER_NAME, dataset.task_type, base_model)
        if resolved_base is None:
            raise InvalidBaseModel(
                f"{base_model!r} is not a {dataset.task_type.value} base model for {ADAPTER_NAME}"
            )
```

Order the checks so the cheap validation errors (422) come before `DatasetNotExported`/`RunAlreadyActive` (409)? Keep the existing order for the dataset-not-found/export/active guards and place this block after them — the tests above set up an export and no active run, so either order passes; keeping the guards first preserves every existing test's expectation. Then construct the run with `base_model=resolved_base, base_model_version_id=parent_id`.

`router.py`: update `create_run` to pass `base_model=body.base_model, base_model_version_id=body.base_model_version_id`, add `except service.InvalidBaseModel as exc: raise HTTPException(422, detail=str(exc))`. Add:

```python
@router.get("/base-models", response_model=list[BaseModelOption])
def list_base_models(
    dataset_id: int = Query(),
    session: Session = Depends(get_session),
):
    try:
        return service.list_base_models(session, dataset_id)
    except service.DatasetNotFound as exc:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(exc))
```

(import `BaseModelOption`). Update any existing callers of `service.create_training_run` in `tests/test_training_service.py` to pass `base_model_version_id=None`.

- [ ] **Step 4: Run to verify pass**

Run: `cd backend && uv run pytest tests/test_training_api.py tests/test_training_service.py tests/test_training_models.py tests/test_training_catalog.py -v`
Expected: PASS. Then run the migration against a scratch check: `cd backend && uv run alembic upgrade head` must NOT be run against the real DB without asking — instead verify with `uv run alembic heads` showing `c4d5e6f7a8b9 (head)` and rely on `Base.metadata.create_all` in the tests for the column; the real upgrade happens in Task 6.

- [ ] **Step 5: Commit**

```bash
git add backend/app/training backend/alembic/versions/c4d5e6f7a8b9_add_training_run_base_model_version.py backend/tests
git commit -m "feat: base-model catalog endpoint and fine-tune parent on training runs

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Delete guard, lineage in reads, OpenAPI

**Files:**
- Modify: `backend/app/training/service.py`, `router.py`
- Modify: `backend/tests/test_training_api.py`
- Regenerate: `openapi.json`

**Interfaces:**
- Consumes: `TrainingRun.base_model_version_id`, `ModelVersion.base_model*` properties.
- Produces: `service.ModelVersionInUse(Exception)`; `DELETE /training/models/{id}` → 409 with the child run's id in `detail`.

- [ ] **Step 1: Write the failing tests** (append to `test_training_api.py`)

```python
def test_delete_version_with_a_fine_tuned_child_is_409_and_keeps_weights(monkeypatch):
    email = "train-del1@example.com"
    headers = _register_and_login(email)
    session = _session()
    user_id = _user_id(session, email)
    dataset = _make_dataset(session, user_id)
    _succeeded_export(session, dataset.id, user_id)
    parent = _make_version(session, dataset, user_id, "parent")
    _stub_send_task(monkeypatch)
    deleted: list[str] = []

    class _Storage:
        def delete(self, key):
            deleted.append(key)

    app.dependency_overrides[get_storage_service] = lambda: _Storage()
    try:
        child = _create(headers, dataset.id, base_model_version_id=parent.id).json()

        response = client.delete(f"/training/models/{parent.id}", headers=headers)

        assert response.status_code == 409
        assert str(child["id"]) in response.json()["detail"]
        assert deleted == []
        assert session.get(ModelVersion, parent.id) is not None
    finally:
        app.dependency_overrides.pop(get_storage_service, None)
        _cleanup(session, dataset.id)
        session.close()


def test_model_list_exposes_lineage(monkeypatch):
    email = "train-del2@example.com"
    headers = _register_and_login(email)
    session = _session()
    user_id = _user_id(session, email)
    dataset = _make_dataset(session, user_id)
    parent = _make_version(session, dataset, user_id, "root-model")
    try:
        response = client.get("/training/models", headers=headers)

        row = next(v for v in response.json() if v["id"] == parent.id)
        assert row["base_model"] == "yolo11n.pt"
        assert row["base_model_version_id"] is None
    finally:
        _cleanup(session, dataset.id)
        session.close()
```

(`ModelVersion` rows for fine-tuned children are created by the worker, so the lineage-with-parent case is covered at the ml-worker level in Task 4.)

- [ ] **Step 2: Run to verify failure**

Run: `cd backend && uv run pytest tests/test_training_api.py -v -k "delete_version_with or lineage"`
Expected: FAIL (delete returns 204 / missing fields).

- [ ] **Step 3: Implement**

`service.py`:

```python
class ModelVersionInUse(Exception):
    """A training run was fine-tuned from this version."""
```

At the top of `delete_model_version`, after `get_model_version`:

```python
    child = session.scalars(
        select(TrainingRun).where(TrainingRun.base_model_version_id == version_id)
    ).first()
    if child is not None:
        raise ModelVersionInUse(
            f"Model version {version_id} is the starting point of training run {child.id}; "
            "delete that run's results first"
        )
```

`router.py` `delete_model`: add `except service.ModelVersionInUse as exc: raise HTTPException(409, detail=str(exc))`.

Note: "delete that run's results first" is only actionable once the child produced a version; a failed child run (no version) would block forever. If that is hit in practice, relax the guard to ignore runs whose status is FAILED; for now the guard covers every referencing run because a failed run has no weights that depend on the parent.

- [ ] **Step 4: Run to verify pass, then regenerate OpenAPI**

Run: `cd backend && uv run pytest tests/test_training_api.py tests/test_training_service.py tests/test_training_models.py tests/test_training_catalog.py -v`
Expected: PASS.

Run: `cd backend && PYTHONPATH=. uv run python scripts/export_openapi.py && cd .. && git diff --stat openapi.json`
Expected: `openapi.json` changed (new route, new fields).

- [ ] **Step 5: Commit**

```bash
git add backend openapi.json
git commit -m "feat: refuse to delete a model version that a run was fine-tuned from

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 4: ml-worker — parent weights, path-safe adapter, naming

**Files:**
- Modify: `ml-worker/app/models.py`, `ml-worker/app/tasks.py`, `ml-worker/app/ultralytics_yolo_adapter.py`
- Test: `ml-worker/tests/test_tasks_training.py`, `ml-worker/tests/test_ultralytics_yolo_adapter.py`

**Interfaces:**
- Consumes: DB column `training_runs.base_model_version_id` (Task 2).
- Produces: `TrainingRun.base_model_version_id` on ml-worker's own model; `weights_for_task` leaves paths with a directory part untouched; `model_train` passes `request.base_model = <local path>` for fine-tune runs; fine-tuned `ModelVersion.name == f"{parent.name}-ft-run{run.id}"`.

Run all ml-worker tests with the `docker cp` workflow (memory: ml-worker test workflow); the real DB schema must already have the column — apply the Task 2 migration to the dev DB first (`cd backend && uv run alembic upgrade head`, after asking, since it touches the real `endoscopy` DB) or point the worker tests at the test DB as their conftest already does.

- [ ] **Step 1: Write the failing tests**

`ml-worker/tests/test_ultralytics_yolo_adapter.py` — find the existing `weights_for_task` tests (grep `weights_for_task`) and add alongside:

```python
def test_weights_for_task_leaves_a_local_path_untouched():
    from app.ultralytics_yolo_adapter import weights_for_task

    assert weights_for_task("/tmp/xyz/parent.pt", "segmentation") == "/tmp/xyz/parent.pt"
    assert weights_for_task("/tmp/xyz/parent.pt", "classification") == "/tmp/xyz/parent.pt"
```

`ml-worker/tests/test_tasks_training.py` — add:

```python
import pytest


@pytest.fixture
def parent_version(db_session, make_job_and_run):
    """A finished ModelVersion plus a pending child run pointing at it."""
    from app.models import ModelVersion, TaskType

    parent_job, parent_run = make_job_and_run()
    parent = ModelVersion(
        training_run_id=parent_run.id,
        name="parent-model",
        task_type=TaskType.DETECTION,
        storage_key=f"models/{parent_run.id}/best.pt",
    )
    db_session.add(parent)
    db_session.commit()
    db_session.refresh(parent)

    job, run = make_job_and_run()
    run.base_model = parent.name
    run.base_model_version_id = parent.id
    db_session.commit()
    return parent, job, run


def _download_by_key(fake_storage, blobs):
    original = fake_storage.download

    def download(key):
        if key in blobs:
            return blobs[key]
        return original(key)

    fake_storage.download = download


def test_fine_tune_downloads_the_parent_weights_and_passes_a_local_path(
    db_session, parent_version, fake_storage
):
    from app.tasks import model_train

    parent, job, run = parent_version
    _download_by_key(fake_storage, {parent.storage_key: b"parent-weights"})
    seen = {}

    class _Spy:
        def train(self, request, on_log, on_epoch, should_stop):
            seen["base_model"] = request.base_model
            seen["bytes"] = Path(request.base_model).read_bytes()
            weights = request.output_dir / "best.pt"
            weights.write_bytes(b"w")
            return TrainingResult(weights_path=weights)

    model_train(job.id, adapter=_Spy())
    db_session.refresh(run)

    assert run.status == TrainingRunStatus.SUCCEEDED
    assert Path(seen["base_model"]).name == "parent.pt"
    assert seen["bytes"] == b"parent-weights"
    version = db_session.query(ModelVersion).filter_by(training_run_id=run.id).one()
    assert version.name == f"parent-model-ft-run{run.id}"


def test_a_pretrained_start_keeps_the_weights_name_and_old_version_name(
    db_session, make_job_and_run, fake_storage
):
    from app.tasks import model_train

    job, run = make_job_and_run()
    seen = {}

    class _Spy:
        def train(self, request, on_log, on_epoch, should_stop):
            seen["base_model"] = request.base_model
            weights = request.output_dir / "best.pt"
            weights.write_bytes(b"w")
            return TrainingResult(weights_path=weights)

    model_train(job.id, adapter=_Spy())

    assert seen["base_model"] == "yolo11n.pt"
    version = db_session.query(ModelVersion).filter_by(training_run_id=run.id).one()
    assert version.name == f"yolo11n-run{run.id}"


def test_a_missing_parent_weights_object_fails_the_run_readably(
    db_session, parent_version, fake_storage
):
    from app.tasks import model_train

    parent, job, run = parent_version

    def missing(key):
        if key == parent.storage_key:
            raise FileNotFoundError(key)
        return b""

    fake_storage.download = missing

    class _NeverCalled:
        def train(self, *a, **k):
            raise AssertionError("must not start training without the parent weights")

    model_train(job.id, adapter=_NeverCalled())
    db_session.refresh(run)

    assert run.status == TrainingRunStatus.FAILED
    assert "parent-model" in run.error
    assert "weights" in run.error.lower()
```

- [ ] **Step 2: Run to verify failure**

Run (docker cp workflow): `docker cp ml-worker/app/. endoscopy-platform-ml-worker-1:/app/app/ && docker cp ml-worker/tests/. endoscopy-platform-ml-worker-1:/app/tests/ && docker compose exec ml-worker /app/.venv/bin/python -m pytest tests/test_tasks_training.py tests/test_ultralytics_yolo_adapter.py -v`
(container name: check `docker compose ps ml-worker`.)
Expected: FAIL (`AttributeError: base_model_version_id`, path suffix, etc.).

- [ ] **Step 3: Implement**

`ml-worker/app/models.py` — in `TrainingRun`, after `base_model`:

```python
    # Plain int, not a ForeignKey("model_versions.id"): the real constraint
    # lives in the backend's migration; declaring it here would add a
    # self-referential mapper dependency ml-worker has no need for.
    base_model_version_id: Mapped[int | None] = mapped_column(Integer, nullable=True)
```

`ml-worker/app/ultralytics_yolo_adapter.py` — at the top of `weights_for_task`, after the docstring:

```python
    if "/" in base_model or "\\" in base_model:
        # A local file (a fine-tune parent downloaded by the worker) names
        # exactly the weights to load; appending a task suffix would point
        # at a file that does not exist.
        return base_model
```

Update the docstring: "A local path is returned untouched."

`ml-worker/app/tasks.py` `model_train` — inside the `with tempfile.TemporaryDirectory()` block, before `adapter.train`, after extracting the archive:

```python
            base_model = run.base_model
            if run.base_model_version_id is not None:
                parent = session.get(ModelVersion, run.base_model_version_id)
                if parent is None:
                    raise RuntimeError(
                        f"Parent model version {run.base_model_version_id} no longer exists"
                    )
                try:
                    parent_bytes = storage.download(parent.storage_key)
                except Exception as exc:  # noqa: BLE001 -- re-raised with context
                    raise RuntimeError(
                        f"Could not fetch the weights of parent model {parent.name!r} "
                        f"({parent.storage_key}): {exc}"
                    ) from exc
                parent_path = work / "parent.pt"
                parent_path.write_bytes(parent_bytes)
                base_model = str(parent_path)
```

Use `base_model=base_model` in the `TrainingRequest`. For the version name (after the `with` block), compute it using `run.base_model` — which for a fine-tune is already the parent's name:

```python
        if run.base_model_version_id is not None:
            version_name = f"{run.base_model}-ft-run{run.id}"
        else:
            version_name = f"{run.base_model.rsplit('.', 1)[0]}-run{run.id}"
```

and pass `name=version_name`. The existing failure path already stores `str(exc)` on the run and job, which satisfies the readable-error test; `"weights"` and the parent name appear in the message above.

- [ ] **Step 4: Run to verify pass**

Re-run the Step 2 command, then the full ml-worker training suite: `... pytest tests/test_tasks_training.py tests/test_training_adapter.py tests/test_ultralytics_yolo_adapter.py -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add ml-worker
git commit -m "feat: fine-tune from a stored model version in the ml-worker

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Frontend — catalog-driven form, page wiring, lineage column

**Files:**
- Modify: `frontend/src/features/training/TrainConfigForm.tsx`, `TrainPage.tsx`, `ModelVersionsTable.tsx`
- Test: `TrainConfigForm.test.tsx`, `TrainPage.test.tsx`, `ModelVersionsTable.test.tsx`

**Interfaces:**
- Consumes: generated type `components["schemas"]["BaseModelOption"]`; `GET /training/base-models`; `ModelVersionRead.base_model` / `base_model_version_id`; `POST /training/runs` accepting exactly one of `base_model` / `base_model_version_id`.
- Produces:
  - `TrainConfigValues = { datasetId: number; baseModel: string | null; baseModelVersionId: number | null; epochs: number; batch: number; imgsz: number }`
  - `TrainConfigForm` props: `datasets`, `disabled`, `onSubmit`, plus new `baseModels?: BaseModelOption[]` (default `[]`), `baseModelsError?: string | null`, `onDatasetChange?: (datasetId: number) => void`

Run `cd frontend && npm run generate-api` first so the new types exist (the `pretest` hook does it for `npm test`).

- [ ] **Step 1: Write the failing tests**

`TrainConfigForm.test.tsx` — add a shared fixture and tests; update the two existing tests noted below.

```tsx
import type { components } from "../../shared/api/generated/schema";

type BaseModelOption = components["schemas"]["BaseModelOption"];

const pretrained = (size: string, note: string | null = null): BaseModelOption => ({
  kind: "pretrained",
  weights: `yolo11${size}.pt`,
  label: `yolo11${size}.pt`,
  family: "yolo11",
  size,
  note,
  model_version_id: null,
});

const baseModels: BaseModelOption[] = [
  pretrained("n"),
  pretrained("s"),
  pretrained("l", "may not fit in 8 GB"),
  {
    kind: "model_version",
    weights: null,
    label: "polyps-v1-run7",
    family: null,
    size: null,
    note: "mAP50 0.650 · 2026-08-20",
    model_version_id: 7,
  },
];
```

Update the existing "submits the entered configuration" test to render with `baseModels={baseModels}` and assert:

```tsx
    expect(onSubmit).toHaveBeenCalledWith({
      datasetId: 1,
      baseModel: "yolo11n.pt",
      baseModelVersionId: null,
      epochs: 25,
      batch: 16,
      imgsz: 640,
    });
```

New tests:

```tsx
  it("announces the selected dataset so the page can load its base models", async () => {
    const onDatasetChange = vi.fn();
    render(
      <TrainConfigForm
        datasets={datasets}
        disabled={false}
        onSubmit={vi.fn()}
        onDatasetChange={onDatasetChange}
      />,
    );

    await waitFor(() => expect(onDatasetChange).toHaveBeenCalledWith(1));
  });

  it("groups pretrained weights and own models, with the VRAM note on large sizes", () => {
    render(
      <TrainConfigForm
        datasets={datasets}
        disabled={false}
        onSubmit={vi.fn()}
        baseModels={baseModels}
      />,
    );

    expect(screen.getByRole("group", { name: /pretrained/i })).toBeInTheDocument();
    expect(screen.getByRole("group", { name: /your models/i })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: /yolo11l\.pt.*may not fit in 8 GB/ })).toBeEnabled();
    expect(screen.getByRole("option", { name: /yolo11n\.pt$/ })).toBeInTheDocument();
  });

  it("omits the own-models group when there are no versions", () => {
    render(
      <TrainConfigForm
        datasets={datasets}
        disabled={false}
        onSubmit={vi.fn()}
        baseModels={baseModels.slice(0, 3)}
      />,
    );

    expect(screen.queryByRole("group", { name: /your models/i })).not.toBeInTheDocument();
  });

  it("submits the version id, not a weights name, when a version is chosen", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    render(
      <TrainConfigForm
        datasets={datasets}
        disabled={false}
        onSubmit={onSubmit}
        baseModels={baseModels}
      />,
    );

    await user.selectOptions(screen.getByLabelText(/base model/i), "version:7");
    await user.click(screen.getByRole("button", { name: /start training/i }));

    expect(onSubmit).toHaveBeenCalledWith(
      expect.objectContaining({ baseModel: null, baseModelVersionId: 7 }),
    );
  });

  it("explains head re-initialisation only when a version is chosen", async () => {
    const user = userEvent.setup();
    render(
      <TrainConfigForm
        datasets={datasets}
        disabled={false}
        onSubmit={vi.fn()}
        baseModels={baseModels}
      />,
    );

    expect(screen.queryByText(/re-initialised/i)).not.toBeInTheDocument();
    await user.selectOptions(screen.getByLabelText(/base model/i), "version:7");
    expect(screen.getByText(/re-initialised/i)).toBeInTheDocument();
  });

  it("falls back to the first pretrained model when the list changes under the selection", async () => {
    const user = userEvent.setup();
    const { rerender } = render(
      <TrainConfigForm
        datasets={datasets}
        disabled={false}
        onSubmit={vi.fn()}
        baseModels={baseModels}
      />,
    );
    await user.selectOptions(screen.getByLabelText(/base model/i), "version:7");

    // A different dataset (another task type) no longer offers version 7.
    rerender(
      <TrainConfigForm
        datasets={datasets}
        disabled={false}
        onSubmit={vi.fn()}
        baseModels={[pretrained("n"), pretrained("s")]}
      />,
    );

    expect(screen.getByLabelText(/base model/i)).toHaveValue("pretrained:yolo11n.pt");
  });

  it("shows an error instead of an empty list when the catalog failed to load", () => {
    render(
      <TrainConfigForm
        datasets={datasets}
        disabled={false}
        onSubmit={vi.fn()}
        baseModelsError="Could not load base models."
      />,
    );

    expect(screen.getByText("Could not load base models.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /start training/i })).toBeDisabled();
  });
```

(add `waitFor` to the `@testing-library/react` import.) Other existing tests that render the form without `baseModels` keep passing; `disabled` start button logic below covers the empty-list case.

`ModelVersionsTable.test.tsx` — update both fixtures with the new required fields (`base_model: "yolo11n.pt"`, `base_model_version_id: null`), and add:

```tsx
  it("shows the pretrained weights for a fresh start and the parent for a fine-tune", () => {
    const rows: ModelVersionRead[] = [
      { ...versions[0], base_model: "yolo11n.pt", base_model_version_id: null },
      {
        ...versions[0],
        id: 9,
        name: "yolo11n-run7-ft-run9",
        base_model: "yolo11n-run7",
        base_model_version_id: 4,
      },
    ];
    render(
      <ModelVersionsTable versions={rows} onDownload={vi.fn()} onDelete={vi.fn()} onInfo={vi.fn()} />,
    );

    expect(screen.getByText("yolo11n.pt")).toBeInTheDocument();
    expect(screen.getByText("↳ yolo11n-run7")).toBeInTheDocument();
  });
```

(Also update any `ModelVersionRead` literals in `TrainPage.test.tsx`/`ModelInfoPanel.test.tsx` that now fail type-checking.)

`TrainPage.test.tsx` — following that file's existing `apiClient` mock pattern, add: (a) when the form announces dataset 1, `GET /training/base-models` is called with `query: { dataset_id: 1 }` and the returned options render in the Base model select; (b) submitting a pretrained choice POSTs `base_model: "yolo11n.pt"` with no `base_model_version_id`; (c) submitting a version choice POSTs `base_model_version_id: 7` with no `base_model`; (d) a 409 from `DELETE /training/models/{id}` shows its `detail` in the `role="alert"` banner. Copy the existing mocking style exactly; do not invent a new one.

- [ ] **Step 2: Run to verify failure**

Run: `cd frontend && npx vitest run src/features/training`
Expected: FAIL (props/optgroups/column missing; type errors).

- [ ] **Step 3: Implement**

`TrainConfigForm.tsx`:
- Delete `BASE_MODELS`. Add `type BaseModelOption = components["schemas"]["BaseModelOption"]` and the new optional props.
- Selection state is a string key: `pretrained:<weights>` or `version:<id>`:

```tsx
const keyOf = (option: BaseModelOption) =>
  option.kind === "model_version"
    ? `version:${option.model_version_id}`
    : `pretrained:${option.weights}`;
```

- `const [baseKey, setBaseKey] = useState("")`. Effect: when `baseModels` changes and `baseKey` is not among `baseModels.map(keyOf)`, set it to the key of the first `kind === "pretrained"` option (or `""` if none).
- Effect: `useEffect(() => { if (datasetId !== "") onDatasetChange?.(datasetId); }, [datasetId])` (annotate with the same eslint-disable comment the file's neighbours use if `onDatasetChange` identity trips the rule — it must not re-fire on every render; `TrainPage` passes a `useCallback`).
- Render one `<select id="train-base-model">` (label unchanged: "Base model") with `<optgroup label="Pretrained (YOLO11)">` and, only if any version exists, `<optgroup label="Your models (fine-tune)">`. Option text: pretrained → `weights` plus ` — ${note}` when `note`; version → `${label} — ${note}`. Option `value` = `keyOf(option)`. The select is `disabled` while `baseModels` is empty.
- Under the select, when `baseKey` starts with `version:`:

```tsx
<p className="text-xs text-gray-500">
  Matching layers are kept. If this dataset's classes differ from the parent's, the
  detection head is re-initialised — see the log.
</p>
```

- When `baseModelsError` is set render it in `text-red-300` under the select.
- Submit: start button `disabled={disabled || datasetId === "" || baseKey === ""}` (the existing "disables the start button while a run is active" test still holds; the existing "submits" test now passes `baseModels`). `handleSubmit` resolves `baseKey` into `{ baseModel, baseModelVersionId }`:

```tsx
const isVersion = baseKey.startsWith("version:");
onSubmit({
  datasetId,
  baseModel: isVersion ? null : baseKey.slice("pretrained:".length),
  baseModelVersionId: isVersion ? Number(baseKey.slice("version:".length)) : null,
  epochs, batch, imgsz,
});
```

Check the existing "disables the start button" and other tests still hold; where an existing test submits with no `baseModels`, add the prop (done above).

`TrainPage.tsx`:
- State `baseModels: BaseModelOption[]` and `baseModelsError: string | null`.
- `const loadBaseModels = useCallback(async (datasetId: number) => { setBaseModels([]); setBaseModelsError(null); const { data, error } = await apiClient.GET("/training/base-models", { params: { query: { dataset_id: datasetId } } }); if (error || !data) { setBaseModelsError("Could not load base models."); return; } setBaseModels(data); }, []);`
- Pass `baseModels`, `baseModelsError`, `onDatasetChange={loadBaseModels}` to the form.
- `handleSubmit` body: `...(values.baseModelVersionId !== null ? { base_model_version_id: values.baseModelVersionId } : { base_model: values.baseModel }),` replacing `base_model: values.baseModel`.
- `handleDelete`: capture `error` from `apiClient.DELETE`; if present, `setSubmitError((error as { detail?: string }).detail ?? "Failed to delete the model.")` and return before `refreshVersions()`.

`ModelVersionsTable.tsx`: add `<th>Base</th>` after Type and a cell:

```tsx
<td className="px-4 py-2 text-gray-400">
  {version.base_model_version_id !== null
    ? `↳ ${version.base_model}`
    : version.base_model}
</td>
```

- [ ] **Step 4: Run to verify pass**

Run: `cd frontend && npx vitest run src/features/training && npx tsc --noEmit -p .` (if the repo's build is red for unrelated reasons — see the "pre-existing red tests" memory — compare against `git stash` baseline rather than chasing old failures).
Expected: all training tests PASS, no new type errors.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/features/training
git commit -m "feat: catalog-driven Base model field with fine-tune from a trained version

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Live verification, cleanup, ROADMAP

**Files:**
- Modify: `ROADMAP.md`

No new code unless the live run finds a defect (then stop, use superpowers:systematic-debugging, fix test-first, log it as a deviation).

- [ ] **Step 1: Deploy.** Ask before anything that touches running services. Apply the migration to the dev DB (`cd backend && uv run alembic upgrade head`; `alembic heads` must show `c4d5e6f7a8b9`). Rebuild and recreate `ml-worker` from the image (`docker compose build ml-worker && docker compose up -d ml-worker`) — `docker cp` is not a deploy. Confirm the container has the new code: `docker compose exec ml-worker grep -n base_model_version_id /app/app/models.py`. Do not touch :5173/:5174 or the CORS allowlist without asking; if the backend/frontend dev servers must be restarted, ask first.

- [ ] **Step 2: Back up before creating rows.** Record current row counts and ids for `training_runs`, `model_versions`, `jobs` (type `MODEL_TRAIN`) and the `models/` MinIO prefix into the scratchpad directory, so cleanup deletes by precise predicate.

- [ ] **Step 3: Drive the form in a real browser** as `manualcheck@example.com` (use the Playwright/Chrome DevTools MCP tools). For a detection, a segmentation and a classification dataset (use existing exported datasets; export a small one if needed): the Base model select lists exactly the five `yolo11*` names with the task suffix, `l` and `x` show "may not fit in 8 GB", the selection resets on switching datasets, and any existing detection `ModelVersion` appears under "Your models" only for the detection dataset.

- [ ] **Step 4: Real short runs, size `n` only** (`epochs` 2–3, `batch` 4, `imgsz` 320 or the dataset default — never `l`/`x`, the host has hard-rebooted under GPU pressure). One segmentation run and one classification run on small datasets. Verify each reaches SUCCEEDED, creates a `ModelVersion`, shows headline score and confusion matrix in the Info panel, and the table's Base column reads the weights name.

- [ ] **Step 5: Fine-tune.** Start a detection run from an existing detection `ModelVersion` (or one produced above). Verify the log shows the weights loaded, the run SUCCEEDS, the new version is named `<parent>-ft-run<id>`, and its Base column reads `↳ <parent>`. Then try deleting the parent: the banner shows the 409 text and the weights object is still in MinIO.

- [ ] **Step 6: Clean up the real DB and MinIO, unprompted.** Using the Step 2 backup, delete precisely the rows created this session: child `training_runs` first (they reference `model_versions`), then `model_versions`, `training_runs`, their `jobs`, then the `models/<run id>/` MinIO prefixes. Sweep every table named in CLAUDE.md, not only the obvious ones. Re-count and compare to the backup. If a user-owned version was created on purpose and the user wants to keep it, ask.

- [ ] **Step 7: Update ROADMAP.md.** Add a "Phase 2b: Training base models and fine-tuning — DONE (date)" entry linking the spec and this plan, with the commit range, what Step 3–5 actually verified (including segmentation and classification training, previously never completed to a kept version), every deviation found (known so far: `BaseModelOption.family`/`size` are nullable for versions; the version `note` carries headline metric and date), and the unverified items: `l`/`x` never run live, class-mismatch head re-initialisation not exercised unless a mismatched fine-tune was actually run, pretrained weights still downloaded from GitHub on every run, a worker that dies mid-run still leaves the run RUNNING.

- [ ] **Step 8: Commit**

```bash
git add ROADMAP.md
git commit -m "docs: record Training base models and fine-tuning

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

## Self-Review

- **Spec coverage:** catalog and sizes (Task 1); `GET /base-models`, create rules incl. legacy normalisation, task/adapter mismatch, FK, lineage fields (Tasks 2–3); delete 409 (Task 3); migration (Task 2); ml-worker column mirror, parent download, local-path-safe `weights_for_task`, `-ft-run` naming, readable failure (Task 4); form groups, notes, reset, static hint, one-of submit, Base column, 409 message (Task 5); live verification of detection/segmentation/classification and fine-tune, cleanup, ROADMAP (Task 6). The spec's "version note: metric and date" is implemented as headline metric (top-1 / mAP50, omitted if absent) plus ISO date; `family`/`size` are nullable for version entries (the spec listed them without nullability).
- **Placeholder scan:** the only deliberately open items are the `TrainPage.test.tsx` additions, which are specified as four named behaviours to be written in that file's existing mocking style because that file's mock scaffolding was not reproduced here; the implementer must read it first.
- **Type consistency:** `BaseModelOption` fields, `keyOf` format (`pretrained:<weights>` / `version:<id>`), `TrainConfigValues` and the POST body (`base_model` XOR `base_model_version_id`) agree across Tasks 2, 5 and the spec; `service.create_training_run` signature matches the router call; `ModelVersion.base_model`/`base_model_version_id` properties match `ModelVersionRead`.
