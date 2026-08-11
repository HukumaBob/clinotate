# Settings Page Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an admin-only Settings page exposing a single, database-backed
`max_track_range_frames` value (default 10) that replaces the hardcoded
`MAX_TRACK_RANGE_FRAMES = 20` / `MAX_COMBINED_TRACK_RANGE = 20` constants
currently gating SAM2 tracking requests, so the safe range can be tuned
without a redeploy while the GPU crash's root cause remains open.

**Architecture:** New backend `settings` module (model, schema, service,
router) exposing `GET /settings` (any authenticated user) and
`PATCH /settings` (admin only, 403 otherwise) over a singleton
`platform_settings` row. `Sam2TrackRequest`'s Pydantic validator — which
cannot reach a DB session — is replaced by a plain-Python range check in
`jobs/service.py`'s `enqueue_sam2_track`, which already receives a
`Session`. On the frontend, a new `entities/useSettings.ts` hook
(`useSettings` query + `useUpdateSettings` mutation) backs both a new
`/settings` route (gear icon in `AppHeader`, visible only to
`role === "admin"`) and `TrackControls`/`FrameEditor`, which stop reading
the hardcoded `MAX_COMBINED_TRACK_RANGE` constant.

**Tech Stack:** FastAPI + Pydantic v2 + SQLAlchemy + Alembic (backend),
React + TanStack Query + Zustand (frontend). See
`docs/superpowers/specs/2026-08-11-settings-page-design.md` for the full
design rationale.

## Global Constraints

- Language: English only in code, comments, docstrings, UI copy — no
  Russian in committed content (per `CLAUDE.md`).
- TDD: every task below writes a failing test before the implementation.
- `taxonomy_version` / storage rules from `CLAUDE.md` are not touched by
  this plan.
- API contract: the frontend TypeScript client is generated from
  `openapi.json` — after any backend schema/route change, regenerate it
  with `cd backend && PYTHONPATH=. uv run python scripts/export_openapi.py`
  and verify with `git diff --stat openapi.json` before starting frontend
  tasks that depend on the new types.
- Default value: `max_track_range_frames` defaults to **10**, not 20 — see
  `project_sam2_vram_crash_open_issue` memory: 20 has hard-rebooted the
  dev host even with every other software mitigation applied.
- `npm run test`/`build` auto-run `generate-api` first — don't hand-edit
  `frontend/src/shared/api/generated/`.

---

### Task 1: `platform_settings` table + migration

**Files:**
- Create: `backend/app/settings/__init__.py` (empty)
- Create: `backend/app/settings/models.py`
- Create: `backend/alembic/versions/<new>_add_platform_settings.py`
- Test: `backend/tests/test_settings_model.py`

**Interfaces:**
- Produces: `PlatformSettings` SQLAlchemy model, `__tablename__ =
  "platform_settings"`, columns `id: Mapped[int]` (primary key),
  `max_track_range_frames: Mapped[int]` (default `10`).

- [ ] **Step 1: Write the failing test**

Create `backend/tests/test_settings_model.py`:

```python
def test_platform_settings_model_has_default_max_track_range_frames():
    from app.settings.models import PlatformSettings

    row = PlatformSettings()
    assert row.max_track_range_frames == 10
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd backend && uv run pytest tests/test_settings_model.py -v
```
Expected: FAIL — `app.settings` module does not exist yet.

- [ ] **Step 3: Write minimal implementation**

Create `backend/app/settings/__init__.py` (empty file).

Create `backend/app/settings/models.py`:

```python
from sqlalchemy import Integer
from sqlalchemy.orm import Mapped, mapped_column

from app.db import Base


class PlatformSettings(Base):
    __tablename__ = "platform_settings"

    id: Mapped[int] = mapped_column(primary_key=True)
    # See docs/superpowers/specs/2026-08-11-settings-page-design.md: this
    # is a singleton table -- the app only ever reads/writes id=1. 10 is a
    # conservative starting cap while the SAM2 GPU-OOM host-crash root
    # cause remains open (see project_sam2_vram_crash_open_issue memory);
    # the previous hardcoded 20 has reproducibly hard-rebooted the dev
    # host even with every other software mitigation applied.
    max_track_range_frames: Mapped[int] = mapped_column(Integer, default=10)
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cd backend && uv run pytest tests/test_settings_model.py -v
```
Expected: PASS.

- [ ] **Step 5: Generate the Alembic migration**

```bash
cd backend && uv run alembic revision --autogenerate -m "add platform_settings table"
```

This creates a new file in `backend/alembic/versions/`. Open it and
confirm `upgrade()` contains an `op.create_table('platform_settings', ...)`
call with `id` and `max_track_range_frames` columns. Then edit the
generated file's `upgrade()` to also seed the singleton row, adding this
line at the end of `upgrade()` (after the `create_table` call):

```python
    op.execute("INSERT INTO platform_settings (id, max_track_range_frames) VALUES (1, 10)")
```

And add the matching cleanup at the top of `downgrade()`, before the
`drop_table` call:

```python
    op.execute("DELETE FROM platform_settings WHERE id = 1")
```

- [ ] **Step 6: Run the migration against the dev database**

```bash
cd backend && uv run alembic upgrade head
```
Expected: migration applies without error.

Verify the seed row exists:
```bash
docker exec endoscopy-platform-postgres-1 psql -U endoscopy -d endoscopy -c "select * from platform_settings;"
```
Expected: one row, `id=1`, `max_track_range_frames=10`.

- [ ] **Step 7: Run the migration against the test database**

```bash
cd backend && DATABASE_URL_OVERRIDE=endoscopy_test uv run alembic upgrade head 2>&1 || true
```

If that env var isn't wired up in this codebase (check
`backend/app/config.py` for how `database_url` is resolved before running
this), instead run:
```bash
docker exec endoscopy-platform-postgres-1 psql -U endoscopy -d endoscopy_test -c "select 1;" && \
cd backend && uv run python -c "
from app.db import Base
from sqlalchemy import create_engine
from app.config import get_settings
url = get_settings().database_url.rsplit('/', 1)[0] + '/endoscopy_test'
engine = create_engine(url)
Base.metadata.create_all(engine)
print('done')
"
```
This ensures `test_engine`'s `Base.metadata.create_all(engine)` (in
`backend/tests/conftest.py`) picks up the new table — that fixture
doesn't run Alembic, it creates tables directly from the SQLAlchemy
metadata, so no separate migration step is actually required for tests to
pass; this step is a sanity check, not a hard requirement.

- [ ] **Step 8: Commit**

```bash
git add backend/app/settings/__init__.py backend/app/settings/models.py \
        backend/alembic/versions/*_add_platform_settings.py \
        backend/tests/test_settings_model.py
git commit -m "feat: add platform_settings singleton table

Backs the new admin-controlled max_track_range_frames setting -- see
docs/superpowers/specs/2026-08-11-settings-page-design.md."
```

---

### Task 2: Settings service + schemas + router

**Files:**
- Create: `backend/app/settings/schemas.py`
- Create: `backend/app/settings/service.py`
- Create: `backend/app/settings/router.py`
- Modify: `backend/app/main.py`
- Test: `backend/tests/test_settings.py`

**Interfaces:**
- Consumes: `PlatformSettings` model from Task 1.
- Produces:
  - `SettingsRead` Pydantic model: `{ max_track_range_frames: int }`.
  - `SettingsUpdate` Pydantic model: `{ max_track_range_frames: int }`
    with `Field(ge=1)`.
  - `get_settings(session: Session) -> PlatformSettings` — fetches (never
    creates) the `id=1` row.
  - `update_settings(session: Session, max_track_range_frames: int, user:
    User) -> PlatformSettings` — raises `HTTPException(403)` if
    `user.role != UserRole.ADMIN`, otherwise updates and returns the row.
  - `GET /settings` and `PATCH /settings` routes, registered in
    `main.py`.

- [ ] **Step 1: Write the failing tests**

Create `backend/tests/test_settings.py`:

```python
from fastapi.testclient import TestClient

from app.main import app

client = TestClient(app)


def _register_and_login(email: str, role: str = "annotator") -> str:
    client.post("/auth/register", json={"email": email, "password": "pass1234", "role": role})
    response = client.post("/auth/login", json={"email": email, "password": "pass1234"})
    return response.json()["access_token"]


def _headers(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


def test_get_settings_requires_auth():
    response = client.get("/settings")
    assert response.status_code == 401


def test_get_settings_returns_current_value_for_any_authenticated_role():
    token = _register_and_login("settings-get1@example.com", role="annotator")
    response = client.get("/settings", headers=_headers(token))
    assert response.status_code == 200
    assert "max_track_range_frames" in response.json()


def test_patch_settings_requires_auth():
    response = client.patch("/settings", json={"max_track_range_frames": 5})
    assert response.status_code == 401


def test_patch_settings_rejects_non_admin():
    token = _register_and_login("settings-patch1@example.com", role="annotator")
    response = client.patch("/settings", json={"max_track_range_frames": 5}, headers=_headers(token))
    assert response.status_code == 403


def test_patch_settings_allows_admin_and_persists_value():
    token = _register_and_login("settings-patch2@example.com", role="admin")
    response = client.patch("/settings", json={"max_track_range_frames": 8}, headers=_headers(token))
    assert response.status_code == 200
    assert response.json()["max_track_range_frames"] == 8

    get_response = client.get("/settings", headers=_headers(token))
    assert get_response.json()["max_track_range_frames"] == 8

    # Restore the seeded default so later tests (and manual runs) aren't
    # affected by this test's side effect on the singleton row.
    client.patch("/settings", json={"max_track_range_frames": 10}, headers=_headers(token))


def test_patch_settings_rejects_value_below_one():
    token = _register_and_login("settings-patch3@example.com", role="admin")
    response = client.patch("/settings", json={"max_track_range_frames": 0}, headers=_headers(token))
    assert response.status_code == 422
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd backend && uv run pytest tests/test_settings.py -v
```
Expected: FAIL — no `/settings` routes exist yet (404s, not the asserted
status codes).

- [ ] **Step 3: Write the schemas**

Create `backend/app/settings/schemas.py`:

```python
from pydantic import BaseModel, ConfigDict, Field


class SettingsRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    max_track_range_frames: int


class SettingsUpdate(BaseModel):
    max_track_range_frames: int = Field(ge=1)
```

- [ ] **Step 4: Write the service**

Create `backend/app/settings/service.py`:

```python
from fastapi import HTTPException, status
from sqlalchemy.orm import Session

from app.auth.models import User, UserRole
from app.settings.models import PlatformSettings

SETTINGS_ROW_ID = 1


def get_settings(session: Session) -> PlatformSettings:
    settings_row = session.get(PlatformSettings, SETTINGS_ROW_ID)
    if settings_row is None:
        raise RuntimeError(
            "platform_settings row (id=1) is missing -- the seed migration "
            "should have created it, see "
            "docs/superpowers/plans/2026-08-11-settings-page.md Task 1"
        )
    return settings_row


def require_admin(user: User) -> None:
    if user.role != UserRole.ADMIN:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Admin role required")


def update_settings(session: Session, max_track_range_frames: int, user: User) -> PlatformSettings:
    require_admin(user)
    settings_row = get_settings(session)
    settings_row.max_track_range_frames = max_track_range_frames
    session.commit()
    session.refresh(settings_row)
    return settings_row
```

- [ ] **Step 5: Write the router**

Create `backend/app/settings/router.py`:

```python
from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from app.auth.dependencies import get_current_user
from app.auth.models import User
from app.db import get_session
from app.settings.schemas import SettingsRead, SettingsUpdate
from app.settings.service import get_settings, update_settings

router = APIRouter(prefix="/settings", tags=["settings"], dependencies=[Depends(get_current_user)])


@router.get("", response_model=SettingsRead)
def read_settings(session: Session = Depends(get_session)) -> SettingsRead:
    return get_settings(session)


@router.patch("", response_model=SettingsRead)
def patch_settings(
    payload: SettingsUpdate,
    current_user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
) -> SettingsRead:
    return update_settings(session, payload.max_track_range_frames, current_user)
```

- [ ] **Step 6: Register the router**

Edit `backend/app/main.py`:

```python
from app.annotation.router import router as annotation_router
from app.auth.router import router as auth_router
from app.jobs.router import router as jobs_router
from app.media.router import router as media_router
from app.settings.router import router as settings_router
from app.taxonomy.router import router as taxonomy_router
```

And add, after `app.include_router(jobs_router)`:
```python
app.include_router(settings_router)
```

- [ ] **Step 7: Run tests to verify they pass**

```bash
cd backend && uv run pytest tests/test_settings.py -v
```
Expected: PASS (all 6 tests).

- [ ] **Step 8: Run the full backend test suite to check for regressions**

```bash
cd backend && uv run pytest -q
```
Expected: all previously-passing tests still pass.

- [ ] **Step 9: Regenerate the OpenAPI schema**

```bash
cd backend && PYTHONPATH=. uv run python scripts/export_openapi.py
git diff --stat openapi.json
```
Confirm `openapi.json` shows a diff (new `/settings` paths and
`SettingsRead`/`SettingsUpdate` schemas should appear).

- [ ] **Step 10: Commit**

```bash
git add backend/app/settings/schemas.py backend/app/settings/service.py \
        backend/app/settings/router.py backend/app/main.py \
        backend/tests/test_settings.py openapi.json
git commit -m "feat: add GET/PATCH /settings endpoints

GET is available to any authenticated user (TrackControls needs to read
it regardless of role); PATCH requires admin, mirroring the existing
require_reviewer_or_admin pattern in app/annotation/service.py."
```

---

### Task 3: `Sam2TrackRequest` reads the live setting instead of a hardcoded constant

**Files:**
- Modify: `backend/app/jobs/schemas.py`
- Modify: `backend/app/jobs/service.py`
- Modify: `backend/app/jobs/router.py`
- Test: `backend/tests/test_jobs.py`

**Interfaces:**
- Consumes: `get_settings(session)` from Task 2's
  `app.settings.service`.
- Produces: `enqueue_sam2_track` now raises
  `HTTPException(422)` when `backward + forward` exceeds the live
  `max_track_range_frames` value, instead of that check living in
  `Sam2TrackRequest`'s Pydantic validator (which has no DB session
  available and so cannot read a live value).

This task **removes** `MAX_TRACK_RANGE_FRAMES` and
`_validate_combined_range` from `Sam2TrackRequest` entirely — the range
check moves to `enqueue_sam2_track`, which already receives a `Session`.
`Sam2TrackRequest` keeps only its structural validation
(`backward`/`forward` `Field(ge=0)`).

- [ ] **Step 1: Update the two obsolete tests and add new ones**

In `backend/tests/test_jobs.py`, **delete** these two tests (they test
Pydantic-level enforcement of a fixed 20-frame cap that no longer exists
at that layer):
- `test_sam2_track_request_rejects_combined_range_over_twenty`
- `test_sam2_track_request_accepts_combined_range_at_twenty`

Keep `test_sam2_track_request_rejects_negative_backward` as-is (that's
still enforced by `Field(ge=0)`, unchanged).

Add these new tests to `backend/tests/test_jobs.py` (near the existing
`enqueue_sam2_track`-related tests -- search the file for
`enqueue_sam2_track_stores_anchor_and_direction_in_payload` to find that
neighborhood):

```python
def test_enqueue_sam2_track_rejects_combined_range_over_live_setting():
    from app.db import SessionLocal
    from app.settings.models import PlatformSettings

    token = _register_and_login("jobs-range1@example.com")
    headers = _auth_headers(token)

    session = SessionLocal()
    settings_row = session.get(PlatformSettings, 1)
    original_value = settings_row.max_track_range_frames
    settings_row.max_track_range_frames = 10
    session.commit()
    session.close()

    response = client.post(
        "/jobs/sam2/track",
        json={
            "sequence_id": 1,
            "label_id": 1,
            "prompts": [{"type": "point", "coords": [0.5, 0.5], "label": True}],
            "anchor_frame_id": 10,
            "backward": 6,
            "forward": 6,
        },
        headers=headers,
    )
    assert response.status_code == 422

    session = SessionLocal()
    settings_row = session.get(PlatformSettings, 1)
    settings_row.max_track_range_frames = original_value
    session.commit()
    session.close()


def test_enqueue_sam2_track_accepts_combined_range_at_live_setting():
    from app.db import SessionLocal
    from app.settings.models import PlatformSettings
    from unittest.mock import patch

    token = _register_and_login("jobs-range2@example.com")
    headers = _auth_headers(token)

    session = SessionLocal()
    settings_row = session.get(PlatformSettings, 1)
    original_value = settings_row.max_track_range_frames
    settings_row.max_track_range_frames = 10
    session.commit()
    session.close()

    with patch("app.jobs.service.celery_app.send_task"):
        response = client.post(
            "/jobs/sam2/track",
            json={
                "sequence_id": 1,
                "label_id": 1,
                "prompts": [{"type": "point", "coords": [0.5, 0.5], "label": True}],
                "anchor_frame_id": 10,
                "backward": 5,
                "forward": 5,
            },
            headers=headers,
        )
    assert response.status_code == 201

    session = SessionLocal()
    settings_row = session.get(PlatformSettings, 1)
    settings_row.max_track_range_frames = original_value
    session.commit()
    session.close()
```

Check the top of `backend/tests/test_jobs.py` for how `_register_and_login`
handles the `label_id`/`sequence_id` foreign keys in other
`enqueue_sam2_track`-related tests already in the file (search for
`test_enqueue_sam2_track_stores_anchor_and_direction_in_payload`) — if
those existing tests set up a real `Label`/`Sequence` row first rather
than using bare integers, follow that same setup pattern in the two new
tests above instead of the placeholder `sequence_id: 1, label_id: 1`
shown here, so the request doesn't fail earlier for an unrelated
"label not found" reason.

- [ ] **Step 2: Run tests to verify the new ones fail**

```bash
cd backend && uv run pytest tests/test_jobs.py -k "combined_range or negative_backward" -v
```
Expected: the two new tests FAIL (`enqueue_sam2_track` doesn't check the
live setting yet — the deleted Pydantic validator is gone, so
over-limit requests currently succeed with a 201). The negative-backward
test still passes (untouched `Field(ge=0)`).

- [ ] **Step 3: Remove the Pydantic-level check**

Edit `backend/app/jobs/schemas.py` — remove the `MAX_TRACK_RANGE_FRAMES`
constant, its comment block, and the `_validate_combined_range` method
from `Sam2TrackRequest`, leaving:

```python
class Sam2TrackRequest(BaseModel):
    sequence_id: int
    label_id: int
    prompts: list[PromptIn]
    anchor_frame_id: int
    backward: int = Field(ge=0)
    forward: int = Field(ge=0)
```

(No `model_validator` import cleanup needed if `PromptIn` still uses
`model_validator` for `_validate_mask_png` above it in the same file —
check before removing the import.)

- [ ] **Step 4: Add the live check in the service layer**

Edit `backend/app/jobs/service.py`. Add the import at the top:

```python
from fastapi import HTTPException, status

from app.settings.service import get_settings
```

Edit `enqueue_sam2_track` (found via the `def enqueue_sam2_track(` line)
to check the combined range immediately after `_require_label`:

```python
def enqueue_sam2_track(
    session: Session,
    sequence_id: int,
    label_id: int,
    prompts: list[dict],
    anchor_frame_id: int,
    backward: int,
    forward: int,
    created_by: User,
) -> Job:
    _require_label(session, label_id)

    max_range = get_settings(session).max_track_range_frames
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
        },
        created_by_id=created_by.id,
    )
    session.add(job)
    session.commit()
    session.refresh(job)

    celery_app.send_task("sam2_track", args=[job.id])
    return job
```

Check the exact status code constant name already used elsewhere in this
file/codebase for 422 (`test_jobs.py`'s existing assertions used a bare
`422` int in Step 1 above, which matches either
`status.HTTP_422_UNPROCESSABLE_ENTITY` or the newer
`HTTP_422_UNPROCESSABLE_CONTENT` alias seen in this codebase's FastAPI
version per `CLAUDE.md`'s testing-philosophy notes on the
`StarletteDeprecationWarning` — use whichever one `import status` already
resolves to a valid attribute for; try `HTTP_422_UNPROCESSABLE_CONTENT`
first and fall back to `HTTP_422_UNPROCESSABLE_ENTITY` if that attribute
doesn't exist in this FastAPI version).

- [ ] **Step 5: Check whether `HTTPException` inside `enqueue_sam2_track` propagates correctly through the router**

`backend/app/jobs/router.py`'s `create_sam2_track_job` calls
`enqueue_sam2_track` directly and returns its result — since
`enqueue_sam2_track` now raises `HTTPException` itself (FastAPI handles
this automatically when raised anywhere in the request-handling call
stack, not just directly in a route function), no changes to
`router.py` are needed. Confirm this by reading
`backend/app/jobs/router.py`'s `create_sam2_track_job` function and
verifying it has no try/except that would swallow the exception.

- [ ] **Step 6: Run tests to verify they pass**

```bash
cd backend && uv run pytest tests/test_jobs.py -v
```
Expected: PASS (all tests, including the two new ones and the retained
`test_sam2_track_request_rejects_negative_backward`).

- [ ] **Step 7: Run the full backend test suite to check for regressions**

```bash
cd backend && uv run pytest -q
```
Expected: all tests pass.

- [ ] **Step 8: Regenerate the OpenAPI schema**

```bash
cd backend && PYTHONPATH=. uv run python scripts/export_openapi.py
git diff --stat openapi.json
```
Confirm the diff reflects `Sam2TrackRequest`'s simplified schema (the
removed cross-field validation isn't representable in JSON Schema anyway,
so this diff may be small or empty for that model specifically — the
`/settings` paths from Task 2 should already be present from the prior
commit).

- [ ] **Step 9: Commit**

```bash
git add backend/app/jobs/schemas.py backend/app/jobs/service.py \
        backend/tests/test_jobs.py openapi.json
git commit -m "fix: enforce SAM2 track range cap against the live setting

Sam2TrackRequest's Pydantic validator couldn't reach a DB session, so it
enforced a hardcoded 20-frame constant. The check now lives in
enqueue_sam2_track (which already has a Session) and reads
platform_settings.max_track_range_frames live, so lowering the setting
takes effect without a redeploy."
```

---

### Task 4: Frontend `useSettings` hook

**Files:**
- Create: `frontend/src/entities/useSettings.ts`
- Test: `frontend/src/entities/useSettings.test.tsx`

**Interfaces:**
- Consumes: `apiClient.GET("/settings")`, `apiClient.PATCH("/settings",
  ...)` (generated types from Task 2/3's `openapi.json` regeneration —
  run `npm run generate-api` in `frontend/` first if these paths aren't
  yet recognized by TypeScript).
- Produces: `useSettings()` (query, `queryKey: ["settings"]`, returns
  `{ max_track_range_frames: number }`), `useUpdateSettings()` (mutation,
  invalidates `["settings"]` on success).

- [ ] **Step 1: Regenerate the frontend API client**

```bash
cd frontend && npm run generate-api
```
This reads the updated `openapi.json` from Task 2/3 and regenerates
`frontend/src/shared/api/generated/schema.d.ts` (gitignored, not
committed).

- [ ] **Step 2: Write the failing test**

Create `frontend/src/entities/useSettings.test.tsx`:

```tsx
import { afterEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";

import { apiClient } from "../shared/api/client";
import { useSettings, useUpdateSettings } from "./useSettings";

vi.mock("../shared/api/client", () => ({
  apiClient: { GET: vi.fn(), POST: vi.fn(), PATCH: vi.fn(), DELETE: vi.fn() },
}));

function wrapper({ children }: { children: ReactNode }) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}

describe("useSettings", () => {
  afterEach(() => vi.clearAllMocks());

  it("fetches the current max_track_range_frames value", async () => {
    vi.mocked(apiClient.GET).mockResolvedValue({
      data: { max_track_range_frames: 10 },
      error: undefined,
    } as never);

    const { result } = renderHook(() => useSettings(), { wrapper });

    await waitFor(() => expect(result.current.data).toEqual({ max_track_range_frames: 10 }));
    expect(apiClient.GET).toHaveBeenCalledWith("/settings", {});
  });
});

describe("useUpdateSettings", () => {
  afterEach(() => vi.clearAllMocks());

  it("PATCHes the new value and invalidates the settings query", async () => {
    vi.mocked(apiClient.PATCH).mockResolvedValue({
      data: { max_track_range_frames: 8 },
      error: undefined,
    } as never);

    const { result } = renderHook(() => useUpdateSettings(), { wrapper });
    result.current.mutate({ maxTrackRangeFrames: 8 });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(apiClient.PATCH).toHaveBeenCalledWith("/settings", {
      body: { max_track_range_frames: 8 },
    });
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

```bash
cd frontend && npm run test -- useSettings.test.tsx
```
Expected: FAIL — `./useSettings` module does not exist.

- [ ] **Step 4: Write minimal implementation**

Create `frontend/src/entities/useSettings.ts`:

```ts
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
    mutationFn: async ({ maxTrackRangeFrames }: { maxTrackRangeFrames: number }) => {
      const result = await apiClient.PATCH("/settings", {
        body: { max_track_range_frames: maxTrackRangeFrames },
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

- [ ] **Step 5: Run test to verify it passes**

```bash
cd frontend && npm run test -- useSettings.test.tsx
```
Expected: PASS (both tests).

- [ ] **Step 6: Commit**

```bash
git add frontend/src/entities/useSettings.ts frontend/src/entities/useSettings.test.tsx
git commit -m "feat: add useSettings/useUpdateSettings hooks"
```

---

### Task 5: Settings page + admin-only nav icon

**Files:**
- Create: `frontend/src/features/settings/SettingsPage.tsx`
- Create: `frontend/src/features/settings/SettingsPage.test.tsx`
- Modify: `frontend/src/app/AppHeader.tsx`
- Create: `frontend/src/app/AppHeader.test.tsx`
- Modify: `frontend/src/app/App.tsx`

**Interfaces:**
- Consumes: `useSettings`/`useUpdateSettings` from Task 4;
  `useAuth`'s `user.role` (existing, `frontend/src/features/auth/useAuth.ts`).
- Produces: `SettingsPage` component (default export not used —named
  export `SettingsPage`, matching this codebase's existing convention of
  named exports for page components like `MediaPage`,
  `SequenceGridPage`); `/settings` route.

- [ ] **Step 1: Write the failing test for `AppHeader`**

Create `frontend/src/app/AppHeader.test.tsx`:

```tsx
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

import { AppHeader } from "./AppHeader";
import { useAuth } from "../features/auth/useAuth";

vi.mock("../features/auth/useAuth", () => ({
  useAuth: vi.fn(),
}));

function mockAuth(role: "annotator" | "reviewer" | "admin" | null) {
  vi.mocked(useAuth).mockImplementation((selector) =>
    selector({
      token: "t",
      user: role ? { id: 1, email: "u@example.com", role } : null,
      isAuthenticated: true,
      login: vi.fn(),
      logout: vi.fn(),
    } as never)
  );
}

describe("AppHeader settings icon", () => {
  it("shows a Settings link for an admin user", () => {
    mockAuth("admin");
    render(<AppHeader />, { wrapper: MemoryRouter });
    expect(screen.getByRole("link", { name: /settings/i })).toBeInTheDocument();
  });

  it("hides the Settings link for a non-admin user", () => {
    mockAuth("annotator");
    render(<AppHeader />, { wrapper: MemoryRouter });
    expect(screen.queryByRole("link", { name: /settings/i })).not.toBeInTheDocument();
  });
});
```

Check `frontend/src/app/AppHeader.tsx`'s current import of `useAuth` — it
currently calls `useAuth((state) => state.user)` and
`useAuth((state) => state.logout)` as two separate selector calls,
matching Zustand's hook-with-selector pattern; if any other test file in
this codebase already mocks `useAuth` (search `grep -rl "vi.mock.*useAuth"
frontend/src`), follow that existing mock shape instead of the one shown
above if it differs.

- [ ] **Step 2: Run test to verify it fails**

```bash
cd frontend && npm run test -- AppHeader.test.tsx
```
Expected: FAIL — no Settings link exists yet.

- [ ] **Step 3: Write the failing test for `SettingsPage`**

Create `frontend/src/features/settings/SettingsPage.test.tsx`:

```tsx
import { afterEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";

import { apiClient } from "../../shared/api/client";
import { SettingsPage } from "./SettingsPage";

vi.mock("../../shared/api/client", () => ({
  apiClient: { GET: vi.fn(), POST: vi.fn(), PATCH: vi.fn(), DELETE: vi.fn() },
}));

function wrapper({ children }: { children: ReactNode }) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}

describe("SettingsPage", () => {
  afterEach(() => vi.clearAllMocks());

  it("pre-fills the field with the current value from GET /settings", async () => {
    vi.mocked(apiClient.GET).mockResolvedValue({
      data: { max_track_range_frames: 10 },
      error: undefined,
    } as never);

    render(<SettingsPage />, { wrapper });

    await waitFor(() =>
      expect(screen.getByLabelText(/max sam2 tracking range/i)).toHaveValue(10)
    );
  });

  it("submits the edited value via PATCH /settings", async () => {
    vi.mocked(apiClient.GET).mockResolvedValue({
      data: { max_track_range_frames: 10 },
      error: undefined,
    } as never);
    vi.mocked(apiClient.PATCH).mockResolvedValue({
      data: { max_track_range_frames: 8 },
      error: undefined,
    } as never);

    render(<SettingsPage />, { wrapper });

    const input = await screen.findByLabelText(/max sam2 tracking range/i);
    await userEvent.clear(input);
    await userEvent.type(input, "8");
    await userEvent.click(screen.getByRole("button", { name: /save/i }));

    await waitFor(() =>
      expect(apiClient.PATCH).toHaveBeenCalledWith("/settings", {
        body: { max_track_range_frames: 8 },
      })
    );
  });

  it("shows an inline error message when the save fails", async () => {
    vi.mocked(apiClient.GET).mockResolvedValue({
      data: { max_track_range_frames: 10 },
      error: undefined,
    } as never);
    vi.mocked(apiClient.PATCH).mockResolvedValue({
      data: undefined,
      error: { detail: "Admin role required" },
    } as never);

    render(<SettingsPage />, { wrapper });

    await userEvent.click(await screen.findByRole("button", { name: /save/i }));

    await waitFor(() => expect(screen.getByText("Admin role required")).toBeInTheDocument());
  });
});
```

- [ ] **Step 4: Run test to verify it fails**

```bash
cd frontend && npm run test -- SettingsPage.test.tsx
```
Expected: FAIL — `./SettingsPage` module does not exist.

- [ ] **Step 5: Write the `SettingsPage` implementation**

Create `frontend/src/features/settings/SettingsPage.tsx`:

```tsx
import { useEffect, useState } from "react";

import { useSettings, useUpdateSettings } from "../../entities/useSettings";

export function SettingsPage() {
  const settingsQuery = useSettings();
  const updateSettings = useUpdateSettings();
  const [maxTrackRangeFrames, setMaxTrackRangeFrames] = useState<number | "">("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (settingsQuery.data) {
      setMaxTrackRangeFrames(settingsQuery.data.max_track_range_frames);
    }
  }, [settingsQuery.data]);

  function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (maxTrackRangeFrames === "") return;
    setError(null);
    updateSettings.mutate(
      { maxTrackRangeFrames },
      {
        onError: (mutationError: unknown) => {
          const detail =
            (mutationError as { detail?: string } | undefined)?.detail ?? "Save failed";
          setError(detail);
        },
      }
    );
  }

  return (
    <div className="mx-auto max-w-xl p-6 text-gray-100">
      <h1 className="mb-6 text-xl font-semibold">Settings</h1>
      <section className="rounded border border-gray-800 bg-gray-900 p-4">
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
          <button
            type="submit"
            disabled={maxTrackRangeFrames === ""}
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

- [ ] **Step 6: Add the Settings icon to `AppHeader`**

Edit `frontend/src/app/AppHeader.tsx` — add the `Link` to the user info
section, gated on `user.role === "admin"`:

```tsx
      {user && (
        <div className="flex items-center gap-4">
          {user.role === "admin" && (
            <Link
              to="/settings"
              aria-label="Settings"
              className="text-sm font-medium text-gray-300 hover:text-gray-100"
            >
              Settings
            </Link>
          )}
          <span className="text-sm text-gray-400">{user.email}</span>
          <button
            type="button"
            onClick={handleLogout}
            className="rounded border border-gray-700 px-3 py-1 text-sm text-gray-100 hover:bg-gray-800"
          >
            Log out
          </button>
        </div>
      )}
```

(The test asserts `getByRole("link", { name: /settings/i })` — plain text
"Settings" satisfies that; a gear icon/emoji can be added visually later
without changing the accessible name, so this plan uses text for now to
keep the test unambiguous.)

- [ ] **Step 7: Wire the route**

Edit `frontend/src/app/App.tsx`:

```tsx
import { SequenceGridPage } from "../features/annotation/SequenceGridPage";
import { LoginPage } from "../features/auth/LoginPage";
import { useAuth } from "../features/auth/useAuth";
import { MediaPage } from "../features/media/MediaPage";
import { SettingsPage } from "../features/settings/SettingsPage";
import { AppLayout } from "./AppLayout";
```

And add, inside the existing `RequireAuth`-wrapped `<Route>` block, next
to the other child routes:
```tsx
          <Route path="/settings" element={<SettingsPage />} />
```

- [ ] **Step 8: Run tests to verify they pass**

```bash
cd frontend && npm run test -- AppHeader.test.tsx SettingsPage.test.tsx
```
Expected: PASS (all 5 tests across both files).

- [ ] **Step 9: Run the full frontend test suite to check for regressions**

```bash
cd frontend && npm run test -- --run
```
Expected: all tests pass.

- [ ] **Step 10: Commit**

```bash
git add frontend/src/features/settings/SettingsPage.tsx \
        frontend/src/features/settings/SettingsPage.test.tsx \
        frontend/src/app/AppHeader.tsx frontend/src/app/AppHeader.test.tsx \
        frontend/src/app/App.tsx
git commit -m "feat: add admin-only Settings page

Gear-equivalent nav link visible only to role=admin, per
docs/superpowers/specs/2026-08-11-settings-page-design.md."
```

---

### Task 6: `TrackControls`/`FrameEditor` read the live setting

**Files:**
- Modify: `frontend/src/features/annotation/TrackControls.tsx`
- Modify: `frontend/src/features/annotation/TrackControls.test.tsx`
- Modify: `frontend/src/features/annotation/FrameEditor.tsx`

**Interfaces:**
- Consumes: `useSettings()` from Task 4.
- Produces: `TrackControls` no longer exports `MAX_COMBINED_TRACK_RANGE`
  as a hardcoded constant; the combined-range cap is now
  `settingsQuery.data?.max_track_range_frames ?? Infinity` (see Step 3 for
  why `Infinity` and not a fallback constant).

- [ ] **Step 1: Update `TrackControls.test.tsx` to mock the settings query**

Edit `frontend/src/features/annotation/TrackControls.test.tsx` — add the
`apiClient` mock at the top (following the same pattern as
`SettingsPage.test.tsx`) and wrap `renderControls`'s `render(...)` call in
a `QueryClientProvider`, since `TrackControls` will now call `useSettings`
internally:

```tsx
import { render, screen, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";

import { apiClient } from "../../shared/api/client";
import { createFrameEditorStore } from "./frameEditorStore";
import { TrackControls } from "./TrackControls";

vi.mock("../../shared/api/client", () => ({
  apiClient: { GET: vi.fn(), POST: vi.fn(), PATCH: vi.fn(), DELETE: vi.fn() },
}));

function renderControls(overrides: Partial<{ maxBackward: number; maxForward: number }> = {}) {
  vi.mocked(apiClient.GET).mockResolvedValue({
    data: { max_track_range_frames: 20 },
    error: undefined,
  } as never);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const store = createFrameEditorStore();
  const onTrack = vi.fn();
  render(
    <QueryClientProvider client={queryClient}>
      <TrackControls
        store={store}
        onTrack={onTrack}
        maxBackward={overrides.maxBackward ?? 50}
        maxForward={overrides.maxForward ?? 50}
      />
    </QueryClientProvider>
  );
  return { store };
}
```

Every existing test in this file (`clamps 'Max backward' to leave room
under the 20-frame combined cap`, etc.) asserts behavior against a
20-frame cap — the mock above returns `20`, so those existing assertions
stay valid unchanged. Since the settings query is now async, each
existing test needs an `await screen.findByLabelText(...)` (or similar)
before interacting with the controls, to ensure the mocked `20` value has
loaded before the test clicks/types. Check each existing `it(...)` block
in this file and add:
```tsx
    await screen.findByText(/combined backward \+ forward is capped at 20/i);
```
as the first line inside each test body, before its existing assertions,
and mark each test function `async` if not already.

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd frontend && npm run test -- TrackControls.test.tsx
```
Expected: FAIL — `TrackControls` doesn't call `useSettings` yet, so
nothing resolves the awaited text.

- [ ] **Step 3: Update `TrackControls.tsx`**

Edit `frontend/src/features/annotation/TrackControls.tsx`:

```tsx
import { useStore } from "zustand/react";

import { useSettings } from "../../entities/useSettings";
import type { FrameEditorStore } from "./frameEditorStore";

interface TrackControlsProps {
  store: FrameEditorStore;
  onTrack: () => void;
  // Number of frames available in each direction from the current frame
  // within its sequence -- backing the "Max" shortcut buttons below.
  maxBackward: number;
  maxForward: number;
}

export function TrackControls({ store, onTrack, maxBackward, maxForward }: TrackControlsProps) {
  const backward = useStore(store, (state) => state.backward);
  const forward = useStore(store, (state) => state.forward);
  const setBackward = useStore(store, (state) => state.setBackward);
  const setForward = useStore(store, (state) => state.setForward);
  const labelTagId = useStore(store, (state) => state.labelTagId);
  const pendingPrompts = useStore(store, (state) => state.pendingPrompts);
  const trackDisabled = labelTagId === null || pendingPrompts.length === 0;

  const settingsQuery = useSettings();
  // See docs/superpowers/specs/2026-08-11-settings-page-design.md: while
  // the setting is still loading, no combined cap is applied yet (budget
  // clamp skipped) rather than blocking the whole control on a spinner --
  // Track range inputs render immediately using only the per-sequence
  // bounds, and re-clamp once the value arrives.
  const combinedCap = settingsQuery.data?.max_track_range_frames ?? Infinity;

  const backwardBudget = Math.max(0, combinedCap - forward);
  const forwardBudget = Math.max(0, combinedCap - backward);

  return (
    <div className="space-y-2">
      <div className="flex gap-2">
        <label className="flex-1 text-xs text-gray-400">
          Backward
          <div className="mt-1 flex gap-1">
            <input
              type="number"
              min={0}
              max={backwardBudget}
              value={backward}
              onChange={(event) => setBackward(Math.min(Number(event.target.value), backwardBudget))}
              className="w-full rounded border border-gray-700 bg-gray-800 px-2 py-1 text-sm text-gray-100"
            />
            <button
              type="button"
              aria-label="Max backward"
              onClick={() => setBackward(Math.min(maxBackward, backwardBudget))}
              className="shrink-0 rounded border border-gray-700 px-2 py-1 text-xs text-gray-400 hover:bg-gray-800 hover:text-gray-200"
            >
              Max
            </button>
          </div>
        </label>
        <label className="flex-1 text-xs text-gray-400">
          Forward
          <div className="mt-1 flex gap-1">
            <input
              type="number"
              min={0}
              max={forwardBudget}
              value={forward}
              onChange={(event) => setForward(Math.min(Number(event.target.value), forwardBudget))}
              className="w-full rounded border border-gray-700 bg-gray-800 px-2 py-1 text-sm text-gray-100"
            />
            <button
              type="button"
              aria-label="Max forward"
              onClick={() => setForward(Math.min(maxForward, forwardBudget))}
              className="shrink-0 rounded border border-gray-700 px-2 py-1 text-xs text-gray-400 hover:bg-gray-800 hover:text-gray-200"
            >
              Max
            </button>
          </div>
        </label>
      </div>
      {settingsQuery.data && (
        <p className="text-xs text-gray-500">
          Combined backward + forward is capped at {combinedCap} frames to protect GPU memory.
        </p>
      )}
      <button
        type="button"
        disabled={trackDisabled}
        onClick={onTrack}
        className="w-full rounded bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-500 disabled:cursor-not-allowed disabled:opacity-40"
      >
        Track
      </button>
    </div>
  );
}
```

Note the removed `export const MAX_COMBINED_TRACK_RANGE = 20;` — this is
now consumed by `FrameEditor.tsx` too (Step 5 below), so that file's
import of this constant must be updated in the same task, not left
broken.

- [ ] **Step 4: Run `TrackControls` tests to verify they pass**

```bash
cd frontend && npm run test -- TrackControls.test.tsx
```
Expected: PASS (all tests, both pre-existing and any added).

- [ ] **Step 5: Update `FrameEditor.tsx` to use `useSettings` instead of the removed constant**

Edit `frontend/src/features/annotation/FrameEditor.tsx`. Replace:
```tsx
import { MAX_COMBINED_TRACK_RANGE } from "./TrackControls";
```
with:
```tsx
import { useSettings } from "../../entities/useSettings";
```

Find the component's body (near where `maxBackward`/`maxForward` are
computed, per the earlier `grep` output at lines 82-83) and add:
```tsx
  const settingsQuery = useSettings();
```

Then edit the `useEffect` that currently reads:
```tsx
    store.getState().setForward(Math.min(maxForward, MAX_COMBINED_TRACK_RANGE));
```
to:
```tsx
    const combinedCap = settingsQuery.data?.max_track_range_frames ?? maxForward;
    store.getState().setForward(Math.min(maxForward, combinedCap));
```
(When the setting hasn't loaded yet, this falls back to `maxForward`
itself — i.e. no artificial cap is applied before the real value is
known, consistent with Task 6 Step 3's "no cap while loading" choice in
`TrackControls`. Once `settingsQuery.data` arrives this effect does not
automatically re-run to re-clamp an already-set `forward` value, since
`settingsQuery.data` is deliberately excluded from this effect's
dependency array for the same double-fire reason `maxForward` already is
— per the existing comment right below it. This is an accepted, narrow
gap: on first frame load before the settings query resolves, forward may
briefly default above the eventual cap; `TrackControls`'s own budget
clamp will correct it the moment the user next touches either input, and
Task 6 Step 3's `Track` button remains keyed on `trackDisabled`, not on
this default, so no invalid Track request can actually be submitted.)

- [ ] **Step 6: Run the full frontend test suite to check for regressions**

```bash
cd frontend && npm run test -- --run
```
Expected: all tests pass, including any existing `FrameEditor.test.tsx`
coverage of the forward-default behavior.

- [ ] **Step 7: Commit**

```bash
git add frontend/src/features/annotation/TrackControls.tsx \
        frontend/src/features/annotation/TrackControls.test.tsx \
        frontend/src/features/annotation/FrameEditor.tsx
git commit -m "feat: read the SAM2 track range cap from Settings, not a constant

TrackControls and FrameEditor now call useSettings() instead of the
removed MAX_COMBINED_TRACK_RANGE constant, so an admin's change on the
Settings page takes effect without a frontend rebuild."
```

---

## Post-plan manual verification (not a task — do this after all tasks land)

Per `CLAUDE.md`'s testing philosophy, exercise the real feature once
end-to-end before considering this done:

1. `docker compose up -d`, backend (`uv run uvicorn app.main:app
   --reload`), frontend (`npm run dev`).
2. Log in as an admin user (or promote `manualcheck@example.com` to admin
   if it isn't already — check via `GET /auth/me`). Confirm the Settings
   link appears in the header; log in as a non-admin (register a fresh
   `annotator`-role user) and confirm it's absent.
3. Open `/settings`, confirm the field shows `10` (the new default),
   change it to some other value (e.g. `6`), save, and confirm no error
   and the field still shows the saved value after a page refresh.
4. Open a sequence's frame editor, confirm the Track panel's combined-cap
   text now reflects the value just set on the Settings page (e.g. `6`),
   not `20`.
5. Attempt a Track request within the new cap (e.g. 3+3) and confirm it
   still succeeds normally — this plan must not have broken the working
   case.
6. Log in as a non-admin and confirm a direct `PATCH /settings` call
   (e.g. via `curl` with that user's token) returns 403.
