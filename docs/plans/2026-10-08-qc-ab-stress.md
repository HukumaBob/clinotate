# QC A/B Comparison and Stress Tests Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Compare two finished inference runs of one video frame by frame, fix the wrong frames through the existing FP/FN flags, and let a run be made on degraded frames (stress test).

**Architecture:** `InferenceRun` gets a nullable `perturbation` JSON that rides in the job payload; `ml-worker` degrades each frame (pure function) before the model. A new `GET /inference/compare` downloads both predictions documents and returns the frames where the sets of class names differ. A new frontend page shows both overlays side by side and creates flags on the wrong run through the existing flag endpoints.

**Tech Stack:** FastAPI, SQLAlchemy, Alembic, Celery (`ml-worker`, numpy/OpenCV), React/Vite, TanStack Query, `openapi-typescript`.

**Spec:** [docs/specs/2026-10-08-qc-ab-stress-design.md](../specs/2026-10-08-qc-ab-stress-design.md)

## Global Constraints

- English only in code, comments, UI copy. Dark theme only: no light-background classes.
- Work directly on `master`; no branches or worktrees. End every commit message with `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`.
- Frontend calls go through `apiClient`; after any backend schema or route change run `cd backend && PYTHONPATH=. uv run python scripts/export_openapi.py` and check `git diff --stat openapi.json`.
- Backend tests use `import app.db as db_module` + `db_module.SessionLocal()`, never `from app.db import SessionLocal`. Tests must leave no rows in the real `endoscopy` database.
- Do not touch dev ports or servers (`:5173`/`:5174`), and never touch run #82.
- ml-worker tests do not run on the host (no torch/numpy in the host venv): `docker cp` the files and run with `docker compose exec` (see memory `ml_worker_test_workflow`).
- Compare classes by **name** (`classes[class_id]`), never by id: two models can number classes differently.
- Perturbation kinds and strength ranges (one source of truth, duplicated in backend and ml-worker, each side tested):
  `gaussian_noise` sigma 1-100; `blur` gaussian sigma 0.5-20; `brightness` additive delta -100..100 except 0; `jpeg` quality 5-95.

## Review Focus

- Same run passed as A and B: 409, not an empty result.
- Runs of different videos, different `frame_stride`, or either not `succeeded`: 409 with a plain reason.
- A run whose model was deleted (`model_version_id` NULL) still compares: the predictions JSON is self-contained.
- Confidence outside 0..1 or NaN: 422.
- Strength 0, negative, NaN or out of range for a kind: 422 on `POST /runs`.
- A frame in A's document absent from B's: skipped, not a crash; a document with zero frames: empty result.
- Models with differently ordered class lists: same names agree.
- A frame where both sides have exclusive classes: "A wrong" gives FP (A found something B did not), not FN.
- Deleting a run while its A/B page is open: the page shows an error, no blank crash.

---

### Task 1: Perturbation on the run (backend)

**Files:**
- Create: `backend/alembic/versions/a7b8c9d0e1f2_add_inference_run_perturbation.py`
- Modify: `backend/app/inference/models.py` (InferenceRun), `backend/app/inference/schemas.py`, `backend/app/inference/service.py:61-133`, `backend/app/inference/router.py:26-47`
- Test: `backend/tests/test_inference_perturbation.py`

**Interfaces:**
- Produces: `PerturbationSpec(kind: Literal["gaussian_noise","blur","brightness","jpeg"], strength: float)` in `app.inference.schemas`; `InferenceRunCreate.perturbation: PerturbationSpec | None`; `InferenceRunRead.perturbation: dict | None`; job payload key `"perturbation": dict | None`; `create_inference_run(..., perturbation: dict | None = None)`.

- [ ] **Step 1: Write the failing tests**

```python
# backend/tests/test_inference_perturbation.py
import pytest
from pydantic import ValidationError

import app.main  # noqa: F401
from app.inference.schemas import PerturbationSpec


@pytest.mark.parametrize(
    "kind,strength",
    [("gaussian_noise", 10), ("blur", 2.5), ("brightness", -40), ("jpeg", 30)],
)
def test_valid_specs_are_accepted(kind, strength):
    assert PerturbationSpec(kind=kind, strength=strength).strength == strength


@pytest.mark.parametrize(
    "kind,strength",
    [
        ("gaussian_noise", 0), ("gaussian_noise", 101), ("blur", 0.1), ("blur", 21),
        ("brightness", 0), ("brightness", 101), ("jpeg", 4), ("jpeg", 96),
        ("jpeg", float("nan")), ("blur", float("inf")),
    ],
)
def test_out_of_range_strength_is_rejected(kind, strength):
    with pytest.raises(ValidationError):
        PerturbationSpec(kind=kind, strength=strength)


def test_unknown_kind_is_rejected():
    with pytest.raises(ValidationError):
        PerturbationSpec(kind="rotate", strength=5)
```

Also append to `backend/tests/test_inference_api.py`, reusing its `_create`, `_no_celery` and `committed_inference_rows` helpers (read the file first and match their exact signatures):

```python
def test_create_run_stores_perturbation_and_puts_it_in_the_job_payload(committed_inference_rows, _no_celery):
    headers = _register_and_login("perturb1@example.com")
    response = _create(
        headers, committed_inference_rows,
        perturbation={"kind": "blur", "strength": 3},
    )
    assert response.status_code == 202
    assert response.json()["perturbation"] == {"kind": "blur", "strength": 3.0}
    # Follow the file's existing pattern for reading the Job payload; assert
    # payload["perturbation"] == {"kind": "blur", "strength": 3.0}.


def test_create_run_without_perturbation_reads_back_null(committed_inference_rows, _no_celery):
    headers = _register_and_login("perturb2@example.com")
    response = _create(headers, committed_inference_rows)
    assert response.json()["perturbation"] is None


def test_create_run_rejects_a_bad_perturbation(committed_inference_rows):
    headers = _register_and_login("perturb3@example.com")
    response = _create(
        headers, committed_inference_rows,
        perturbation={"kind": "blur", "strength": 99},
    )
    assert response.status_code == 422
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd backend && uv run pytest tests/test_inference_perturbation.py tests/test_inference_api.py -q`
Expected: FAIL (`PerturbationSpec` missing; `perturbation` not in response).

- [ ] **Step 3: Implement**

`schemas.py`:

```python
import math
from typing import Literal

from pydantic import model_validator

PERTURBATION_RANGES = {
    "gaussian_noise": (1.0, 100.0),
    "blur": (0.5, 20.0),
    "brightness": (-100.0, 100.0),
    "jpeg": (5.0, 95.0),
}


class PerturbationSpec(BaseModel):
    kind: Literal["gaussian_noise", "blur", "brightness", "jpeg"]
    strength: float

    @model_validator(mode="after")
    def _strength_in_range(self):
        low, high = PERTURBATION_RANGES[self.kind]
        if not math.isfinite(self.strength) or not (low <= self.strength <= high):
            raise ValueError(f"{self.kind} strength must be between {low} and {high}")
        if self.kind == "brightness" and self.strength == 0:
            raise ValueError("brightness strength must not be 0")
        return self
```

In `InferenceRunCreate` add `perturbation: PerturbationSpec | None = None`; in `InferenceRunRead` add `perturbation: dict | None = None`.

`models.py` InferenceRun: `perturbation: Mapped[dict | None] = mapped_column(JSON, nullable=True)` (import `JSON` if missing).

Migration:

```python
"""add inference run perturbation

Revision ID: a7b8c9d0e1f2
Revises: e5f6a7b8c9d0
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "a7b8c9d0e1f2"
down_revision: Union[str, Sequence[str], None] = "e5f6a7b8c9d0"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column("inference_runs", sa.Column("perturbation", sa.JSON(), nullable=True))


def downgrade() -> None:
    op.drop_column("inference_runs", "perturbation")
```

`service.create_inference_run`: add keyword `perturbation: dict | None = None`; pass it to `InferenceRun(..., perturbation=perturbation)` and add `"perturbation": perturbation` to the job payload. `router.create_run`: pass `perturbation=body.perturbation.model_dump() if body.perturbation else None`.

- [ ] **Step 4: Migrate and run tests**

Run: `cd backend && uv run alembic upgrade head && uv run pytest tests/test_inference_perturbation.py tests/test_inference_api.py -q`
Expected: PASS.

- [ ] **Step 5: Regenerate OpenAPI and commit**

```bash
cd backend && PYTHONPATH=. uv run python scripts/export_openapi.py && cd .. && git diff --stat openapi.json
git add backend openapi.json
git commit -m "feat: optional perturbation on inference runs" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Degrade frames in ml-worker

**Files:**
- Create: `ml-worker/app/perturbation.py`
- Modify: `ml-worker/app/inference_adapter.py` (InferenceRequest), `ml-worker/app/ultralytics_inference_adapter.py:~89-96`, `ml-worker/app/tasks.py:~1023-1045`
- Test: `ml-worker/tests/test_perturbation.py`, additions to `ml-worker/tests/test_ultralytics_inference_adapter.py` and `ml-worker/tests/test_tasks_inference.py`

**Interfaces:**
- Produces: `apply_perturbation(image: np.ndarray, spec: dict | None, seed: int = 0) -> np.ndarray` (BGR uint8 in, same shape and dtype out; returns the input unchanged for `None`; raises `ValueError` on unknown kind); `InferenceRequest.perturbation: dict | None = None`; predictions header key `"perturbation"`.
- Consumes: job payload key `"perturbation"` from Task 1.

- [ ] **Step 1: Write the failing tests**

```python
# ml-worker/tests/test_perturbation.py
import numpy as np
import pytest

from app.perturbation import apply_perturbation


def _image():
    rng = np.random.default_rng(0)
    return rng.integers(0, 256, (48, 64, 3), dtype=np.uint8)


def test_none_returns_the_same_image():
    image = _image()
    assert apply_perturbation(image, None) is image


@pytest.mark.parametrize(
    "spec",
    [
        {"kind": "gaussian_noise", "strength": 20},
        {"kind": "blur", "strength": 3},
        {"kind": "brightness", "strength": 40},
        {"kind": "jpeg", "strength": 10},
    ],
)
def test_every_kind_keeps_shape_and_dtype_and_changes_pixels(spec):
    image = _image()
    out = apply_perturbation(image, spec, seed=1)
    assert out.shape == image.shape and out.dtype == np.uint8
    assert not np.array_equal(out, image)


def test_input_is_not_modified():
    image = _image()
    before = image.copy()
    apply_perturbation(image, {"kind": "gaussian_noise", "strength": 30}, seed=2)
    assert np.array_equal(image, before)


def test_noise_is_reproducible_per_seed_and_differs_between_seeds():
    spec = {"kind": "gaussian_noise", "strength": 25}
    a = apply_perturbation(_image(), spec, seed=5)
    assert np.array_equal(a, apply_perturbation(_image(), spec, seed=5))
    assert not np.array_equal(a, apply_perturbation(_image(), spec, seed=6))


def test_brightness_clips_instead_of_wrapping():
    white = np.full((4, 4, 3), 250, dtype=np.uint8)
    assert apply_perturbation(white, {"kind": "brightness", "strength": 50}).max() == 255
    black = np.full((4, 4, 3), 5, dtype=np.uint8)
    assert apply_perturbation(black, {"kind": "brightness", "strength": -50}).min() == 0


def test_unknown_kind_raises():
    with pytest.raises(ValueError):
        apply_perturbation(_image(), {"kind": "rotate", "strength": 1})
```

Adapter test (append to `test_ultralytics_inference_adapter.py`, using that file's existing fake model and video fixtures — read it first): run `infer` with `perturbation={"kind": "brightness", "strength": 50}` and assert the fake model received images whose mean is higher than with `perturbation=None`. Tasks test (append to `test_tasks_inference.py`): assert the document uploaded has `"perturbation"` equal to the payload value and `None` when absent, and that the fake adapter's received `InferenceRequest.perturbation` equals the payload value.

- [ ] **Step 2: Run to verify they fail**

```bash
docker compose cp ml-worker/app/. ml-worker:/app/app/ && docker compose cp ml-worker/tests/. ml-worker:/app/tests/
docker compose exec ml-worker python -m pytest tests/test_perturbation.py -q
```
Expected: FAIL (module missing).

- [ ] **Step 3: Implement**

```python
# ml-worker/app/perturbation.py
"""Degrade a frame before the model sees it (stress tests).

Pure and deterministic given (spec, seed): noise uses a generator seeded with
the frame index, so a rerun of the same run reproduces the same pixels.
"""

import cv2
import numpy as np


def apply_perturbation(image: np.ndarray, spec: dict | None, seed: int = 0) -> np.ndarray:
    if spec is None:
        return image
    kind = spec["kind"]
    strength = float(spec["strength"])
    if kind == "gaussian_noise":
        noise = np.random.default_rng(seed).normal(0.0, strength, image.shape)
        return np.clip(image.astype(np.float32) + noise, 0, 255).astype(np.uint8)
    if kind == "blur":
        return cv2.GaussianBlur(image, (0, 0), sigmaX=strength)
    if kind == "brightness":
        return np.clip(image.astype(np.int16) + int(round(strength)), 0, 255).astype(np.uint8)
    if kind == "jpeg":
        ok, buffer = cv2.imencode(".jpg", image, [cv2.IMWRITE_JPEG_QUALITY, int(strength)])
        if not ok:
            raise ValueError("JPEG encoding failed")
        return cv2.imdecode(buffer, cv2.IMREAD_COLOR)
    raise ValueError(f"Unknown perturbation kind: {kind}")
```

`inference_adapter.py`: add `perturbation: dict | None = None` to `InferenceRequest` (after `confidence_floor`). `ultralytics_inference_adapter.py`: `from app.perturbation import apply_perturbation`; right after `ok, image = capture.retrieve()` succeeds (inside `if ok:`), add `image = apply_perturbation(image, request.perturbation, seed=index)`. `tasks.py`: pass `perturbation=job.payload.get("perturbation")` into `InferenceRequest(...)` and add `"perturbation": job.payload.get("perturbation")` to `document`.

- [ ] **Step 4: Run tests in the container**

```bash
docker compose cp ml-worker/app/. ml-worker:/app/app/ && docker compose cp ml-worker/tests/. ml-worker:/app/tests/
docker compose exec ml-worker python -m pytest tests/test_perturbation.py tests/test_ultralytics_inference_adapter.py tests/test_tasks_inference.py -q
```
Expected: PASS. Do **not** run a real GPU inference here (see the open VRAM issue); that happens in Task 7 only with the user's go-ahead.

- [ ] **Step 5: Commit**

```bash
git add ml-worker
git commit -m "feat: ml-worker degrades frames for stress-test runs" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Compare endpoint (backend)

**Files:**
- Create: `backend/app/inference/compare.py`
- Modify: `backend/app/inference/schemas.py`, `backend/app/inference/service.py`, `backend/app/inference/router.py`
- Test: `backend/tests/test_inference_compare.py`

**Interfaces:**
- Produces: `disagreements(doc_a: dict, doc_b: dict, conf_a: float, conf_b: float) -> list[dict]` with items `{"frame": int, "timestamp_ms": int, "only_a": list[str], "only_b": list[str]}` sorted by frame, names sorted; `service.compare_runs(session, storage, run_a_id, run_b_id, conf_a, conf_b) -> dict`; `service.RunsNotComparable(Exception)`; `GET /inference/compare?run_a=&run_b=&conf_a=&conf_b=` returning `QcCompareRead {frames: list[QcDisagreementRead], total: int, disagreements: int}` (`total` = frames compared).
- Deviation from spec: route is `/inference/compare` (not `/qc/compare`) to stay under the existing router prefix; each item carries `timestamp_ms` so the page can seek and flag without another lookup.

- [ ] **Step 1: Write the failing tests**

```python
# backend/tests/test_inference_compare.py
import app.main  # noqa: F401
from app.inference.compare import disagreements


def _doc(classes, frames):
    return {
        "classes": classes,
        "frames": {
            str(i): {"timestamp_ms": i * 40, "detections": dets}
            for i, dets in frames.items()
        },
    }


def _d(class_id, confidence):
    return {"class_id": class_id, "confidence": confidence, "bbox": [0, 0, 1, 1]}


def test_frames_with_equal_class_sets_do_not_disagree():
    a = _doc(["polyp"], {0: [_d(0, 0.9)], 1: []})
    b = _doc(["polyp"], {0: [_d(0, 0.5)], 1: []})
    assert disagreements(a, b, 0.25, 0.25) == []


def test_only_a_and_only_b_are_reported_by_name():
    a = _doc(["polyp", "foam"], {0: [_d(0, 0.9)], 1: []})
    b = _doc(["polyp", "foam"], {0: [], 1: [_d(1, 0.8)]})
    result = disagreements(a, b, 0.25, 0.25)
    assert result == [
        {"frame": 0, "timestamp_ms": 0, "only_a": ["polyp"], "only_b": []},
        {"frame": 1, "timestamp_ms": 40, "only_a": [], "only_b": ["foam"]},
    ]


def test_classes_are_compared_by_name_not_id():
    a = _doc(["polyp", "foam"], {0: [_d(0, 0.9)]})
    b = _doc(["foam", "polyp"], {0: [_d(1, 0.9)]})  # same class, different id
    assert disagreements(a, b, 0.25, 0.25) == []


def test_each_side_uses_its_own_confidence_threshold():
    a = _doc(["polyp"], {0: [_d(0, 0.4)]})
    b = _doc(["polyp"], {0: [_d(0, 0.4)]})
    assert disagreements(a, b, 0.3, 0.5) == [
        {"frame": 0, "timestamp_ms": 0, "only_a": ["polyp"], "only_b": []}
    ]


def test_frame_missing_from_b_is_skipped_and_empty_docs_give_nothing():
    a = _doc(["polyp"], {0: [_d(0, 0.9)], 5: [_d(0, 0.9)]})
    b = _doc(["polyp"], {0: [_d(0, 0.9)]})
    assert disagreements(a, b, 0.25, 0.25) == []
    assert disagreements(_doc([], {}), _doc([], {}), 0.25, 0.25) == []
```

Endpoint tests (same file, below). Read `backend/tests/test_inference_api.py` and `conftest.py` for how runs are inserted and how storage is faked (`committed_inference_rows`, `app.dependency_overrides[get_storage_service]`), and mirror that. Cases to cover, each asserting status and that the body/detail is a plain sentence:
- two succeeded runs, same video, same stride, with `predictions_key` pointing at a fake storage holding two JSON documents: 200, body `{"frames": [...], "total": 2, "disagreements": 1}`;
- `run_a == run_b`: 409;
- different `video_id`: 409; different `frame_stride`: 409; either `status != succeeded`: 409;
- unknown run id: 404; `conf_a=1.5` or `conf_a=nan`: 422.

- [ ] **Step 2: Run to verify they fail**

Run: `cd backend && uv run pytest tests/test_inference_compare.py -q`
Expected: FAIL (module missing).

- [ ] **Step 3: Implement**

```python
# backend/app/inference/compare.py
"""Frames where two runs disagree on which classes are present."""


def _names(doc: dict, detections: list[dict], threshold: float) -> set[str]:
    classes = doc["classes"]
    return {
        str(classes[d["class_id"]])
        for d in detections
        if d["confidence"] >= threshold and 0 <= d["class_id"] < len(classes)
    }


def disagreements(doc_a: dict, doc_b: dict, conf_a: float, conf_b: float) -> list[dict]:
    result = []
    for key, frame_a in doc_a["frames"].items():
        frame_b = doc_b["frames"].get(key)
        if frame_b is None:
            continue
        names_a = _names(doc_a, frame_a["detections"], conf_a)
        names_b = _names(doc_b, frame_b["detections"], conf_b)
        if names_a != names_b:
            result.append(
                {
                    "frame": int(key),
                    "timestamp_ms": int(frame_a["timestamp_ms"]),
                    "only_a": sorted(names_a - names_b),
                    "only_b": sorted(names_b - names_a),
                }
            )
    return sorted(result, key=lambda item: item["frame"])
```

`schemas.py`:

```python
class QcDisagreementRead(BaseModel):
    frame: int
    timestamp_ms: int
    only_a: list[str]
    only_b: list[str]


class QcCompareRead(BaseModel):
    frames: list[QcDisagreementRead]
    total: int
    disagreements: int
```

`service.py` (imports `json`, `disagreements`):

```python
class RunsNotComparable(Exception):
    """The two runs cannot be put side by side."""


def compare_runs(session, storage, run_a_id, run_b_id, conf_a, conf_b) -> dict:
    if run_a_id == run_b_id:
        raise RunsNotComparable("Pick two different runs to compare")
    run_a, run_b = get_run(session, run_a_id), get_run(session, run_b_id)
    for run in (run_a, run_b):
        if run.status != InferenceRunStatus.SUCCEEDED or not run.predictions_key:
            raise RunsNotComparable(f"Run {run.id} is {run.status.value}, not finished")
    if run_a.video_id != run_b.video_id:
        raise RunsNotComparable("The runs are of different videos")
    if run_a.frame_stride != run_b.frame_stride:
        raise RunsNotComparable("The runs used different frame strides")
    doc_a = json.loads(storage.download(run_a.predictions_key))
    doc_b = json.loads(storage.download(run_b.predictions_key))
    frames = disagreements(doc_a, doc_b, conf_a, conf_b)
    total = len(set(doc_a["frames"]) & set(doc_b["frames"]))
    return {"frames": frames, "total": total, "disagreements": len(frames)}
```

`router.py` (declare before `/runs/{run_id}` is not required since paths differ; add after `list_runs`):

```python
@router.get("/compare", response_model=QcCompareRead)
def compare(
    run_a: int,
    run_b: int,
    conf_a: float = Query(0.25, ge=0, le=1),
    conf_b: float = Query(0.25, ge=0, le=1),
    session: Session = Depends(get_session),
    storage: StorageService = Depends(get_storage_service),
):
    try:
        return service.compare_runs(session, storage, run_a, run_b, conf_a, conf_b)
    except service.InferenceRunNotFound as exc:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(exc))
    except service.RunsNotComparable as exc:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=str(exc))
```

Import `Query` from fastapi and `QcCompareRead` from schemas. FastAPI's `ge/le` rejects NaN? It does not for floats in all versions: add `if conf_a != conf_a or conf_b != conf_b: raise HTTPException(422, ...)` at the top of `compare` and cover it with the NaN test.

- [ ] **Step 4: Run tests**

Run: `cd backend && uv run pytest tests/test_inference_compare.py tests/test_inference_api.py -q`
Expected: PASS.

- [ ] **Step 5: Regenerate OpenAPI and commit**

```bash
cd backend && PYTHONPATH=. uv run python scripts/export_openapi.py && cd .. && git diff --stat openapi.json
git add backend openapi.json
git commit -m "feat: compare two inference runs by class presence" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Frontend logic: comparability, flag kind, compare hook

**Files:**
- Create: `frontend/src/features/qc/compareLogic.ts`, `frontend/src/entities/useQcCompare.ts`
- Modify: `frontend/src/entities/useInferenceRuns.ts` (create body accepts `perturbation`)
- Test: `frontend/src/features/qc/compareLogic.test.ts`, `frontend/src/entities/useQcCompare.test.tsx`

**Interfaces:**
- Produces:
  - `comparability(a: InferenceRun | undefined, b: InferenceRun | undefined): { ok: true } | { ok: false; reason: string }`
  - `flagKindForWrongSide(side: "a" | "b", frame: { only_a: string[]; only_b: string[] }): "fp" | "fn"`
  - `nextDisagreement(timesMs: number[], currentMs: number, direction: 1 | -1): number | null` (strictly after/before the current time, no wrap)
  - `useQcCompare(runA: number | null, runB: number | null, confA: number, confB: number)` returning the TanStack query for `GET /inference/compare`
  - `type QcCompare = components["schemas"]["QcCompareRead"]`
- Consumes: regenerated `schema.d.ts` (`npm run generate-api` or any `npm` hook) with `QcCompareRead`, `InferenceRunRead.perturbation`.

- [ ] **Step 1: Write the failing tests**

```ts
// frontend/src/features/qc/compareLogic.test.ts
import { describe, expect, it } from "vitest";

import { comparability, flagKindForWrongSide, nextDisagreement } from "./compareLogic";

const run = (over: Record<string, unknown> = {}) =>
  ({ id: 1, video_id: 7, frame_stride: 1, status: "succeeded", ...over }) as never;

describe("comparability", () => {
  it("accepts two finished runs of one video with equal stride", () => {
    expect(comparability(run({ id: 1 }), run({ id: 2 }))).toEqual({ ok: true });
  });
  it.each([
    [run({ id: 1 }), run({ id: 1 }), /different runs/i],
    [run({ id: 1 }), run({ id: 2, video_id: 8 }), /different videos/i],
    [run({ id: 1 }), run({ id: 2, frame_stride: 5 }), /stride/i],
    [run({ id: 1 }), run({ id: 2, status: "running" }), /finished/i],
    [undefined, run({ id: 2 }), /two runs/i],
  ])("explains why not", (a, b, reason) => {
    const result = comparability(a, b);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(reason);
  });
});

describe("flagKindForWrongSide", () => {
  it("is fp when the wrong side found a class the other did not", () => {
    expect(flagKindForWrongSide("a", { only_a: ["polyp"], only_b: [] })).toBe("fp");
    expect(flagKindForWrongSide("b", { only_a: [], only_b: ["polyp"] })).toBe("fp");
  });
  it("is fn when the wrong side missed a class the other found", () => {
    expect(flagKindForWrongSide("a", { only_a: [], only_b: ["polyp"] })).toBe("fn");
    expect(flagKindForWrongSide("b", { only_a: ["polyp"], only_b: [] })).toBe("fn");
  });
  it("prefers fp when both sides have exclusive classes", () => {
    expect(flagKindForWrongSide("a", { only_a: ["x"], only_b: ["y"] })).toBe("fp");
  });
});

describe("nextDisagreement", () => {
  const times = [100, 400, 900];
  it("moves strictly forward and backward without wrapping", () => {
    expect(nextDisagreement(times, 100, 1)).toBe(400);
    expect(nextDisagreement(times, 250, 1)).toBe(400);
    expect(nextDisagreement(times, 900, 1)).toBeNull();
    expect(nextDisagreement(times, 400, -1)).toBe(100);
    expect(nextDisagreement(times, 100, -1)).toBeNull();
    expect(nextDisagreement([], 0, 1)).toBeNull();
  });
});
```

`useQcCompare.test.tsx`: mirror `entities/useQcFlags.test.tsx` — mock `apiClient.GET`, assert it is called with `"/inference/compare"` and `params.query = { run_a, run_b, conf_a, conf_b }`, and that the query is disabled while either run id is `null`.

- [ ] **Step 2: Run to verify they fail**

Run: `cd frontend && npx vitest run src/features/qc/compareLogic.test.ts src/entities/useQcCompare.test.tsx`
Expected: FAIL (modules missing).

- [ ] **Step 3: Implement**

```ts
// frontend/src/features/qc/compareLogic.ts
import type { InferenceRun } from "../../entities/useInferenceRuns";

export type Comparability = { ok: true } | { ok: false; reason: string };

export function comparability(a: InferenceRun | undefined, b: InferenceRun | undefined): Comparability {
  if (!a || !b) return { ok: false, reason: "Select two runs to compare" };
  if (a.id === b.id) return { ok: false, reason: "Select two different runs" };
  if (a.status !== "succeeded" || b.status !== "succeeded")
    return { ok: false, reason: "Both runs must be finished" };
  if (a.video_id !== b.video_id) return { ok: false, reason: "The runs are of different videos" };
  if (a.frame_stride !== b.frame_stride)
    return { ok: false, reason: "The runs used different frame strides" };
  return { ok: true };
}

/** fp: the wrong side saw a class the other did not. fn: it missed one. */
export function flagKindForWrongSide(
  side: "a" | "b",
  frame: { only_a: string[]; only_b: string[] },
): "fp" | "fn" {
  const own = side === "a" ? frame.only_a : frame.only_b;
  return own.length > 0 ? "fp" : "fn";
}

export function nextDisagreement(timesMs: number[], currentMs: number, direction: 1 | -1): number | null {
  const sorted = [...timesMs].sort((x, y) => x - y);
  if (direction === 1) return sorted.find((t) => t > currentMs) ?? null;
  return [...sorted].reverse().find((t) => t < currentMs) ?? null;
}
```

```ts
// frontend/src/entities/useQcCompare.ts
import { useQuery } from "@tanstack/react-query";

import { apiClient } from "../shared/api/client";
import type { components } from "../shared/api/generated/schema";

export type QcCompare = components["schemas"]["QcCompareRead"];

export function useQcCompare(runA: number | null, runB: number | null, confA: number, confB: number) {
  return useQuery({
    queryKey: ["qc-compare", runA, runB, confA, confB],
    queryFn: async () => {
      const result = await apiClient.GET("/inference/compare", {
        params: { query: { run_a: runA as number, run_b: runB as number, conf_a: confA, conf_b: confB } },
      });
      if (result.error) throw result.error;
      return result.data;
    },
    enabled: runA !== null && runB !== null,
    // Two predictions documents are downloaded server-side per call.
    staleTime: 30_000,
  });
}
```

In `useCreateInferenceRun` widen the body type with `perturbation?: { kind: "gaussian_noise" | "blur" | "brightness" | "jpeg"; strength: number } | null`.

- [ ] **Step 4: Run tests**

Run: `cd frontend && npm run generate-api && npx vitest run src/features/qc src/entities && npx tsc --noEmit -p .`
Expected: PASS (`tsc` may show the known pre-existing errors listed in memory `reference_pre_existing_red_tests`; none new).

- [ ] **Step 5: Commit**

```bash
git add frontend
git commit -m "feat: compare logic and hook for the QC A/B screen" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Run form perturbation control, stress badge, pair selection

**Files:**
- Modify: `frontend/src/features/qc/RunForm.tsx`, `frontend/src/features/qc/RunsTable.tsx`, `frontend/src/features/qc/QcPage.tsx`
- Test: `frontend/src/features/qc/RunForm.test.tsx`, `frontend/src/features/qc/RunsTable.test.tsx`

**Interfaces:**
- Consumes: `comparability` from Task 4; `InferenceRun.perturbation`.
- Produces: `RunForm.onSubmit` values gain `perturbation: { kind, strength } | null`; `RunsTableProps` gain `selected: number[]` and `onToggleSelect: (id: number) => void`.

- [ ] **Step 1: Write the failing tests**

Add to `RunForm.test.tsx` (use that file's existing render helper):
- default shows a "Perturbation" select with "None"; submitting passes `perturbation: null`;
- choosing "Blur" shows a strength input pre-filled with `2`; submitting passes `{ kind: "blur", strength: 2 }`;
- a strength outside the kind's range (e.g. blur 99) disables the Run button and shows "Blur strength must be 0.5 to 20" (ranges from Global Constraints; defaults: noise 10, blur 2, brightness 30, jpeg 30).

Add to `RunsTable.test.tsx`: a run with `perturbation: { kind: "jpeg", strength: 30 }` renders the badge text `Stress: jpeg 30`; clicking the checkbox labelled `Select run {id} for comparison` calls `onToggleSelect(id)`; runs not `succeeded` have a disabled checkbox.

- [ ] **Step 2: Run to verify they fail**

Run: `cd frontend && npx vitest run src/features/qc/RunForm.test.tsx src/features/qc/RunsTable.test.tsx`
Expected: FAIL.

- [ ] **Step 3: Implement**

`RunForm.tsx`: a `PERTURBATIONS` table `{ gaussian_noise: { label: "Noise", min: 1, max: 100, def: 10 }, blur: { label: "Blur", min: 0.5, max: 20, def: 2 }, brightness: { label: "Brightness", min: -100, max: 100, def: 30 }, jpeg: { label: "JPEG quality", min: 5, max: 95, def: 30 } }`; state `kind: keyof typeof PERTURBATIONS | ""` and `strength: number`; a `<select aria-label="Perturbation">` with a "None" option; when a kind is chosen set `strength` to its default and render `<input type="number" aria-label="Perturbation strength">`; `valid` requires `Number.isFinite(strength)`, within range, and for brightness non-zero; `canRun` includes `valid`; `onSubmit` adds `perturbation: kind ? { kind, strength } : null`. Use the existing `FIELD` class. `QcPage.tsx`: pass `perturbation` through to `createRun.mutate(...)` as `perturbation: perturbation ?? undefined`.

`RunsTable.tsx`: new first column with `<input type="checkbox" aria-label={`Select run ${run.id} for comparison`} checked={selected.includes(run.id)} disabled={run.status !== "succeeded"} onChange={() => onToggleSelect(run.id)} />`; in the Model cell, when `run.perturbation` is set add `<span className="ml-2 rounded bg-amber-900/50 px-1.5 py-0.5 text-xs text-amber-200">Stress: {kind} {strength}</span>`.

`QcPage.tsx`: `const [selected, setSelected] = useState<number[]>([])`; `toggle` keeps at most two ids (a third click drops the oldest); `const verdict = comparability(runs.find(r => r.id === selected[0]), runs.find(r => r.id === selected[1]))`; render a "Compare" button using `useNavigate` to `/qc/compare/${selected[0]}/${selected[1]}`, disabled unless `verdict.ok`, with `title={verdict.ok ? undefined : verdict.reason}` and the reason shown as small gray text next to it when two runs are selected.

- [ ] **Step 4: Run tests**

Run: `cd frontend && npx vitest run src/features/qc`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend
git commit -m "feat: perturbation control, stress badge and pair selection on the QC screen" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 6: A/B screen

**Files:**
- Create: `frontend/src/features/qc/AbComparePage.tsx`, `frontend/src/features/qc/useSyncedVideos.ts`, `frontend/src/features/qc/confidenceFilter.ts`
- Modify: `frontend/src/app/App.tsx:41` (add the route **before** `/qc/:runId`)
- Test: `frontend/src/features/qc/useSyncedVideos.test.ts`, `frontend/src/features/qc/confidenceFilter.test.ts`, `frontend/src/features/qc/AbComparePage.test.tsx`

**Interfaces:**
- Consumes: `useInferenceRun`, `usePredictions`, `useVideo`, `usePutQcFlag(runId)`, `useQcFlags(runId)`, `PredictionOverlay`, `buildFrameIndex`, `useVideoClock`, and Task 4's `useQcCompare`, `flagKindForWrongSide`, `nextDisagreement`.
- Produces: route `/qc/compare/:runA/:runB`; `useSyncedVideos(masterRef, followerRef)` (follower mirrors the master's `play`, `pause`, `seeked`, and `timeupdate` drift > 0.15 s, follower muted); `filterByConfidence(doc: PredictionsDocument, threshold: number): PredictionsDocument`.

- [ ] **Step 1: Write the failing tests**

```ts
// confidenceFilter.test.ts
import { describe, expect, it } from "vitest";
import { filterByConfidence } from "./confidenceFilter";

const doc = {
  task_type: "detection", model: { name: "m", version_id: 1 }, fps: 25, frame_stride: 1,
  classes: ["polyp"],
  frames: { "0": { timestamp_ms: 0, detections: [
    { class_id: 0, confidence: 0.2, bbox: [0, 0, 1, 1] },
    { class_id: 0, confidence: 0.6, bbox: [0, 0, 1, 1] },
  ] } },
} as never;

it("drops detections below the threshold and keeps the rest of the document", () => {
  const out = filterByConfidence(doc, 0.5);
  expect(out.frames["0"].detections).toHaveLength(1);
  expect(out.classes).toEqual(["polyp"]);
});
```

`useSyncedVideos.test.ts`: create two plain objects standing in for `HTMLVideoElement` via `document.createElement("video")` with `play`/`pause` stubbed (`vi.fn().mockResolvedValue(undefined)`), render the hook with `renderHook`, dispatch `play`, `pause` and `seeked` events on the master and assert the follower's `play`/`pause` were called and `currentTime` copied; assert a `timeupdate` with drift under 0.15 s does not touch the follower's `currentTime`.

`AbComparePage.test.tsx` (mock the entity hooks the way `RunsTable`/page tests in this folder do): with a compare result of two disagreements (`only_a: ["polyp"]` at frame 10, `only_b: ["polyp"]` at frame 20), assert:
- the summary line reads `2 disagreements out of 50 frames`;
- "Next disagreement" sets the master video's `currentTime` to `timestamp_ms / 1000` of the first one;
- on frame 10, clicking **A wrong** calls A's `usePutQcFlag` mutate with `{ frame_index: 10, timestamp_ms, kind: "fp" }`, and **B wrong** calls B's mutate with `kind: "fn"`;
- a 409 compare error renders its message in a `role="alert"` element and no video.

- [ ] **Step 2: Run to verify they fail**

Run: `cd frontend && npx vitest run src/features/qc/confidenceFilter.test.ts src/features/qc/useSyncedVideos.test.ts src/features/qc/AbComparePage.test.tsx`
Expected: FAIL.

- [ ] **Step 3: Implement**

`confidenceFilter.ts`:

```ts
import type { PredictionsDocument } from "./predictions";

export function filterByConfidence(doc: PredictionsDocument, threshold: number): PredictionsDocument {
  return {
    ...doc,
    frames: Object.fromEntries(
      Object.entries(doc.frames).map(([key, frame]) => [
        key,
        { ...frame, detections: frame.detections.filter((d) => d.confidence >= threshold) },
      ]),
    ),
  };
}
```

`useSyncedVideos.ts`: `useEffect` attaching listeners to `masterRef.current` (`play` → `follower.play()`, `pause` → `follower.pause()` and copy `currentTime`, `seeked` → copy `currentTime`, `timeupdate` → copy only if `Math.abs(follower.currentTime - master.currentTime) > 0.15`), sets `follower.muted = true`, removes listeners on cleanup. Same drift value as a named constant `DRIFT_SECONDS`.

`AbComparePage.tsx`: params `runA`, `runB`; two `useInferenceRun`, two `usePredictions`, `useVideo(runA.video_id)`; state `confA`, `confB` (default `DISPLAY_CONFIDENCE_THRESHOLD`) with two number sliders labelled "Confidence A"/"Confidence B"; `useQcCompare(runA, runB, confA, confB)`. Layout: summary line, two columns each a `relative bg-black` box with `<video>` (A has `controls`, B has none and is muted via the hook, both `src={video.stream_url}`) plus `PredictionOverlay` with `buildFrameIndex(filterByConfidence(doc, conf))`, headed by the model name (with stress badge if `perturbation`). Below: "Previous disagreement"/"Next disagreement" buttons (keys `[` and `]`, ignored when typing in an input) using `nextDisagreement(times, useVideoClock(videoARef), ±1)` then `videoARef.current.currentTime = t / 1000`; a thin timeline strip of ticks positioned by `timestamp_ms / videoDurationMs`; for the disagreement at the current time (nearest within half a frame step, or exact match to the one navigated to) show `only_a` / `only_b` lists and two buttons **A wrong** / **B wrong** that call `usePutQcFlag(runIdOfSide).mutate({ frame_index, timestamp_ms, kind: flagKindForWrongSide(side, frame) })`, disabled while pending; show a small "Flagged FP on A" style note from `useQcFlags` for that frame. Errors via the existing `errorMessage(error, fallback)` helper in a `role="alert"`. Dark classes only, matching `RunViewPage`.

`App.tsx`: `<Route path="/qc/compare/:runA/:runB" element={<AbComparePage />} />` above the `/qc/:runId` route (otherwise React Router would not confuse them, but keep the more specific first for readability).

- [ ] **Step 4: Run tests and typecheck**

Run: `cd frontend && npx vitest run src/features/qc src/entities && npx tsc --noEmit -p .`
Expected: PASS, no new type errors.

- [ ] **Step 5: Commit**

```bash
git add frontend
git commit -m "feat: QC A/B comparison screen" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 7: Real-stack verification, docs, cleanup

**Files:**
- Modify: `ROADMAP.md` (new section "Phase 3, sub-project 4"), the three superseded lines of `docs/specs/2026-10-08-qc-ab-stress-design.md` (route name, `timestamp_ms` in items)
- No new tests; this task is the real-browser check CLAUDE.md demands.

- [ ] **Step 1: Full automated pass**

Run: `cd backend && uv run pytest -q` and `cd frontend && npm test -- --run` and the ml-worker suite in the container (Task 2 commands, whole `tests/`). Compare failures against memory `reference_pre_existing_red_tests`; any new failure is yours.

- [ ] **Step 2: Ask before using the GPU**

Stop and ask the user for a go-ahead to start one short stress run on a short video (the SAM2 VRAM crash is an open issue; a 5-second video with `frame_stride` 5 keeps it small). Do not start it without a yes. Never touch run #82.

- [ ] **Step 3: Drive the browser**

With the stack up (do not stop or move the user's dev servers), log in with the manual-check account from memory `reference_manual_check_login_and_taxonomy_reimport`, then via Chrome DevTools: create a clean run and a `blur` stress run on the same short video; select both; Compare; step through disagreements with `[`/`]`; press **A wrong** on one frame and **B wrong** on another; confirm the flags appear on the right runs' views and Commit still works; try selecting runs of different videos and confirm the disabled button explains why. Screenshot the A/B screen for the user.

- [ ] **Step 4: Clean up own rows**

Delete the runs, flags and MinIO objects this task created (`inference/{run_id}/predictions.json`, any committed QC sequence and its frames) by precise predicate after backing them up to the scratchpad; sweep `inference_runs`, `qc_flags`, `jobs`, `sequences`, `frames` and MinIO prefixes.

- [ ] **Step 5: Docs and commit**

Write the ROADMAP entry (what was built, deviations: route `/inference/compare`, `timestamp_ms` in items, NMS slider not applied to the comparison, measured compare latency on the real video, anything found in the browser). Fix the two spec lines. Update the memory file `project_qc_flagging_status` neighbor with a new `project_qc_ab_stress_status` entry and the `MEMORY.md` index.

```bash
git add ROADMAP.md docs
git commit -m "docs: record QC A/B and stress tests" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```
