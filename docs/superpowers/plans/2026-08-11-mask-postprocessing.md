# Mask Post-Processing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Clean up jagged contours, speckles, and holes in SAM2 mask output using OpenCV (opening, closing, largest-connected-component, Gaussian contour smoothing), with a per-mask adjustable strength slider that re-applies instantly on the CPU without re-running SAM2.

**Architecture:** `ml-worker` keeps producing only the raw SAM2 mask (no change to `sam2_adapter.py`) and stores it under a new `raw_mask_storage_key` alongside the existing `storage_key`. `backend` (which already depends on `opencv-python-headless` for video processing) owns the one canonical `postprocess_mask()` implementation and applies it in two places: automatically once, synchronously, the first time `GET /jobs/{id}` reports a job as `succeeded`; and on demand via a new `PATCH /annotation/annotations/{id}/mask-postprocess` endpoint whenever a user drags a specific mask's own smoothing slider in `MasksList`. A global default strength lives in the existing `platform_settings` singleton table/`/settings` admin page, and a `ToolsPanel` slider lets a user override that default before running Predict/Track for the current editing session.

**Tech Stack:** FastAPI + SQLAlchemy + Alembic (backend), Celery (ml-worker), React + Zustand + TanStack Query (frontend), OpenCV (`cv2`) + numpy for the mask algorithm.

## Global Constraints

- License: Apache 2.0. `LICENSE`/`NOTICE` stay at repo root (untouched by this work).
- Language: English only in code, comments, docstrings, UI copy. No Russian in committed content.
- UI theme: dark only — no light-background Tailwind classes introduced.
- All binary media (the raw and post-processed mask PNGs) goes through `backend/app/storage.py`'s `StorageService` — never a direct filesystem path.
- `taxonomy_version` handling is untouched by this work — no annotation-creation code path in this plan changes how `taxonomy_version` is derived.
- API contract: REST + OpenAPI, auto-generated. Never hand-roll an untyped `fetch()` — use `apiClient` from `frontend/src/shared/api/client.ts`, and re-run `backend/scripts/export_openapi.py` (`PYTHONPATH=. uv run python scripts/export_openapi.py`) after every backend schema/route change, verified via `git diff --stat openapi.json`.
- TDD: every backend task and every frontend task with logic gets a failing test before the implementation.
- `ml-worker` tests do not run in the host `.venv` (no torch/numpy/cv2 there) — use `docker cp` + `docker compose exec` per `CLAUDE.md`.
- Backend tests: several existing suites (`test_annotation.py`, `test_jobs.py`, `test_settings.py`) hit the **real dev database** directly via `TestClient(app)` (not the `db_session`/`test_engine` fixture), using fixed/get-or-create fixture names. New tests in `test_annotation.py`/`test_jobs.py`/`test_settings.py` must follow that same pattern (register a fresh unique email per test, get-or-create shared taxonomy fixtures) rather than switching to the isolated `db_session` fixture, to stay consistent with the rest of the file. New standalone test files (e.g. `test_mask_postprocess.py`) that need no DB use plain pytest with no fixtures at all.
- Never truncate the dev DB without asking the user first.

---

## File Structure

**Backend — new files:**
- `backend/app/annotation/mask_postprocess.py` — the `postprocess_mask()` algorithm (pure function, numpy in/out).
- `backend/tests/test_mask_postprocess.py` — unit tests for the algorithm.
- `backend/tests/test_mask_postprocess_endpoint.py` — tests for the new PATCH route.
- `backend/alembic/versions/<hash>_add_raw_mask_storage_key.py` — migration for `Annotation.raw_mask_storage_key`.
- `backend/alembic/versions/<hash>_add_mask_postprocess_strength_setting.py` — migration for `PlatformSettings.mask_postprocess_strength`.

**Backend — modified files:**
- `backend/app/annotation/models.py` — add `raw_mask_storage_key` column.
- `backend/app/annotation/schemas.py` — add `mask_postprocess_strength: float | None` to `AnnotationRead`; add new `MaskPostprocessUpdate` request schema.
- `backend/app/annotation/service.py` — add `apply_default_postprocess_for_job()`, add `reapply_mask_postprocess()`.
- `backend/app/annotation/router.py` — populate the new `AnnotationRead` field; add the `PATCH .../mask-postprocess` route; call `apply_default_postprocess_for_job()` from job-status awareness (see Task 6 — the call site is `jobs/router.py`, not here, but this router's `_annotation_read` helper changes).
- `backend/app/jobs/router.py` — `get_job` calls `apply_default_postprocess_for_job()` on the SUCCEEDED transition.
- `backend/app/jobs/schemas.py` — add optional `mask_postprocess_strength` to `Sam2PredictRequest`/`Sam2TrackRequest`.
- `backend/app/jobs/service.py` — `enqueue_sam2_predict`/`enqueue_sam2_track` store the new field in `Job.payload`.
- `backend/app/settings/models.py` — add `mask_postprocess_strength` column to `PlatformSettings`.
- `backend/app/settings/schemas.py` — add matching field to `SettingsRead`/`SettingsUpdate`.
- `backend/app/settings/service.py` — `update_settings()` takes/sets the new field.
- `backend/app/settings/router.py` — pass the new field through PATCH.
- `backend/pyproject.toml` — no change (opencv-python-headless already present).
- `backend/tests/conftest.py` — re-seed `mask_postprocess_strength` in the `test_engine` fixture's manual insert, same as `max_track_range_frames`.
- `backend/tests/test_settings.py`, `backend/tests/test_settings_model.py`, `backend/tests/test_jobs.py`, `backend/tests/test_annotation.py` — extended with new cases.

**ml-worker — modified files:**
- `ml-worker/app/models.py` — add `raw_mask_storage_key` column to the local duplicate `Annotation` model.
- `ml-worker/app/tasks.py` — `run_sam2_predict`/`run_sam2_track` set `raw_mask_storage_key=mask_key` alongside `storage_key=mask_key`.
- `ml-worker/tests/test_tasks_sam2.py` — extended with assertions on the new field.

**Frontend — new files:**
- `frontend/src/features/annotation/MaskSmoothingControl.tsx` — the reusable single-mask smoothing `<input type="range">` (used by `MasksList`); kept as its own tiny component so `MasksList.tsx` doesn't balloon and so it's independently testable.
- `frontend/src/features/annotation/MaskSmoothingControl.test.tsx`
- `frontend/src/entities/useMaskPostprocess.ts` — `useReapplyMaskPostprocess()` mutation hook.
- `frontend/src/entities/useMaskPostprocess.test.tsx`
- `frontend/src/features/annotation/ToolsPanel.test.tsx` — first test file for this component.

**Frontend — modified files:**
- `frontend/src/features/annotation/frameEditorStore.ts` — add `maskSmoothingStrength` + `setMaskSmoothingStrength`.
- `frontend/src/features/annotation/ToolsPanel.tsx` — new "Mask smoothing" section, seeded from `/settings`.
- `frontend/src/features/annotation/MasksList.tsx` — render `<MaskSmoothingControl>` per mask row.
- `frontend/src/features/annotation/FrameEditor.tsx` — `refinePredict()`/`handleTrack()` include `mask_postprocess_strength` in their request payloads.
- `frontend/src/features/settings/SettingsPage.tsx` — new "Mask post-processing" section.
- `frontend/src/entities/useSettings.ts` — `useUpdateSettings()` accepts the new field.
- `frontend/src/entities/useSettings.test.tsx`, `frontend/src/features/settings/SettingsPage.test.tsx` — extended.
- `openapi.json` — regenerated after backend schema changes (Tasks 1–6), committed once at the point the frontend tasks need it (Task 7 start).

---

## Task 1: `postprocess_mask()` algorithm

**Files:**
- Create: `backend/app/annotation/mask_postprocess.py`
- Test: `backend/tests/test_mask_postprocess.py`

**Interfaces:**
- Produces: `postprocess_mask(mask: np.ndarray, strength: float) -> np.ndarray` — used by Task 4 (`service.py`) and Task 5 (endpoint).

- [ ] **Step 1: Write the failing tests**

```python
# backend/tests/test_mask_postprocess.py
import numpy as np
import pytest

from app.annotation.mask_postprocess import postprocess_mask


def _mask_with_speckle() -> np.ndarray:
    """200x200 mask: a 60x60 solid square plus an isolated 2x2 speckle
    30px away from the square, disconnected from it."""
    mask = np.zeros((200, 200), dtype=bool)
    mask[50:110, 50:110] = True
    mask[20:22, 20:22] = True
    return mask


def _mask_with_hole() -> np.ndarray:
    """200x200 solid 80x80 square with a 4x4 hole punched in the middle."""
    mask = np.zeros((200, 200), dtype=bool)
    mask[50:130, 50:130] = True
    mask[88:92, 88:92] = False
    return mask


def test_strength_zero_is_byte_identity():
    mask = _mask_with_speckle()
    result = postprocess_mask(mask, 0.0)
    assert np.array_equal(result, mask)


def test_speckle_removed_by_opening_and_largest_component():
    mask = _mask_with_speckle()
    result = postprocess_mask(mask, 0.5)
    # The speckle's pixels are gone; the main square survives.
    assert not result[20:22, 20:22].any()
    assert result[70:90, 70:90].all()


def test_hole_closed():
    mask = _mask_with_hole()
    result = postprocess_mask(mask, 0.5)
    assert result[88:92, 88:92].all()


def test_contour_smoothing_reduces_perimeter_to_area_ratio():
    import cv2

    # A jagged mask: a square with alternating notches cut into its border.
    mask = np.zeros((200, 200), dtype=bool)
    mask[40:160, 40:160] = True
    for i in range(40, 160, 6):
        mask[i : i + 3, 40:46] = False  # notch the left edge repeatedly

    def perimeter_to_area(m: np.ndarray) -> float:
        contours, _ = cv2.findContours(
            m.astype(np.uint8) * 255, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_NONE
        )
        largest = max(contours, key=cv2.contourArea)
        perimeter = cv2.arcLength(largest, True)
        area = cv2.contourArea(largest)
        return perimeter / area

    before = perimeter_to_area(mask)
    after = perimeter_to_area(postprocess_mask(mask, 1.0))
    assert after < before


def test_empty_mask_after_processing_stays_empty():
    # A single isolated 1px dot: opening erodes it away entirely at high strength.
    mask = np.zeros((200, 200), dtype=bool)
    mask[100, 100] = True
    result = postprocess_mask(mask, 1.0)
    assert not result.any()


@pytest.mark.parametrize("bad_strength", [-0.1, 1.1, 2.0, -5.0])
def test_out_of_range_strength_raises(bad_strength):
    mask = _mask_with_speckle()
    with pytest.raises(ValueError, match="strength"):
        postprocess_mask(mask, bad_strength)
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd backend && uv run pytest tests/test_mask_postprocess.py -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'app.annotation.mask_postprocess'`

- [ ] **Step 3: Write the implementation**

```python
# backend/app/annotation/mask_postprocess.py
import cv2
import numpy as np

# Kernel/blur radii are computed as strength * _RELATIVE_KERNEL_FRACTION *
# min(height, width), so the same strength value behaves consistently
# across differently-sized source videos rather than using a fixed pixel
# count. Tuned empirically against real endoscopy frame resolutions
# (~1000-2000px on the short side) during this task's implementation --
# 0.015 puts strength=1.0 in the 15-30px kernel range for that resolution
# band, visibly smoothing without erasing normal-sized lesion masks.
_RELATIVE_KERNEL_FRACTION = 0.015


def postprocess_mask(mask: np.ndarray, strength: float) -> np.ndarray:
    """Cleans up jagged contours, speckles, and holes in a binary
    segmentation mask using OpenCV morphology + largest-connected-component
    + Gaussian contour smoothing.

    `mask` is a 2D boolean (or {0,1}) array. `strength` in [0, 1]; 0 is a
    no-op identity (returns `mask` unchanged, byte-for-byte). Kernel/blur
    sizes scale with `strength` and with the frame's `min(height, width)`,
    not a fixed pixel count, so the same strength behaves consistently
    across differently-sized source videos.
    """
    if not 0.0 <= strength <= 1.0:
        raise ValueError(f"strength must be in [0, 1], got {strength}")
    if strength == 0.0:
        return mask

    height, width = mask.shape
    kernel_size = max(1, round(strength * _RELATIVE_KERNEL_FRACTION * min(height, width)))
    kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (kernel_size, kernel_size))

    binary = (mask.astype(np.uint8)) * 255
    opened = cv2.morphologyEx(binary, cv2.MORPH_OPEN, kernel)
    closed = cv2.morphologyEx(opened, cv2.MORPH_CLOSE, kernel)

    num_labels, labels, stats, _ = cv2.connectedComponentsWithStats(closed, connectivity=8)
    if num_labels <= 1:
        # No foreground component survived opening/closing -- nothing to
        # keep, and nothing left to smooth.
        return closed > 0

    # Label 0 is background; pick the largest non-background component by area.
    largest_label = 1 + int(np.argmax(stats[1:, cv2.CC_STAT_AREA]))
    largest_only = np.where(labels == largest_label, 255, 0).astype(np.uint8)

    blur_radius = kernel_size
    # GaussianBlur requires an odd kernel size.
    if blur_radius % 2 == 0:
        blur_radius += 1
    blurred = cv2.GaussianBlur(largest_only, (blur_radius, blur_radius), 0)
    _, smoothed = cv2.threshold(blurred, 127, 255, cv2.THRESH_BINARY)

    return smoothed > 0
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd backend && uv run pytest tests/test_mask_postprocess.py -v`
Expected: PASS (all 6 tests, including the 4 parametrized out-of-range cases)

- [ ] **Step 5: Commit**

```bash
cd backend
git add app/annotation/mask_postprocess.py tests/test_mask_postprocess.py
git commit -m "feat: add postprocess_mask() OpenCV mask cleanup algorithm"
```

---

## Task 2: `Annotation.raw_mask_storage_key` column + migration

**Files:**
- Modify: `backend/app/annotation/models.py`
- Create: `backend/alembic/versions/<hash>_add_raw_mask_storage_key.py`
- Modify: `backend/tests/conftest.py` (no change needed here — `raw_mask_storage_key` has no seed-data dependency, unlike `platform_settings`; confirmed in Task 3 instead)
- Test: covered by Task 3's and Task 4's tests (this task has no standalone test — a nullable column addition with a default of `NULL` has no independent behavior to unit-test beyond "the ORM has the attribute", which the later tasks exercise directly)

**Interfaces:**
- Produces: `Annotation.raw_mask_storage_key: str | None` — used by Task 4 (`service.py`), Task 5 (endpoint), Task 6 (ml-worker).

- [ ] **Step 1: Add the column to the model**

In `backend/app/annotation/models.py`, add after the existing `storage_key` line:

```python
    storage_key: Mapped[str | None] = mapped_column(String(500), nullable=True)
    # The untouched SAM2 mask output, written once at Annotation-creation
    # time by ml-worker's tasks.py and never overwritten afterward.
    # `storage_key` is always the CURRENT post-processed mask (may equal
    # this value if post-processing strength is 0); this column is what
    # both the default-apply step (jobs/router.py's get_job) and the
    # per-mask re-apply endpoint (PATCH .../mask-postprocess) re-derive
    # from. NULL for annotations created before this column existed, and
    # for SAM3 annotations (post-processing is SAM2-only for now) -- see
    # docs/superpowers/specs/2026-08-11-mask-postprocessing-design.md.
    raw_mask_storage_key: Mapped[str | None] = mapped_column(String(500), nullable=True)
```

- [ ] **Step 2: Generate the migration**

Run:
```bash
cd backend
uv run alembic revision --autogenerate -m "add raw_mask_storage_key to annotations"
```

- [ ] **Step 3: Verify the generated migration**

Open the newly created file under `backend/alembic/versions/`. It must contain exactly one `op.add_column('annotations', sa.Column('raw_mask_storage_key', sa.String(length=500), nullable=True))` in `upgrade()` and the matching `op.drop_column('annotations', 'raw_mask_storage_key')` in `downgrade()`. If autogenerate produced any unrelated diff (it shouldn't, since no other model changed yet), remove it — commit only this column addition.

- [ ] **Step 4: Apply the migration to the dev database**

Run: `cd backend && uv run alembic upgrade head`
Expected: no errors; `\d annotations` in psql shows the new nullable column.

- [ ] **Step 5: Apply the migration to the test database**

The `endoscopy_test` database is built by `tests/conftest.py`'s `Base.metadata.create_all(engine)`, not by running migrations — so this step only matters for the real dev DB (already done in Step 4) and for keeping `endoscopy_test`'s schema in sync automatically next time the test suite runs (since `create_all` reads the current ORM model, which Step 1 already updated). No manual action needed here; verify by running any existing annotation test:

Run: `cd backend && uv run pytest tests/test_annotation.py -v`
Expected: PASS (existing tests unaffected — the new column is nullable and unused so far)

- [ ] **Step 6: Commit**

```bash
cd backend
git add app/annotation/models.py alembic/versions/
git commit -m "feat: add Annotation.raw_mask_storage_key column"
```

---

## Task 3: `PlatformSettings.mask_postprocess_strength` + `/settings` API

**Files:**
- Modify: `backend/app/settings/models.py`
- Modify: `backend/app/settings/schemas.py`
- Modify: `backend/app/settings/service.py`
- Modify: `backend/app/settings/router.py`
- Modify: `backend/tests/conftest.py`
- Modify: `backend/tests/test_settings_model.py`
- Modify: `backend/tests/test_settings.py`
- Create: `backend/alembic/versions/<hash>_add_mask_postprocess_strength_setting.py`

**Interfaces:**
- Consumes: nothing new.
- Produces: `PlatformSettings.mask_postprocess_strength: float` (default `0.3`), `GET /settings` response field `mask_postprocess_strength`, `PATCH /settings` accepts `mask_postprocess_strength`. Used by Task 4 (`apply_default_postprocess_for_job`) and Task 7 (frontend `ToolsPanel`).

- [ ] **Step 1: Write the failing model test**

In `backend/tests/test_settings_model.py`, add:

```python
def test_platform_settings_model_has_default_mask_postprocess_strength():
    from app.settings.models import PlatformSettings

    row = PlatformSettings()
    assert row.mask_postprocess_strength == 0.3
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && uv run pytest tests/test_settings_model.py -v`
Expected: FAIL with `AttributeError: 'PlatformSettings' object has no attribute 'mask_postprocess_strength'`

- [ ] **Step 3: Add the column to the model**

In `backend/app/settings/models.py`:

```python
from sqlalchemy import Float, Integer
from sqlalchemy.orm import Mapped, mapped_column

from app.db import Base


class PlatformSettings(Base):
    __tablename__ = "platform_settings"

    id: Mapped[int] = mapped_column(primary_key=True)
    max_track_range_frames: Mapped[int] = mapped_column(Integer, default=10)
    # Default strength applied by jobs/router.py's get_job the first time a
    # SAM2 predict/track job succeeds, when the job's own request didn't
    # specify one. See docs/superpowers/specs/2026-08-11-mask-postprocessing-design.md.
    mask_postprocess_strength: Mapped[float] = mapped_column(Float, default=0.3)

    def __init__(self, **kwargs):
        if "max_track_range_frames" not in kwargs:
            kwargs["max_track_range_frames"] = 10
        if "mask_postprocess_strength" not in kwargs:
            kwargs["mask_postprocess_strength"] = 0.3
        super().__init__(**kwargs)
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && uv run pytest tests/test_settings_model.py -v`
Expected: PASS

- [ ] **Step 5: Generate and verify the migration**

```bash
cd backend
uv run alembic revision -m "add mask_postprocess_strength to platform_settings"
```

This needs to be written by hand (not autogenerated), matching the seed-row pattern of `65dffec667fb_add_platform_settings_table.py`, since the singleton row already exists and needs the new column backfilled:

```python
"""add mask_postprocess_strength to platform_settings

Revision ID: <generated>
Revises: <previous head>
Create Date: <generated>

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "<generated>"
down_revision: Union[str, Sequence[str], None] = "<previous head>"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "platform_settings",
        sa.Column("mask_postprocess_strength", sa.Float(), nullable=False, server_default="0.3"),
    )
    op.alter_column("platform_settings", "mask_postprocess_strength", server_default=None)


def downgrade() -> None:
    op.drop_column("platform_settings", "mask_postprocess_strength")
```

(`server_default="0.3"` backfills the existing `id=1` row without a separate `UPDATE`, then is dropped so future inserts rely on the ORM-level default instead of a DB-level one — matching how `max_track_range_frames` has no `server_default` either.)

- [ ] **Step 6: Apply the migration to the dev database**

Run: `cd backend && uv run alembic upgrade head`
Expected: no errors; `SELECT * FROM platform_settings;` shows `mask_postprocess_strength = 0.3` on the existing row.

- [ ] **Step 7: Re-seed the test database fixture**

In `backend/tests/conftest.py`, update the `test_engine` fixture's manual insert:

```python
    with engine.begin() as connection:
        connection.execute(
            text(
                "INSERT INTO platform_settings (id, max_track_range_frames, mask_postprocess_strength) "
                "VALUES (1, 10, 0.3) ON CONFLICT (id) DO NOTHING"
            )
        )
```

- [ ] **Step 8: Write the failing API tests**

In `backend/tests/test_settings.py`, add:

```python
def test_get_settings_includes_mask_postprocess_strength():
    token = _register_and_login("settings-get2@example.com", role="annotator")
    response = client.get("/settings", headers=_headers(token))
    assert response.status_code == 200
    assert "mask_postprocess_strength" in response.json()


def test_patch_settings_allows_admin_to_update_mask_postprocess_strength():
    token = _register_and_login("settings-patch4@example.com", role="admin")
    response = client.patch(
        "/settings",
        json={"max_track_range_frames": 10, "mask_postprocess_strength": 0.6},
        headers=_headers(token),
    )
    assert response.status_code == 200
    assert response.json()["mask_postprocess_strength"] == 0.6

    get_response = client.get("/settings", headers=_headers(token))
    assert get_response.json()["mask_postprocess_strength"] == 0.6

    client.patch(
        "/settings",
        json={"max_track_range_frames": 10, "mask_postprocess_strength": 0.3},
        headers=_headers(token),
    )


def test_patch_settings_rejects_mask_postprocess_strength_out_of_range():
    token = _register_and_login("settings-patch5@example.com", role="admin")
    response = client.patch(
        "/settings",
        json={"max_track_range_frames": 10, "mask_postprocess_strength": 1.5},
        headers=_headers(token),
    )
    assert response.status_code == 422
```

- [ ] **Step 9: Run tests to verify they fail**

Run: `cd backend && uv run pytest tests/test_settings.py -v`
Expected: FAIL — `test_get_settings_includes_mask_postprocess_strength` fails the `in` assertion; the PATCH tests fail because `SettingsUpdate` doesn't accept the field yet (Pydantic will silently ignore unknown fields by default, so the PATCH tests fail on the response not containing/reflecting the new value rather than a validation error).

- [ ] **Step 10: Update the schemas**

In `backend/app/settings/schemas.py`:

```python
from pydantic import BaseModel, ConfigDict, Field


class SettingsRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    max_track_range_frames: int
    mask_postprocess_strength: float


class SettingsUpdate(BaseModel):
    max_track_range_frames: int = Field(ge=1)
    mask_postprocess_strength: float = Field(ge=0.0, le=1.0)
```

- [ ] **Step 11: Update the service**

In `backend/app/settings/service.py`:

```python
def update_settings(
    session: Session, max_track_range_frames: int, mask_postprocess_strength: float, user: User
) -> PlatformSettings:
    require_admin(user)
    settings_row = get_platform_settings(session)
    settings_row.max_track_range_frames = max_track_range_frames
    settings_row.mask_postprocess_strength = mask_postprocess_strength
    session.commit()
    session.refresh(settings_row)
    return settings_row
```

- [ ] **Step 12: Update the router**

In `backend/app/settings/router.py`:

```python
@router.patch("", response_model=SettingsRead)
def patch_settings(
    payload: SettingsUpdate,
    current_user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
) -> SettingsRead:
    return update_settings(
        session, payload.max_track_range_frames, payload.mask_postprocess_strength, current_user
    )
```

- [ ] **Step 13: Run tests to verify they pass**

Run: `cd backend && uv run pytest tests/test_settings.py tests/test_settings_model.py tests/test_jobs.py -v`
Expected: PASS. `test_jobs.py` is included here because `test_enqueue_sam2_track_rejects_combined_range_over_live_setting` and its sibling directly mutate `PlatformSettings` rows — confirm they still pass now that `SettingsUpdate`/`update_settings` require the new field (those two tests mutate the ORM row directly, not via PATCH, so they're unaffected, but running them confirms no regression).

- [ ] **Step 14: Regenerate the committed OpenAPI schema**

Run:
```bash
cd backend
PYTHONPATH=. uv run python scripts/export_openapi.py
git diff --stat openapi.json
```
Expected: `openapi.json` changed (new `mask_postprocess_strength` field in `SettingsRead`/`SettingsUpdate` schemas).

- [ ] **Step 15: Commit**

```bash
cd backend
git add app/settings/ alembic/versions/ tests/conftest.py tests/test_settings.py tests/test_settings_model.py
git add ../openapi.json
git commit -m "feat: add mask_postprocess_strength to platform settings"
```

---

## Task 4: Default post-processing on job success + `AnnotationRead.mask_postprocess_strength`

**Files:**
- Modify: `backend/app/annotation/service.py`
- Modify: `backend/app/annotation/schemas.py`
- Modify: `backend/app/annotation/router.py`
- Modify: `backend/app/jobs/router.py`
- Modify: `backend/app/jobs/schemas.py`
- Modify: `backend/app/jobs/service.py`
- Test: `backend/tests/test_jobs.py` (new cases), `backend/tests/test_annotation.py` (new case for the read schema field)

**Interfaces:**
- Consumes: `postprocess_mask(mask: np.ndarray, strength: float) -> np.ndarray` (Task 1), `Annotation.raw_mask_storage_key` (Task 2), `PlatformSettings.mask_postprocess_strength` (Task 3), `get_platform_settings(session) -> PlatformSettings` (existing, `app/settings/service.py`), `StorageService.download(key) -> bytes` / `.upload(key, data, content_type)` (existing, `app/storage.py`).
- Produces: `apply_default_postprocess_for_job(session: Session, job: Job, storage: StorageService) -> None` in `backend/app/annotation/service.py` — used by `jobs/router.py`'s `get_job` (this task) and referenced by Task 5's tests as the sibling of `reapply_mask_postprocess`. `AnnotationRead.mask_postprocess_strength: float | None` — used by Task 7 (frontend `MasksList`/`MaskSmoothingControl`).

- [ ] **Step 1: Write the failing job-side-effect tests**

In `backend/tests/test_jobs.py`, add (near the existing `sam2` tests):

```python
def test_get_job_applies_default_postprocess_strength_on_first_succeeded_poll():
    from app.annotation.models import Annotation, AnnotationStatus, AnnotationType
    from app.auth.models import User
    from app.db import SessionLocal
    from app.jobs.models import Job, JobStatus, JobType
    from app.storage import get_storage_service

    token = _register_and_login("jobs-postprocess1@example.com")
    frame_id, _ = _create_frame(token)
    label_id = _create_label()

    storage = get_storage_service()
    import io

    import numpy as np
    from PIL import Image

    raw_mask = np.zeros((100, 100), dtype=bool)
    raw_mask[20:80, 20:80] = True
    raw_mask[10:12, 10:12] = True  # isolated speckle for the default (0.3) strength to remove
    buffer = io.BytesIO()
    Image.fromarray((raw_mask.astype("uint8")) * 255, mode="L").save(buffer, format="PNG")
    raw_key = "masks/postprocess-test/raw.png"
    storage.upload(raw_key, buffer.getvalue(), content_type="image/png")

    session = SessionLocal()
    user = session.query(User).filter(User.email == "jobs-postprocess1@example.com").one()
    job = Job(
        job_type=JobType.SAM2_PREDICT,
        status=JobStatus.SUCCEEDED,
        progress=100,
        payload={"frame_id": frame_id, "label_id": label_id, "prompts": []},
        created_by_id=user.id,
    )
    session.add(job)
    session.commit()
    session.refresh(job)
    annotation = Annotation(
        frame_id=frame_id,
        label_id=label_id,
        taxonomy_version=1,
        annotation_type=AnnotationType.MASK,
        payload={},
        status=AnnotationStatus.DRAFT,
        created_by_id=user.id,
        storage_key=raw_key,
        raw_mask_storage_key=raw_key,
        job_id=job.id,
    )
    session.add(annotation)
    session.commit()
    session.refresh(annotation)
    job_id = job.id
    annotation_id = annotation.id
    session.close()

    response = client.get(f"/jobs/{job_id}", headers=_headers(token))
    assert response.status_code == 200

    session = SessionLocal()
    refreshed = session.get(Annotation, annotation_id)
    assert refreshed.payload.get("mask_postprocess_strength") == 0.3
    postprocessed_bytes = storage.download(refreshed.storage_key)
    session.close()

    # Content actually changed from the raw upload (speckle removed by the
    # default 0.3 strength).
    postprocessed = np.array(Image.open(io.BytesIO(postprocessed_bytes)))
    assert not (postprocessed[10:12, 10:12] > 0).any()


def test_get_job_does_not_reapply_postprocess_on_second_poll():
    from unittest.mock import patch

    from app.annotation.models import Annotation, AnnotationStatus, AnnotationType
    from app.auth.models import User
    from app.db import SessionLocal
    from app.jobs.models import Job, JobStatus, JobType
    from app.storage import get_storage_service

    token = _register_and_login("jobs-postprocess2@example.com")
    frame_id, _ = _create_frame(token)
    label_id = _create_label()

    storage = get_storage_service()
    raw_key = "masks/postprocess-test/raw2.png"
    storage.upload(raw_key, b"fake-png-bytes-not-decoded-in-this-test", content_type="image/png")

    session = SessionLocal()
    user = session.query(User).filter(User.email == "jobs-postprocess2@example.com").one()
    job = Job(
        job_type=JobType.SAM2_PREDICT, status=JobStatus.SUCCEEDED, progress=100,
        payload={"frame_id": frame_id, "label_id": label_id, "prompts": [], "mask_postprocess_strength": 0.0},
        created_by_id=user.id,
    )
    session.add(job)
    session.commit()
    session.refresh(job)
    annotation = Annotation(
        frame_id=frame_id, label_id=label_id, taxonomy_version=1,
        annotation_type=AnnotationType.MASK, payload={}, status=AnnotationStatus.DRAFT,
        created_by_id=user.id, storage_key=raw_key, raw_mask_storage_key=raw_key, job_id=job.id,
    )
    session.add(annotation)
    session.commit()
    job_id = job.id
    session.close()

    client.get(f"/jobs/{job_id}", headers=_headers(token))

    with patch("app.annotation.service.postprocess_mask") as mock_postprocess:
        client.get(f"/jobs/{job_id}", headers=_headers(token))
        mock_postprocess.assert_not_called()
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd backend && uv run pytest tests/test_jobs.py -v -k postprocess`
Expected: FAIL — `test_get_job_applies_default_postprocess_strength_on_first_succeeded_poll` fails because `payload.get("mask_postprocess_strength")` is `None` (nothing applies it yet); the second test fails/errors because `app.annotation.service.postprocess_mask` doesn't exist to patch yet.

- [ ] **Step 3: Add `mask_postprocess_strength` to `AnnotationRead` and populate it**

In `backend/app/annotation/schemas.py`, add to `AnnotationRead`:

```python
    mask_url: str | None = None
    job_id: int | None = None
    mask_postprocess_strength: float | None = None
```

In `backend/app/annotation/router.py`, update `_annotation_read`:

```python
def _annotation_read(annotation: Annotation, storage: StorageService) -> AnnotationRead:
    return AnnotationRead(
        id=annotation.id,
        frame_id=annotation.frame_id,
        label_id=annotation.label_id,
        taxonomy_version=annotation.taxonomy_version,
        annotation_type=annotation.annotation_type,
        status=annotation.status,
        created_by_id=annotation.created_by_id,
        reviewed_by_id=annotation.reviewed_by_id,
        mask_url=storage.url_for(annotation.storage_key) if annotation.storage_key else None,
        job_id=annotation.job_id,
        mask_postprocess_strength=annotation.payload.get("mask_postprocess_strength")
        if annotation.payload
        else None,
    )
```

- [ ] **Step 4: Add `apply_default_postprocess_for_job` to the service**

In `backend/app/annotation/service.py`:

```python
from app.annotation.mask_postprocess import postprocess_mask
from app.jobs.models import Job
from app.settings.service import get_platform_settings
from app.storage import StorageService
import io

import numpy as np
from PIL import Image


def apply_default_postprocess_for_job(session: Session, job: Job, storage: StorageService) -> None:
    """Applies the default mask-cleanup strength to every Annotation
    created by `job`, exactly once. Called from jobs/router.py's get_job
    on the request where the job's status is first observed as SUCCEEDED.
    A second poll is a no-op because every Annotation this function
    touches has `payload["mask_postprocess_strength"]` set afterward,
    which this function checks before doing any work.

    Only Annotations with a `raw_mask_storage_key` are eligible -- SAM3
    annotations (post-processing is SAM2-only for now) and any annotation
    predating this column simply have nothing to derive a cleaned mask
    from, so they're skipped rather than erroring the whole job-status
    request.
    """
    annotations = session.query(Annotation).filter(Annotation.job_id == job.id).all()
    pending = [
        a
        for a in annotations
        if a.raw_mask_storage_key is not None
        and (not a.payload or "mask_postprocess_strength" not in a.payload)
    ]
    if not pending:
        return

    strength = job.payload.get("mask_postprocess_strength")
    if strength is None:
        strength = get_platform_settings(session).mask_postprocess_strength

    for annotation in pending:
        raw_bytes = storage.download(annotation.raw_mask_storage_key)
        raw_image = Image.open(io.BytesIO(raw_bytes)).convert("L")
        raw_mask = np.array(raw_image) > 127

        cleaned_mask = postprocess_mask(raw_mask, strength)

        cleaned_image = Image.fromarray((cleaned_mask.astype(np.uint8)) * 255, mode="L")
        buffer = io.BytesIO()
        cleaned_image.save(buffer, format="PNG")
        storage.upload(annotation.storage_key, buffer.getvalue(), content_type="image/png")

        annotation.payload = {**(annotation.payload or {}), "mask_postprocess_strength": strength}

    session.commit()
```

Add the needed import at the top of `service.py`: `from app.annotation.models import Annotation, AnnotationType` (already partially imported — extend the existing `from app.annotation.models import Annotation, AnnotationType` line if present, or add `Annotation` to it).

- [ ] **Step 5: Wire it into `get_job`**

In `backend/app/jobs/router.py`:

```python
from app.annotation.service import apply_default_postprocess_for_job
from app.jobs.models import Job, JobStatus
from app.storage import StorageService, get_storage_service


@router.get("/{job_id}", response_model=JobRead)
def get_job(
    job_id: int,
    session: Session = Depends(get_session),
    storage: StorageService = Depends(get_storage_service),
) -> Job:
    job = session.get(Job, job_id)
    if job is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Job not found")
    if job.status == JobStatus.SUCCEEDED:
        apply_default_postprocess_for_job(session, job, storage)
    return job
```

- [ ] **Step 6: Add the optional field to the job request schemas**

In `backend/app/jobs/schemas.py`:

```python
class Sam2PredictRequest(BaseModel):
    frame_id: int
    label_id: int
    prompts: list[PromptIn]
    mask_postprocess_strength: float | None = Field(default=None, ge=0.0, le=1.0)


class Sam2TrackRequest(BaseModel):
    sequence_id: int
    label_id: int
    prompts: list[PromptIn]
    anchor_frame_id: int
    backward: int = Field(ge=0)
    forward: int = Field(ge=0)
    mask_postprocess_strength: float | None = Field(default=None, ge=0.0, le=1.0)
```

- [ ] **Step 7: Store it in the job payload**

In `backend/app/jobs/service.py`, update `enqueue_sam2_predict` and `enqueue_sam2_track`:

```python
def enqueue_sam2_predict(
    session: Session,
    frame_id: int,
    label_id: int,
    prompts: list[dict],
    created_by: User,
    mask_postprocess_strength: float | None = None,
) -> Job:
    _require_label(session, label_id)

    job = Job(
        job_type=JobType.SAM2_PREDICT,
        status=JobStatus.PENDING,
        payload={
            "frame_id": frame_id,
            "label_id": label_id,
            "prompts": prompts,
            "mask_postprocess_strength": mask_postprocess_strength,
        },
        created_by_id=created_by.id,
    )
    session.add(job)
    session.commit()
    session.refresh(job)

    celery_app.send_task("sam2_predict", args=[job.id])
    return job


def enqueue_sam2_track(
    session: Session,
    sequence_id: int,
    label_id: int,
    prompts: list[dict],
    anchor_frame_id: int,
    backward: int,
    forward: int,
    created_by: User,
    mask_postprocess_strength: float | None = None,
) -> Job:
    _require_label(session, label_id)

    max_range = get_platform_settings(session).max_track_range_frames
    if backward + forward > max_range:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
            detail=(
                f"backward + forward must not exceed {max_range} frames "
                f"(got {backward + forward}) -- see Settings page"
            ),
        )

    job = Job(
        job_type=JobType.SAM2_TRACK,
        status=JobStatus.PENDING,
        payload={
            "sequence_id": sequence_id,
            "label_id": label_id,
            "prompts": prompts,
            "anchor_frame_id": anchor_frame_id,
            "backward": backward,
            "forward": forward,
            "mask_postprocess_strength": mask_postprocess_strength,
        },
        created_by_id=created_by.id,
    )
    session.add(job)
    session.commit()
    session.refresh(job)

    celery_app.send_task("sam2_track", args=[job.id])
    return job
```

And in `backend/app/jobs/router.py`'s existing `create_sam2_predict_job`/`create_sam2_track_job`, pass the new field through:

```python
@router.post("/sam2/predict", response_model=JobRead, status_code=status.HTTP_201_CREATED)
def create_sam2_predict_job(
    payload: Sam2PredictRequest,
    current_user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
) -> Job:
    prompts = [p.model_dump() for p in payload.prompts]
    return enqueue_sam2_predict(
        session, payload.frame_id, payload.label_id, prompts, current_user,
        mask_postprocess_strength=payload.mask_postprocess_strength,
    )


@router.post("/sam2/track", response_model=JobRead, status_code=status.HTTP_201_CREATED)
def create_sam2_track_job(
    payload: Sam2TrackRequest,
    current_user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
) -> Job:
    prompts = [p.model_dump() for p in payload.prompts]
    return enqueue_sam2_track(
        session,
        payload.sequence_id,
        payload.label_id,
        prompts,
        payload.anchor_frame_id,
        payload.backward,
        payload.forward,
        current_user,
        mask_postprocess_strength=payload.mask_postprocess_strength,
    )
```

- [ ] **Step 8: Run tests to verify they pass**

Run: `cd backend && uv run pytest tests/test_jobs.py tests/test_annotation.py -v`
Expected: PASS (all tests, including the two new ones and every pre-existing test in both files — the `mask_postprocess_strength` field defaults to `None` so untouched SAM3 request tests are unaffected).

- [ ] **Step 9: Regenerate the committed OpenAPI schema**

Run:
```bash
cd backend
PYTHONPATH=. uv run python scripts/export_openapi.py
git diff --stat openapi.json
```
Expected: `openapi.json` changed (new `mask_postprocess_strength` fields in `Sam2PredictRequest`/`Sam2TrackRequest`/`AnnotationRead`).

- [ ] **Step 10: Commit**

```bash
cd backend
git add app/annotation/ app/jobs/ tests/test_jobs.py tests/test_annotation.py
git add ../openapi.json
git commit -m "feat: apply default mask post-processing when a SAM2 job succeeds"
```

---

## Task 5: Per-mask re-apply endpoint

**Files:**
- Modify: `backend/app/annotation/service.py`
- Modify: `backend/app/annotation/schemas.py`
- Modify: `backend/app/annotation/router.py`
- Test: `backend/tests/test_mask_postprocess_endpoint.py`

**Interfaces:**
- Consumes: `postprocess_mask()` (Task 1), `Annotation.raw_mask_storage_key` (Task 2), `StorageService` (existing).
- Produces: `reapply_mask_postprocess(session: Session, annotation_id: int, strength: float, storage: StorageService) -> Annotation` in `backend/app/annotation/service.py`. `PATCH /annotation/annotations/{annotation_id}/mask-postprocess` route. Used by Task 7 (`frontend/src/entities/useMaskPostprocess.ts`).

- [ ] **Step 1: Write the failing tests**

```python
# backend/tests/test_mask_postprocess_endpoint.py
import io

import numpy as np
from fastapi.testclient import TestClient
from PIL import Image

from app.main import app

client = TestClient(app)


def _register_and_login(email: str) -> str:
    client.post("/auth/register", json={"email": email, "password": "pass1234", "role": "annotator"})
    response = client.post("/auth/login", json={"email": email, "password": "pass1234"})
    return response.json()["access_token"]


def _headers(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


def _upload_raw_mask(key: str) -> None:
    from app.storage import get_storage_service

    mask = np.zeros((100, 100), dtype=bool)
    mask[20:80, 20:80] = True
    mask[10:12, 10:12] = True  # speckle
    buffer = io.BytesIO()
    Image.fromarray((mask.astype("uint8")) * 255, mode="L").save(buffer, format="PNG")
    get_storage_service().upload(key, buffer.getvalue(), content_type="image/png")


def _create_frame(token: str) -> int:
    headers = _headers(token)
    from pathlib import Path

    from app.db import SessionLocal
    from app.taxonomy.models import Procedure

    session = SessionLocal()
    procedure = session.query(Procedure).filter_by(name="postprocess-endpoint-procedure").one_or_none()
    if procedure is None:
        procedure = Procedure(name="postprocess-endpoint-procedure")
        session.add(procedure)
        session.commit()
        session.refresh(procedure)
    procedure_id = procedure.id
    session.close()

    fixture = Path(__file__).parent / "fixtures" / "tiny.mp4"
    with open(fixture, "rb") as f:
        upload = client.post(
            "/media/videos", files={"file": ("tiny.mp4", f, "video/mp4")},
            data={"title": "postprocess endpoint source", "procedure_id": procedure_id}, headers=headers,
        )
    video_id = upload.json()["id"]
    sequence = client.post(
        f"/media/videos/{video_id}/sequences",
        json={"name": "test sequence", "start_time": 0, "duration": 2},
        headers=headers,
    ).json()
    frames = client.get(f"/media/sequences/{sequence['id']}/frames", headers=headers).json()
    return frames[0]["id"]


def _create_label() -> int:
    from app.db import SessionLocal
    from app.taxonomy.models import Category, EvaluationType, Label, Procedure

    session = SessionLocal()
    procedure = session.query(Procedure).filter_by(name="postprocess-endpoint-label-procedure").one_or_none()
    if procedure is None:
        procedure = Procedure(name="postprocess-endpoint-label-procedure")
        session.add(procedure)
        session.flush()
    category = session.query(Category).filter_by(
        name="postprocess-endpoint-category", procedure_id=procedure.id
    ).one_or_none()
    if category is None:
        category = Category(name="postprocess-endpoint-category", procedure_id=procedure.id)
        session.add(category)
        session.flush()
    evaluation_type = session.query(EvaluationType).filter_by(
        name="postprocess-endpoint-evaluation-type"
    ).one_or_none()
    if evaluation_type is None:
        evaluation_type = EvaluationType(name="postprocess-endpoint-evaluation-type")
        session.add(evaluation_type)
        session.flush()
    label = Label(
        name="postprocess-endpoint-label", category_id=category.id,
        evaluation_type_id=evaluation_type.id, taxonomy_version=1,
    )
    session.add(label)
    session.commit()
    session.refresh(label)
    label_id = label.id
    session.close()
    return label_id


```

Each test below creates its `Annotation` row inline (matching the existing style in `test_annotation.py`, which never factors that step into a shared helper because it needs the `User` looked up by the actual registered email):

```python
def test_reapply_postprocess_updates_storage_key_and_payload():
    from app.annotation.models import Annotation, AnnotationStatus, AnnotationType
    from app.auth.models import User
    from app.db import SessionLocal
    from app.storage import get_storage_service

    email = "postprocess-endpoint1@example.com"
    token = _register_and_login(email)
    frame_id = _create_frame(token)
    label_id = _create_label()

    raw_key = "masks/postprocess-endpoint-test/raw1.png"
    _upload_raw_mask(raw_key)

    session = SessionLocal()
    user = session.query(User).filter(User.email == email).one()
    annotation = Annotation(
        frame_id=frame_id, label_id=label_id, taxonomy_version=1,
        annotation_type=AnnotationType.MASK, payload={}, status=AnnotationStatus.DRAFT,
        created_by_id=user.id, storage_key=raw_key, raw_mask_storage_key=raw_key,
    )
    session.add(annotation)
    session.commit()
    session.refresh(annotation)
    annotation_id = annotation.id
    session.close()

    response = client.patch(
        f"/annotation/annotations/{annotation_id}/mask-postprocess",
        json={"strength": 0.5},
        headers=_headers(token),
    )

    assert response.status_code == 200
    body = response.json()
    assert body["mask_postprocess_strength"] == 0.5

    session = SessionLocal()
    refreshed = session.get(Annotation, annotation_id)
    postprocessed_bytes = get_storage_service().download(refreshed.storage_key)
    session.close()

    postprocessed = np.array(Image.open(io.BytesIO(postprocessed_bytes)))
    assert not (postprocessed[10:12, 10:12] > 0).any()  # speckle removed


def test_reapply_postprocess_404s_for_missing_annotation():
    token = _register_and_login("postprocess-endpoint2@example.com")

    response = client.patch(
        "/annotation/annotations/999999999/mask-postprocess",
        json={"strength": 0.5},
        headers=_headers(token),
    )

    assert response.status_code == 404


def test_reapply_postprocess_404s_for_annotation_without_raw_mask():
    from app.annotation.models import Annotation, AnnotationStatus, AnnotationType
    from app.auth.models import User
    from app.db import SessionLocal

    email = "postprocess-endpoint3@example.com"
    token = _register_and_login(email)
    frame_id = _create_frame(token)
    label_id = _create_label()

    session = SessionLocal()
    user = session.query(User).filter(User.email == email).one()
    annotation = Annotation(
        frame_id=frame_id, label_id=label_id, taxonomy_version=1,
        annotation_type=AnnotationType.MASK, payload={}, status=AnnotationStatus.DRAFT,
        created_by_id=user.id, storage_key="masks/no-raw/mask.png", raw_mask_storage_key=None,
    )
    session.add(annotation)
    session.commit()
    session.refresh(annotation)
    annotation_id = annotation.id
    session.close()

    response = client.patch(
        f"/annotation/annotations/{annotation_id}/mask-postprocess",
        json={"strength": 0.5},
        headers=_headers(token),
    )

    assert response.status_code == 404


def test_reapply_postprocess_rejects_strength_out_of_range():
    email = "postprocess-endpoint4@example.com"
    token = _register_and_login(email)
    frame_id = _create_frame(token)
    label_id = _create_label()

    from app.annotation.models import Annotation, AnnotationStatus, AnnotationType
    from app.auth.models import User
    from app.db import SessionLocal

    raw_key = "masks/postprocess-endpoint-test/raw4.png"
    _upload_raw_mask(raw_key)

    session = SessionLocal()
    user = session.query(User).filter(User.email == email).one()
    annotation = Annotation(
        frame_id=frame_id, label_id=label_id, taxonomy_version=1,
        annotation_type=AnnotationType.MASK, payload={}, status=AnnotationStatus.DRAFT,
        created_by_id=user.id, storage_key=raw_key, raw_mask_storage_key=raw_key,
    )
    session.add(annotation)
    session.commit()
    session.refresh(annotation)
    annotation_id = annotation.id
    session.close()

    response = client.patch(
        f"/annotation/annotations/{annotation_id}/mask-postprocess",
        json={"strength": 1.5},
        headers=_headers(token),
    )

    assert response.status_code == 422


def test_reapply_postprocess_requires_auth():
    response = client.patch(
        "/annotation/annotations/1/mask-postprocess",
        json={"strength": 0.5},
    )
    assert response.status_code == 401
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd backend && uv run pytest tests/test_mask_postprocess_endpoint.py -v`
Expected: FAIL with 404s (route doesn't exist yet — FastAPI returns 404 for an unmatched route, so `test_reapply_postprocess_404s_for_missing_annotation` may spuriously "pass" for the wrong reason; check that `test_reapply_postprocess_updates_storage_key_and_payload` fails, confirming the route is genuinely missing, not that the test is wrong).

- [ ] **Step 3: Add `MaskPostprocessUpdate` schema**

In `backend/app/annotation/schemas.py`:

```python
class MaskPostprocessUpdate(BaseModel):
    strength: float = Field(ge=0.0, le=1.0)
```

(Add `Field` to the existing `from pydantic import BaseModel, ConfigDict` import line: `from pydantic import BaseModel, ConfigDict, Field`.)

- [ ] **Step 4: Add `reapply_mask_postprocess` to the service**

In `backend/app/annotation/service.py`:

```python
def reapply_mask_postprocess(
    session: Session, annotation_id: int, strength: float, storage: StorageService
) -> Annotation:
    annotation = session.get(Annotation, annotation_id)
    if annotation is None or annotation.raw_mask_storage_key is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Annotation or raw mask not found")

    raw_bytes = storage.download(annotation.raw_mask_storage_key)
    raw_image = Image.open(io.BytesIO(raw_bytes)).convert("L")
    raw_mask = np.array(raw_image) > 127

    cleaned_mask = postprocess_mask(raw_mask, strength)

    cleaned_image = Image.fromarray((cleaned_mask.astype(np.uint8)) * 255, mode="L")
    buffer = io.BytesIO()
    cleaned_image.save(buffer, format="PNG")
    storage.upload(annotation.storage_key, buffer.getvalue(), content_type="image/png")

    annotation.payload = {**(annotation.payload or {}), "mask_postprocess_strength": strength}
    session.commit()
    session.refresh(annotation)
    return annotation
```

(`io`, `numpy as np`, `Image` are already imported from Task 4's `apply_default_postprocess_for_job` addition — reuse those same module-level imports rather than re-adding them.)

- [ ] **Step 5: Add the route**

In `backend/app/annotation/router.py`:

```python
from app.annotation.schemas import (
    AnnotationCreate,
    AnnotationRead,
    AnnotationStatusUpdate,
    MaskPostprocessUpdate,
)
from app.annotation.service import (
    create_classification_annotation,
    reapply_mask_postprocess,
    require_reviewer_or_admin,
)


@router.patch("/annotations/{annotation_id}/mask-postprocess", response_model=AnnotationRead)
def update_mask_postprocess(
    annotation_id: int,
    payload: MaskPostprocessUpdate,
    session: Session = Depends(get_session),
    storage: StorageService = Depends(get_storage_service),
) -> AnnotationRead:
    annotation = reapply_mask_postprocess(session, annotation_id, payload.strength, storage)
    return _annotation_read(annotation, storage)
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `cd backend && uv run pytest tests/test_mask_postprocess_endpoint.py -v`
Expected: PASS (all 5 tests)

- [ ] **Step 7: Run the full backend suite to check for regressions**

Run: `cd backend && uv run pytest -v`
Expected: PASS (all tests across the whole backend suite — this is the first full-suite checkpoint since Task 1)

- [ ] **Step 8: Regenerate the committed OpenAPI schema**

Run:
```bash
cd backend
PYTHONPATH=. uv run python scripts/export_openapi.py
git diff --stat openapi.json
```
Expected: `openapi.json` changed (new `PATCH /annotation/annotations/{annotation_id}/mask-postprocess` route and `MaskPostprocessUpdate` schema).

- [ ] **Step 9: Commit**

```bash
cd backend
git add app/annotation/ tests/test_mask_postprocess_endpoint.py
git add ../openapi.json
git commit -m "feat: add per-mask post-processing re-apply endpoint"
```

---

## Task 6: `ml-worker` writes `raw_mask_storage_key`

**Files:**
- Modify: `ml-worker/app/models.py`
- Modify: `ml-worker/app/tasks.py`
- Test: `ml-worker/tests/test_tasks_sam2.py`

**Interfaces:**
- Consumes: nothing new from earlier tasks (this is an independent duplicate model, per the spec's "Why the algorithm lives in backend" section).
- Produces: `Annotation.raw_mask_storage_key` set on every SAM2-created annotation, consumed by `backend`'s `apply_default_postprocess_for_job`/`reapply_mask_postprocess` reading the same Postgres row from the other service.

This task must run inside the `ml-worker` container per `CLAUDE.md`'s testing workflow — the host `.venv` lacks torch/numpy. Confirm the container is up (`docker compose up -d`) before starting.

- [ ] **Step 1: Write the failing tests**

In `ml-worker/tests/test_tasks_sam2.py`, add two new test functions (place them right after `test_run_sam2_predict_creates_annotation_and_marks_job_succeeded`):

```python
def test_run_sam2_predict_sets_raw_mask_storage_key_equal_to_storage_key():
    fake_adapter = MagicMock()
    fake_adapter.predict.return_value = MagicMock(mask_png=b"png-bytes", score=0.87)

    mock_session = MagicMock()
    mock_job = MagicMock(payload={"frame_id": 1, "label_id": 2, "prompts": []}, created_by_id=1)
    mock_frame = MagicMock(id=1, storage_key="frames/1.png")
    mock_label = MagicMock(id=2, taxonomy_version=3)

    def get_side_effect(model, pk):
        from app.models import Frame, Job
        if model is Job:
            return mock_job
        if model is Frame:
            return mock_frame
        return None

    mock_session.get.side_effect = get_side_effect

    with (
        patch.object(tasks_module, "_get_default_sam2_adapter", return_value=fake_adapter),
        patch.object(tasks_module, "_evict_sam3_models"),
        patch.object(tasks_module, "_load_label", return_value=mock_label),
        patch("app.tasks.SessionLocal", return_value=mock_session),
        patch("app.tasks.get_storage_service"),
    ):
        tasks_module.run_sam2_predict(job_id=1)

    created_annotation = mock_session.add.call_args[0][0]
    assert created_annotation.raw_mask_storage_key == created_annotation.storage_key
    assert created_annotation.raw_mask_storage_key is not None


def test_run_sam2_track_sets_raw_mask_storage_key_on_every_created_annotation():
    import torch

    fake_adapter = MagicMock()
    fake_adapter.track.return_value = [
        MagicMock(mask_png=b"png-0", score=1.0),
        MagicMock(mask_png=b"png-1", score=1.0),
    ]

    mock_session = MagicMock()
    mock_job = MagicMock(
        payload={
            "sequence_id": 1, "label_id": 2, "prompts": [], "anchor_frame_id": 100,
            "backward": 0, "forward": 1,
        },
        created_by_id=1,
    )
    mock_label = MagicMock(id=2, taxonomy_version=3)
    mock_frames = [
        MagicMock(id=100, frame_index=0, storage_key="frames/100.png"),
        MagicMock(id=101, frame_index=1, storage_key="frames/101.png"),
    ]

    def get_side_effect(model, pk):
        from app.models import Job
        if model is Job:
            return mock_job
        return None

    mock_session.get.side_effect = get_side_effect
    mock_query = MagicMock()
    mock_query.filter.return_value.order_by.return_value.all.return_value = mock_frames
    mock_session.query.return_value = mock_query

    with (
        patch.object(tasks_module, "_get_default_sam2_adapter", return_value=fake_adapter),
        patch.object(tasks_module, "_evict_sam3_models"),
        patch.object(tasks_module, "_load_label", return_value=mock_label),
        patch("app.tasks.SessionLocal", return_value=mock_session),
        patch("app.tasks.get_storage_service"),
        patch("app.tasks.torch.cuda.mem_get_info", return_value=(10**12, 10**12)),
        patch("app.tasks.torch.cuda.memory_reserved", return_value=0),
    ):
        tasks_module.run_sam2_track(job_id=1)

    created_annotations = [call_args[0][0] for call_args in mock_session.add.call_args_list]
    mask_annotations = [a for a in created_annotations if hasattr(a, "raw_mask_storage_key")]
    assert len(mask_annotations) == 2
    for annotation in mask_annotations:
        assert annotation.raw_mask_storage_key == annotation.storage_key
```

Note: check the exact VRAM pre-flight mocking pattern already used by other `run_sam2_track` tests in this same file (e.g. `test_run_sam2_track_sets_job_id_on_every_created_annotation` at line 176) before finalizing the `torch.cuda.mem_get_info`/`memory_reserved` patches above — copy whatever pattern that existing test already uses for the pre-flight VRAM check, since it must be mocked identically or `run_sam2_track` raises `_InsufficientVramError` before ever reaching annotation creation.

- [ ] **Step 2: Copy the test file into the running container and run to verify failure**

```bash
docker compose cp ml-worker/tests/test_tasks_sam2.py ml-worker:/app/tests/test_tasks_sam2.py
docker compose exec ml-worker uv run pytest tests/test_tasks_sam2.py -v -k raw_mask_storage_key
```
Expected: FAIL with `AttributeError: Mock object has no attribute 'raw_mask_storage_key'` or similar (the field doesn't exist on the model yet, so the `MagicMock`'s auto-speccing doesn't apply here since `Annotation(...)` is constructed for real inside `run_sam2_predict`/`run_sam2_track` — the failure should be an `AssertionError` on `created_annotation.raw_mask_storage_key == created_annotation.storage_key` comparing `None`/attribute-not-set against a real key, or a `TypeError` from the constructor rejecting an unknown kwarg once Step 4 below is attempted before Step 3 — do Step 3 (model) before Step 4 (tasks.py) to see the intended failure mode).

- [ ] **Step 3: Add the column to ml-worker's duplicate model**

In `ml-worker/app/models.py`, add after the existing `storage_key` line inside `Annotation`:

```python
    storage_key: Mapped[str | None] = mapped_column(String(500), nullable=True)
    # Mirrors backend/app/annotation/models.py's raw_mask_storage_key --
    # see that file's docstring and
    # docs/superpowers/specs/2026-08-11-mask-postprocessing-design.md.
    # ml-worker always writes this equal to storage_key at creation time;
    # only backend ever changes storage_key afterward (post-processing).
    raw_mask_storage_key: Mapped[str | None] = mapped_column(String(500), nullable=True)
```

- [ ] **Step 4: Update `run_sam2_predict` and `run_sam2_track`**

In `ml-worker/app/tasks.py`, in `run_sam2_predict`, change:

```python
        mask_key = f"masks/{frame_id}/{job_id}.png"
        storage.upload(mask_key, result.mask_png, content_type="image/png")

        annotation = Annotation(
            frame_id=frame_id,
            label_id=label.id,
            taxonomy_version=label.taxonomy_version,
            annotation_type=AnnotationType.MASK,
            payload={"prompts": prompts, "score": result.score},
            status=AnnotationStatus.DRAFT,
            created_by_id=job.created_by_id,
            storage_key=mask_key,
            raw_mask_storage_key=mask_key,
            job_id=job_id,
        )
```

And identically in `run_sam2_track`'s per-frame loop:

```python
        for index, (frame, result) in enumerate(zip(tracked_frames, results)):
            mask_key = f"masks/{frame.id}/{job_id}.png"
            storage.upload(mask_key, result.mask_png, content_type="image/png")
            annotation = Annotation(
                frame_id=frame.id,
                label_id=label.id,
                taxonomy_version=label.taxonomy_version,
                annotation_type=AnnotationType.MASK,
                payload={"prompts": prompts, "score": result.score},
                status=AnnotationStatus.DRAFT,
                created_by_id=job.created_by_id,
                storage_key=mask_key,
                raw_mask_storage_key=mask_key,
                job_id=job_id,
            )
```

Do **not** modify `run_sam3_predict`/`run_sam3_track` — SAM3 annotations stay without a `raw_mask_storage_key`, per the spec.

- [ ] **Step 5: Copy both changed files into the container and run to verify pass**

```bash
docker compose cp ml-worker/app/models.py ml-worker:/app/app/models.py
docker compose cp ml-worker/app/tasks.py ml-worker:/app/app/tasks.py
docker compose cp ml-worker/tests/test_tasks_sam2.py ml-worker:/app/tests/test_tasks_sam2.py
docker compose exec ml-worker uv run pytest tests/test_tasks_sam2.py -v
```
Expected: PASS (all tests in the file, including the two new ones and every pre-existing `run_sam2_predict`/`run_sam2_track` test — confirms no regression from the new column).

- [ ] **Step 6: Apply the same migration Task 2 already wrote to the real dev database (already done)**

No new migration needed here — `ml-worker`'s `Annotation` is a duplicate SQLAlchemy mapping onto the *same* `annotations` Postgres table that Task 2's migration already altered. Confirm by checking the container connects to the same Postgres instance as `backend` (already true per `docker-compose.yml`/`CLAUDE.md`); no further DB step is required.

- [ ] **Step 7: Commit**

```bash
git add ml-worker/app/models.py ml-worker/app/tasks.py ml-worker/tests/test_tasks_sam2.py
git commit -m "feat: ml-worker writes raw_mask_storage_key alongside storage_key"
```

---

## Task 7: Frontend — settings page, ToolsPanel slider, request payloads

**Files:**
- Modify: `frontend/src/entities/useSettings.ts`
- Modify: `frontend/src/entities/useSettings.test.tsx`
- Modify: `frontend/src/features/settings/SettingsPage.tsx`
- Modify: `frontend/src/features/settings/SettingsPage.test.tsx`
- Modify: `frontend/src/features/annotation/frameEditorStore.ts`
- Modify: `frontend/src/features/annotation/ToolsPanel.tsx`
- Create: `frontend/src/features/annotation/ToolsPanel.test.tsx`
- Modify: `frontend/src/features/annotation/FrameEditor.tsx`

**Interfaces:**
- Consumes: `GET /settings` now returns `mask_postprocess_strength` (Task 3); `Sam2PredictRequest`/`Sam2TrackRequest` accept `mask_postprocess_strength` (Task 4). Both surfaced in the regenerated `openapi.json`/`schema.d.ts` from Task 3/4.
- Produces: `FrameEditorState.maskSmoothingStrength: number` + `setMaskSmoothingStrength(value: number): void` — used by Task 8 (`MaskSmoothingControl`/`MasksList` don't consume this directly, but `FrameEditor.tsx`'s payload-building does).

Before starting, regenerate the frontend's typed API client against the now-updated `openapi.json` (Tasks 3–5 already committed it):

```bash
cd frontend
npm run generate-api
```

- [ ] **Step 1: Write the failing `useSettings` test**

In `frontend/src/entities/useSettings.test.tsx`, extend the existing `describe("useUpdateSettings", ...)` block:

```typescript
  it("PATCHes both settings fields and invalidates the settings query", async () => {
    vi.mocked(apiClient.PATCH).mockResolvedValue({
      data: { max_track_range_frames: 8, mask_postprocess_strength: 0.6 },
      error: undefined,
    } as never);

    const { result } = renderHook(() => useUpdateSettings(), { wrapper });
    result.current.mutate({ maxTrackRangeFrames: 8, maskPostprocessStrength: 0.6 });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(apiClient.PATCH).toHaveBeenCalledWith("/settings", {
      body: { max_track_range_frames: 8, mask_postprocess_strength: 0.6 },
    });
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npm run test -- useSettings.test.tsx`
Expected: FAIL — `useUpdateSettings`'s mutation function doesn't accept `maskPostprocessStrength` yet (TypeScript compile error surfaced as a test failure, or a runtime mismatch on the PATCH body assertion).

- [ ] **Step 3: Update `useSettings.ts`**

```typescript
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { apiClient } from "../shared/api/client";

export function useSettings() {
  return useQuery({
    queryKey: ["settings"],
    queryFn: async () => {
      const result = await apiClient.GET("/settings", {});
      if (result.error) throw result.error;
      return result.data;
    },
  });
}

export function useUpdateSettings() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({
      maxTrackRangeFrames,
      maskPostprocessStrength,
    }: {
      maxTrackRangeFrames: number;
      maskPostprocessStrength: number;
    }) => {
      const result = await apiClient.PATCH("/settings", {
        body: {
          max_track_range_frames: maxTrackRangeFrames,
          mask_postprocess_strength: maskPostprocessStrength,
        },
      });
      if (result.error) throw result.error;
      return result.data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["settings"] });
    },
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd frontend && npm run test -- useSettings.test.tsx`
Expected: PASS

- [ ] **Step 5: Write the failing `SettingsPage` test**

In `frontend/src/features/settings/SettingsPage.test.tsx`, check the existing test file's structure first (read it before writing — it wasn't included in this plan's research, so match its existing `vi.mock`/render helper pattern exactly, mirroring `useSettings.test.tsx`'s style). Add a case:

```typescript
  it("renders a mask smoothing strength field pre-filled from settings and saves both fields together", async () => {
    vi.mocked(apiClient.GET).mockResolvedValue({
      data: { max_track_range_frames: 10, mask_postprocess_strength: 0.3 },
      error: undefined,
    } as never);
    vi.mocked(apiClient.PATCH).mockResolvedValue({
      data: { max_track_range_frames: 10, mask_postprocess_strength: 0.7 },
      error: undefined,
    } as never);

    render(<SettingsPage />, { wrapper });

    const strengthInput = await screen.findByLabelText(/default mask smoothing strength/i);
    expect(strengthInput).toHaveValue(0.3);

    fireEvent.change(strengthInput, { target: { value: "0.7" } });
    fireEvent.click(screen.getByRole("button", { name: /save/i }));

    await waitFor(() =>
      expect(apiClient.PATCH).toHaveBeenCalledWith("/settings", {
        body: { max_track_range_frames: 10, mask_postprocess_strength: 0.7 },
      }),
    );
  });
```

(Match the exact `render`/`wrapper` helper already present in the file — read it first and adapt import names/render call to whatever's already there rather than assuming `render(<SettingsPage />, { wrapper })` is the exact call signature used.)

- [ ] **Step 6: Run test to verify it fails**

Run: `cd frontend && npm run test -- SettingsPage.test.tsx`
Expected: FAIL — no "default mask smoothing strength" label exists yet.

- [ ] **Step 7: Update `SettingsPage.tsx`**

```typescript
import { useEffect, useRef, useState } from "react";

import { useSettings, useUpdateSettings } from "../../entities/useSettings";
import { errorDetail } from "../../shared/api/errors";

export function SettingsPage() {
  const settingsQuery = useSettings();
  const updateSettings = useUpdateSettings();
  const [maxTrackRangeFrames, setMaxTrackRangeFrames] = useState<number | "">("");
  const [maskPostprocessStrength, setMaskPostprocessStrength] = useState<number | "">("");
  const [error, setError] = useState<string | null>(null);
  const hasInitializedField = useRef(false);

  useEffect(() => {
    if (settingsQuery.data && !hasInitializedField.current) {
      hasInitializedField.current = true;
      setMaxTrackRangeFrames(settingsQuery.data.max_track_range_frames);
      setMaskPostprocessStrength(settingsQuery.data.mask_postprocess_strength);
    }
  }, [settingsQuery.data]);

  if (!settingsQuery.data) {
    return (
      <div className="mx-auto max-w-xl p-6 text-gray-100">
        <h1 className="mb-6 text-xl font-semibold">Settings</h1>
        <p className="text-sm text-gray-400">Loading…</p>
      </div>
    );
  }

  function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (maxTrackRangeFrames === "" || maskPostprocessStrength === "") return;
    setError(null);
    updateSettings.mutate(
      { maxTrackRangeFrames, maskPostprocessStrength },
      {
        onError: (mutationError: unknown) => {
          setError(errorDetail(mutationError, "Save failed"));
        },
      }
    );
  }

  return (
    <div className="mx-auto max-w-xl p-6 text-gray-100">
      <h1 className="mb-6 text-xl font-semibold">Settings</h1>
      <section className="mb-4 rounded border border-gray-800 bg-gray-900 p-4">
        <h2 className="mb-3 text-sm font-medium text-gray-300">GPU / Performance</h2>
        <form onSubmit={handleSubmit} className="flex flex-col gap-2">
          <label className="flex flex-col gap-1 text-sm text-gray-300">
            Max SAM2 tracking range (combined frames)
            <input
              type="number"
              min={1}
              value={maxTrackRangeFrames}
              onChange={(event) =>
                setMaxTrackRangeFrames(event.target.value === "" ? "" : Number(event.target.value))
              }
              className="w-32 rounded border border-gray-700 bg-gray-800 px-2 py-1 text-sm text-gray-100"
            />
          </label>
          <p className="text-xs text-gray-500">
            This GPU has a known VRAM stability issue at larger tracking ranges. Lower is safer.
          </p>

          <h2 className="mb-3 mt-4 text-sm font-medium text-gray-300">Mask post-processing</h2>
          <label className="flex flex-col gap-1 text-sm text-gray-300">
            Default mask smoothing strength (0–1)
            <input
              type="number"
              min={0}
              max={1}
              step={0.01}
              value={maskPostprocessStrength}
              onChange={(event) =>
                setMaskPostprocessStrength(event.target.value === "" ? "" : Number(event.target.value))
              }
              className="w-32 rounded border border-gray-700 bg-gray-800 px-2 py-1 text-sm text-gray-100"
            />
          </label>
          <p className="text-xs text-gray-500">
            Applied automatically to new SAM2 masks unless overridden in the frame editor. 0 disables
            cleanup entirely.
          </p>

          <button
            type="submit"
            disabled={maxTrackRangeFrames === "" || maskPostprocessStrength === ""}
            className="mt-2 w-fit rounded bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-500 disabled:cursor-not-allowed disabled:opacity-40"
          >
            Save
          </button>
          {error && <p className="text-xs text-red-400">{error}</p>}
        </form>
      </section>
    </div>
  );
}
```

- [ ] **Step 8: Run test to verify it passes**

Run: `cd frontend && npm run test -- SettingsPage.test.tsx`
Expected: PASS

- [ ] **Step 9: Add `maskSmoothingStrength` to the frame editor store**

In `frontend/src/features/annotation/frameEditorStore.ts`, add to `FrameEditorState`:

```typescript
  backward: number;
  forward: number;
  maskSmoothingStrength: number;
  setActiveModel: (model: SegmentationModel) => void;
  // ... existing methods ...
  setBackward: (value: number) => void;
  setForward: (value: number) => void;
  setMaskSmoothingStrength: (value: number) => void;
  reset: () => void;
```

And add near `DEFAULT_COLOR`:

```typescript
// Overwritten as soon as GET /settings resolves (see ToolsPanel.tsx) --
// this is only the value shown before that first fetch completes.
const DEFAULT_MASK_SMOOTHING_STRENGTH = 0.3;
```

In `createFrameEditorStore()`'s initial state and actions:

```typescript
    backward: DEFAULT_BACKWARD,
    forward: DEFAULT_FORWARD,
    maskSmoothingStrength: DEFAULT_MASK_SMOOTHING_STRENGTH,
    // ... existing actions ...
    setBackward: (value) => set({ backward: value }),
    setForward: (value) => set({ forward: value }),
    setMaskSmoothingStrength: (value) => set({ maskSmoothingStrength: value }),
```

`reset()` does **not** clear `maskSmoothingStrength` — it's a per-session preference tied to the currently open frame editor, not per-frame or per-object state, matching how `activeTool`/`color` behave in `reset()` today (they're also preserved-by-omission for most fields; only re-check `reset()`'s existing field list to confirm `maskSmoothingStrength` should be left out of it, consistent with `activeModel` also being absent from `reset()`).

- [ ] **Step 10: Write the failing `ToolsPanel` test**

Create `frontend/src/features/annotation/ToolsPanel.test.tsx`:

```typescript
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";

import { apiClient } from "../../shared/api/client";
import { createFrameEditorStore } from "./frameEditorStore";
import { ToolsPanel } from "./ToolsPanel";

vi.mock("../../shared/api/client", () => ({
  apiClient: { GET: vi.fn(), POST: vi.fn(), PATCH: vi.fn(), DELETE: vi.fn() },
}));

function renderPanel() {
  vi.mocked(apiClient.GET).mockResolvedValue({
    data: { max_track_range_frames: 20, mask_postprocess_strength: 0.4 },
    error: undefined,
  } as never);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const store = createFrameEditorStore();
  render(
    <QueryClientProvider client={queryClient}>
      <ToolsPanel
        store={store}
        annotations={[]}
        frameId={1}
        onTrack={vi.fn()}
        procedureId={null}
        vramUsedBytes={null}
        vramTotalBytes={null}
        vramIsLive={false}
        maxBackward={10}
        maxForward={10}
      />
    </QueryClientProvider>,
  );
  return { store };
}

describe("ToolsPanel mask smoothing", () => {
  it("seeds the smoothing slider from GET /settings on first load", async () => {
    const { store } = renderPanel();
    await waitFor(() => expect(store.getState().maskSmoothingStrength).toBe(0.4));
  });

  it("updates the store when the user drags the slider, without calling PATCH /settings", async () => {
    const { store } = renderPanel();
    await waitFor(() => expect(store.getState().maskSmoothingStrength).toBe(0.4));

    const slider = screen.getByLabelText(/mask smoothing/i);
    fireEvent.change(slider, { target: { value: "0.8" } });

    expect(store.getState().maskSmoothingStrength).toBe(0.8);
    expect(apiClient.PATCH).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 11: Run test to verify it fails**

Run: `cd frontend && npm run test -- ToolsPanel.test.tsx`
Expected: FAIL — no element matches `/mask smoothing/i` yet.

- [ ] **Step 12: Add the slider to `ToolsPanel.tsx`**

```typescript
import { useEffect, useState } from "react";
import { useStore } from "zustand/react";

import { useSettings } from "../../entities/useSettings";
import type { components } from "../../shared/api/generated/schema";
import { CascadingLabelPicker } from "./CascadingLabelPicker";
import type { FrameEditorStore, PromptType } from "./frameEditorStore";
import { MasksList } from "./MasksList";
import { TrackControls } from "./TrackControls";
import { VramGauge } from "./VramGauge";

// ... existing type/const declarations unchanged ...

export function ToolsPanel({
  store,
  annotations,
  frameId,
  onTrack,
  procedureId,
  vramUsedBytes,
  vramTotalBytes,
  vramIsLive,
  maxBackward,
  maxForward,
}: ToolsPanelProps) {
  const activeModel = useStore(store, (state) => state.activeModel);
  const activeTool = useStore(store, (state) => state.activeTool);
  const setActiveModel = useStore(store, (state) => state.setActiveModel);
  const setActiveTool = useStore(store, (state) => state.setActiveTool);
  const labelTagId = useStore(store, (state) => state.labelTagId);
  const toolDisabled = labelTagId === null;

  const maskSmoothingStrength = useStore(store, (state) => state.maskSmoothingStrength);
  const setMaskSmoothingStrength = useStore(store, (state) => state.setMaskSmoothingStrength);
  const settingsQuery = useSettings();
  const hasSeededSmoothing = useRef(false);
  useEffect(() => {
    if (settingsQuery.data && !hasSeededSmoothing.current) {
      hasSeededSmoothing.current = true;
      store.getState().setMaskSmoothingStrength(settingsQuery.data.mask_postprocess_strength);
    }
  }, [settingsQuery.data, store]);

  // ... existing labelPickerPulseAt/isPulsing block unchanged ...

  return (
    <aside className="flex w-[630px] shrink-0 flex-col gap-5 overflow-y-auto border-l border-gray-800 bg-gray-950 p-4">
      <section className="space-y-1">
        <h2 className="text-[11px] font-medium text-gray-500">Model</h2>
        {/* ... existing Model tablist unchanged ... */}
      </section>

      <section className="space-y-1">
        <h2 className="text-[11px] font-medium text-gray-500">Mask smoothing</h2>
        <label className="flex items-center gap-2 text-xs text-gray-400">
          <input
            type="range"
            min={0}
            max={1}
            step={0.01}
            value={maskSmoothingStrength}
            aria-label="Mask smoothing"
            onChange={(event) => setMaskSmoothingStrength(Number(event.target.value))}
            className="flex-1"
          />
          <span className="w-10 shrink-0 text-right tabular-nums">{maskSmoothingStrength.toFixed(2)}</span>
        </label>
      </section>

      <section className="space-y-1">
        <VramGauge vramUsedBytes={vramUsedBytes} vramTotalBytes={vramTotalBytes} isLive={vramIsLive} />
      </section>

      {/* ... rest of the component unchanged ... */}
    </aside>
  );
}
```

Add `useRef` to the existing `import { useEffect, useState } from "react";` line, making it `import { useEffect, useRef, useState } from "react";`.

- [ ] **Step 13: Run test to verify it passes**

Run: `cd frontend && npm run test -- ToolsPanel.test.tsx`
Expected: PASS

- [ ] **Step 14: Include the strength in Predict/Track request payloads**

In `frontend/src/features/annotation/FrameEditor.tsx`, update `refinePredict`:

```typescript
    predictMutation.mutate(
      {
        frame_id: frameId,
        label_id: state.labelTagId,
        prompts,
        mask_postprocess_strength: state.maskSmoothingStrength,
      },
      {
        onSuccess: (data) => {
          if (!data) return;
          setActiveJobId(data.id);
          if (previousDraftId !== null) {
            deleteAnnotation.mutate(previousDraftId);
          }
        },
      },
    );
```

And `handleTrack`:

```typescript
    trackMutation.mutate(
      {
        sequence_id: frameQuery.data?.sequence_id ?? 0,
        label_id: state.labelTagId,
        prompts: state.pendingPrompts,
        anchor_frame_id: frameId,
        backward,
        forward,
        mask_postprocess_strength: state.maskSmoothingStrength,
      },
      {
        onSuccess: (data) => {
          if (data) setActiveJobId(data.id);
          const draftId = store.getState().draftAnnotationId;
          if (draftId !== null) deleteAnnotation.mutate(draftId);
          store.getState().clearPrompts();
        },
      },
    );
```

- [ ] **Step 15: Run the full frontend test suite to check for regressions**

Run: `cd frontend && npm run test`
Expected: PASS (all suites — this touches shared state (`frameEditorStore.ts`) and a component (`ToolsPanel.tsx`) that other tests may indirectly render)

- [ ] **Step 16: Commit**

```bash
cd frontend
git add src/entities/useSettings.ts src/entities/useSettings.test.tsx
git add src/features/settings/SettingsPage.tsx src/features/settings/SettingsPage.test.tsx
git add src/features/annotation/frameEditorStore.ts src/features/annotation/ToolsPanel.tsx src/features/annotation/ToolsPanel.test.tsx
git add src/features/annotation/FrameEditor.tsx
git commit -m "feat: add mask smoothing settings field and ToolsPanel slider"
```

---

## Task 8: Frontend — per-mask smoothing control in `MasksList`

**Files:**
- Create: `frontend/src/entities/useMaskPostprocess.ts`
- Create: `frontend/src/entities/useMaskPostprocess.test.tsx`
- Create: `frontend/src/features/annotation/MaskSmoothingControl.tsx`
- Create: `frontend/src/features/annotation/MaskSmoothingControl.test.tsx`
- Modify: `frontend/src/features/annotation/MasksList.tsx`

**Interfaces:**
- Consumes: `PATCH /annotation/annotations/{annotation_id}/mask-postprocess` (Task 5), `AnnotationRead.mask_postprocess_strength: float | null` (Task 4).
- Produces: `useReapplyMaskPostprocess(frameId: number)` mutation hook — `mutate({ annotationId: number, strength: number })`. `<MaskSmoothingControl annotationId={number} initialStrength={number | null} frameId={number} />` component — used by `MasksList.tsx`.

- [ ] **Step 1: Write the failing `useMaskPostprocess` test**

```typescript
// frontend/src/entities/useMaskPostprocess.test.tsx
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { apiClient } from "../shared/api/client";
import { useReapplyMaskPostprocess } from "./useMaskPostprocess";

vi.mock("../shared/api/client", () => ({
  apiClient: { GET: vi.fn(), POST: vi.fn(), PATCH: vi.fn(), DELETE: vi.fn() },
}));

function wrapper({ children }: { children: ReactNode }) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}

describe("useReapplyMaskPostprocess", () => {
  afterEach(() => vi.clearAllMocks());

  it("PATCHes the given annotation's strength and invalidates the frame's annotations query", async () => {
    vi.mocked(apiClient.PATCH).mockResolvedValue({
      data: { id: 5, mask_postprocess_strength: 0.6 },
      error: undefined,
    } as never);

    const { result } = renderHook(() => useReapplyMaskPostprocess(42), { wrapper });
    result.current.mutate({ annotationId: 5, strength: 0.6 });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(apiClient.PATCH).toHaveBeenCalledWith("/annotation/annotations/{annotation_id}/mask-postprocess", {
      params: { path: { annotation_id: 5 } },
      body: { strength: 0.6 },
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npm run test -- useMaskPostprocess.test.tsx`
Expected: FAIL with a module-not-found error.

- [ ] **Step 3: Write `useMaskPostprocess.ts`**

```typescript
import { useMutation, useQueryClient } from "@tanstack/react-query";

import { apiClient } from "../shared/api/client";

export function useReapplyMaskPostprocess(frameId: number) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ annotationId, strength }: { annotationId: number; strength: number }) => {
      const result = await apiClient.PATCH("/annotation/annotations/{annotation_id}/mask-postprocess", {
        params: { path: { annotation_id: annotationId } },
        body: { strength },
      });
      if (result.error) throw result.error;
      return result.data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["annotations", frameId] });
    },
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd frontend && npm run test -- useMaskPostprocess.test.tsx`
Expected: PASS

- [ ] **Step 5: Write the failing `MaskSmoothingControl` test**

```typescript
// frontend/src/features/annotation/MaskSmoothingControl.test.tsx
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";

import { apiClient } from "../../shared/api/client";
import { MaskSmoothingControl } from "./MaskSmoothingControl";

vi.mock("../../shared/api/client", () => ({
  apiClient: { GET: vi.fn(), POST: vi.fn(), PATCH: vi.fn(), DELETE: vi.fn() },
}));

function renderControl(initialStrength: number | null = 0.3) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <MaskSmoothingControl annotationId={7} initialStrength={initialStrength} frameId={1} />
    </QueryClientProvider>,
  );
}

describe("MaskSmoothingControl", () => {
  it("pre-fills from initialStrength", () => {
    renderControl(0.6);
    expect(screen.getByLabelText(/smoothing/i)).toHaveValue("0.6");
  });

  it("falls back to 0 when initialStrength is null", () => {
    renderControl(null);
    expect(screen.getByLabelText(/smoothing/i)).toHaveValue("0");
  });

  it("PATCHes the new strength after the user stops dragging (debounced)", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.mocked(apiClient.PATCH).mockResolvedValue({
      data: { id: 7, mask_postprocess_strength: 0.9 },
      error: undefined,
    } as never);

    renderControl(0.3);
    const slider = screen.getByLabelText(/smoothing/i);
    fireEvent.change(slider, { target: { value: "0.9" } });

    expect(apiClient.PATCH).not.toHaveBeenCalled();

    vi.advanceTimersByTime(300);

    await waitFor(() =>
      expect(apiClient.PATCH).toHaveBeenCalledWith(
        "/annotation/annotations/{annotation_id}/mask-postprocess",
        { params: { path: { annotation_id: 7 } }, body: { strength: 0.9 } },
      ),
    );
    vi.useRealTimers();
  });
});
```

- [ ] **Step 6: Run test to verify it fails**

Run: `cd frontend && npm run test -- MaskSmoothingControl.test.tsx`
Expected: FAIL with a module-not-found error.

- [ ] **Step 7: Write `MaskSmoothingControl.tsx`**

```typescript
import { useEffect, useRef, useState } from "react";

import { useReapplyMaskPostprocess } from "../../entities/useMaskPostprocess";

interface MaskSmoothingControlProps {
  annotationId: number;
  initialStrength: number | null;
  frameId: number;
}

const DEBOUNCE_MS = 300;

export function MaskSmoothingControl({ annotationId, initialStrength, frameId }: MaskSmoothingControlProps) {
  const [strength, setStrength] = useState(initialStrength ?? 0);
  const reapply = useReapplyMaskPostprocess(frameId);
  const debounceTimer = useRef<number | null>(null);

  // Only re-seed from a genuinely new prop value (e.g. after this
  // control's own mutation invalidates the annotations query and the
  // server echoes back the strength this component just set) -- not on
  // every parent re-render, which would otherwise fight the user's
  // in-progress drag.
  const lastSeenInitial = useRef(initialStrength);
  useEffect(() => {
    if (initialStrength !== lastSeenInitial.current) {
      lastSeenInitial.current = initialStrength;
      setStrength(initialStrength ?? 0);
    }
  }, [initialStrength]);

  useEffect(() => {
    return () => {
      if (debounceTimer.current !== null) window.clearTimeout(debounceTimer.current);
    };
  }, []);

  function handleChange(value: number) {
    setStrength(value);
    if (debounceTimer.current !== null) window.clearTimeout(debounceTimer.current);
    debounceTimer.current = window.setTimeout(() => {
      reapply.mutate({ annotationId, strength: value });
    }, DEBOUNCE_MS);
  }

  return (
    <label className="flex items-center gap-1 text-[11px] text-gray-500" aria-label="Smoothing">
      <input
        type="range"
        min={0}
        max={1}
        step={0.01}
        value={strength}
        aria-label="Smoothing"
        onChange={(event) => handleChange(Number(event.target.value))}
        onClick={(event) => event.stopPropagation()}
        className="w-16"
      />
    </label>
  );
}
```

(`onClick` stops propagation because `MasksList.tsx`'s row `<button>` wraps sibling controls in a flex row where the checkbox/delete buttons are already separate elements outside the button — but this slider will sit as its own sibling `<li>` child too, per Step 9 below, so `stopPropagation` here is a defensive no-op consistent with how the existing checkbox/delete buttons are already structured as siblings of the select `<button>`, not nested inside it. Keep it for safety since a future layout tweak could nest it.)

- [ ] **Step 8: Run test to verify it passes**

Run: `cd frontend && npm run test -- MaskSmoothingControl.test.tsx`
Expected: PASS (all 3 cases)

- [ ] **Step 9: Wire it into `MasksList.tsx`**

```typescript
import { MaskSmoothingControl } from "./MaskSmoothingControl";

// ... inside the existing <li> per-annotation row, after the label <button>
// and before the "delete all from this run" button:

            <MaskSmoothingControl
              annotationId={annotation.id}
              initialStrength={annotation.mask_postprocess_strength ?? null}
              frameId={frameId}
            />
```

Full context of the edit — the `<li>` block becomes:

```typescript
          <li key={annotation.id} className="flex items-center gap-1">
            <input
              type="checkbox"
              aria-label="Toggle visibility"
              title="Show/hide this mask on the frame"
              checked={!hiddenAnnotationIds.has(annotation.id)}
              onChange={() => toggleAnnotationVisibility(annotation.id)}
              className="shrink-0"
            />
            <button
              type="button"
              onClick={() => handleSelect(annotation)}
              onMouseEnter={() => setHoveredAnnotation(annotation.id)}
              onMouseLeave={() => setHoveredAnnotation(null)}
              className={`flex flex-1 items-center gap-2 rounded px-2 py-1 text-left hover:bg-gray-800 ${
                annotation.id === selectedAnnotationId ? "bg-gray-800" : ""
              }`}
            >
              <span
                className="h-3 w-3 rounded-full"
                style={{ backgroundColor: resolved?.tag.color ?? "#666" }}
              />
              {categoryName && tagName ? `${categoryName} / ${tagName}` : `label ${annotation.label_id}`}
            </button>
            <MaskSmoothingControl
              annotationId={annotation.id}
              initialStrength={annotation.mask_postprocess_strength ?? null}
              frameId={frameId}
            />
            {annotation.job_id !== null && (
              <button
                type="button"
                aria-label={isPendingBulk ? "Confirm delete all" : "Delete all from this run"}
                title={isPendingBulk ? "Click again to confirm" : "Delete this mask on every tracked frame"}
                onClick={() => handleBulkDeleteClick(annotation.job_id as number)}
                className={`shrink-0 rounded px-1.5 py-0.5 text-xs ${
                  isPendingBulk ? "bg-red-700 text-white" : "text-gray-500 hover:text-red-400"
                }`}
              >
                {isPendingBulk ? "Confirm all" : "🗑️"}
              </button>
            )}
            <button
              type="button"
              aria-label={isPendingDelete ? "Confirm delete mask" : "Delete mask"}
              title={isPendingDelete ? "Click again to confirm" : "Delete this mask on this frame only"}
              onClick={() => handleDeleteClick(annotation.id)}
              className={`shrink-0 rounded px-1.5 py-0.5 text-xs ${
                isPendingDelete ? "bg-red-700 text-white" : "text-gray-500 hover:text-red-400"
              }`}
            >
              {isPendingDelete ? "Confirm" : "✕"}
            </button>
          </li>
```

- [ ] **Step 10: Manual verification — no existing automated test covers `MasksList.tsx` today**

Confirm no `MasksList.test.tsx` exists (checked during planning — it doesn't), so this integration point has no automated regression coverage to run here. Run the full frontend suite to confirm nothing else broke:

Run: `cd frontend && npm run test`
Expected: PASS (all suites)

- [ ] **Step 11: Commit**

```bash
cd frontend
git add src/entities/useMaskPostprocess.ts src/entities/useMaskPostprocess.test.tsx
git add src/features/annotation/MaskSmoothingControl.tsx src/features/annotation/MaskSmoothingControl.test.tsx
git add src/features/annotation/MasksList.tsx
git commit -m "feat: add per-mask smoothing slider to Masks on this frame"
```

---

## Task 9: End-to-end real-browser verification

Per `CLAUDE.md`'s testing philosophy ("driving a real browser against the real running stack" catches what `TestClient` and mocked frontend unit tests cannot), this task is not a unit test — it's a manual pass through the real running stack.

**Files:** none (verification only).

- [ ] **Step 1: Start the full stack**

```bash
docker compose up -d
cd backend && uv run uvicorn app.main:app --reload &
cd backend && uv run celery -A app.worker.celery_app worker --loglevel=info -Q video_transcode &
cd frontend && npm run dev &
```

Confirm the `ml-worker` container (GPU) is also running via `docker compose ps`.

- [ ] **Step 2: Run a real SAM2 Predict and confirm default post-processing applied**

In the browser: open the frame editor on a sequence with a real endoscopy frame, place a point/box prompt, trigger Predict. Wait for the job to reach `succeeded` (frontend already polls `GET /jobs/{id}` every 1.5s). Confirm the resulting mask's edges look smoother than an unprocessed SAM2 mask would (compare against `git log`/screenshots from before this feature if available, or by eye — no stray speckles, no visible pinholes).

- [ ] **Step 3: Confirm the per-mask slider re-applies live**

In "Masks on this frame", drag that mask's own smoothing slider to 0 and confirm the preview reverts to the raw, more-jagged SAM2 output (may need to wait ~300ms debounce + a moment for the PATCH + query invalidation). Drag it back up and confirm cleanup re-appears.

- [ ] **Step 4: Confirm the ToolsPanel slider affects the next Predict, not existing masks**

Move the ToolsPanel's "Mask smoothing" slider to a different value, run another Predict, and confirm the *new* mask's initial per-mask slider value (in Masks on this frame) matches what ToolsPanel was set to at request time — while the *previous* mask's slider is untouched.

- [ ] **Step 5: Confirm the Settings page round-trips**

Log in as an admin user (see `manualcheck@example.com` in project memory, or register a fresh admin), navigate to `/settings`, confirm "Default mask smoothing strength" shows `0.3` (or whatever the current DB value is), change it, save, reload the page, and confirm the new value persisted. Confirm a non-admin sees the same read-only value but gets a 403-surfaced error on Save (existing pattern, unchanged by this feature — just confirm it still applies to the new field too since both fields submit together).

- [ ] **Step 6: Confirm SAM3 is untouched**

If SAM3 is reachable in this environment (may not be, per `ROADMAP.md`'s hardware constraint), confirm a SAM3 predict/track still works exactly as before and that its resulting annotations show no smoothing slider in `MasksList` (since `mask_postprocess_strength` will be `null` for them — verify `MaskSmoothingControl` still renders sensibly at `initialStrength=null`, defaulting to 0, rather than crashing).

- [ ] **Step 7: Report findings**

If everything above works, this task is done — no commit needed (verification only). If anything breaks, return to the relevant earlier task, fix it with a proper failing-test-first cycle, and re-run this verification pass before considering the plan complete.

---

## Self-Review Notes

**Spec coverage:** every section of `docs/superpowers/specs/2026-08-11-mask-postprocessing-design.md` maps to a task — the algorithm (Task 1), `raw_mask_storage_key` (Task 2), `platform_settings` field (Task 3), default-apply-on-job-success (Task 4), per-mask endpoint (Task 5), ml-worker's `tasks.py` change (Task 6), frontend `ToolsPanel`/`FrameEditor`/`SettingsPage` (Task 7), frontend `MasksList` (Task 8), and the CLAUDE.md-mandated real-browser pass (Task 9). Two additions not explicit in the spec text were folded in where the spec's own logic required them: `AnnotationRead` needed a new `mask_postprocess_strength` field since the spec relies on `annotation.payload.mask_postprocess_strength` being visible to the frontend, but `payload` itself was never exposed on that schema (Task 4); and ml-worker's `app/models.py` needed the same column as backend's model, since it's a separate duplicate SQLAlchemy mapping onto the same table, not a shared import (Task 6).

**Placeholder scan:** no "TBD"/"implement later" strings; every code step has complete code, not a description. The one narrative aside (Task 9, "compare against screenshots if available") is explicitly framed as an either/or with a concrete fallback ("or by eye"), not a deferred decision.

**Type consistency:** `postprocess_mask(mask: np.ndarray, strength: float) -> np.ndarray` (Task 1) is called identically in Task 4's `apply_default_postprocess_for_job` and Task 5's `reapply_mask_postprocess`. `Annotation.raw_mask_storage_key: str | None` (Task 2) is read the same way in Tasks 4, 5, and mirrored in Task 6's separate ml-worker model. `FrameEditorState.maskSmoothingStrength: number` (Task 7) is the exact field name read in Task 7's own `FrameEditor.tsx` payload-building — Task 8 doesn't touch the store at all (per-mask state lives in local component state inside `MaskSmoothingControl`, not the shared Zustand store), which is intentional: the two sliders are independent by design (ToolsPanel's slider is a request-time default, not bound to any specific mask).
