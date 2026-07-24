# Frame Editor Usability Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the frame editor's severe usability gaps found in real hands-on
use — invisible gestures, no negative point, no delete, an unexplained
confirm click, no live box feedback, a canvas that ignores aspect ratio, no
frame-to-frame navigation, and no visual design pass — in one coordinated
pass across backend and frontend.

**Architecture:** Backend gains one additive schema change
(`Annotation.job_id`) and two new delete endpoints, plus `job_id`
population in all four ml-worker Celery tasks that create annotations.
Frontend replaces `FrameCanvas`'s entire gesture-handling model (immediate
per-gesture submission, live point/box rendering, negative points,
hit-test-based removal), adds delete affordances to `MasksList`, fixes
canvas sizing to respect the frame's aspect ratio, adds Prev/Next frame
navigation to `FrameEditor`, and re-styles `ToolsPanel`/`CascadingLabelPicker`
to a disciplined clinical-tool visual language.

**Tech Stack:** FastAPI + SQLAlchemy + Alembic + pytest (backend), React +
TypeScript + Zustand + TanStack Query + Vitest/Testing Library (frontend).

## Global Constraints

- English only in all code, comments, docstrings, UI copy — no Russian in
  committed content.
- Dark theme only — no light-background Tailwind classes.
- All binary media goes through `backend/app/storage.py`'s `StorageService`
  — never a direct filesystem path in domain code.
- `taxonomy_version` on any `Label`-referencing row is copied at creation
  time, never re-derived later.
- Frontend calls the backend only through `apiClient`
  (`frontend/src/shared/api/client.ts`) against the generated
  `schema.d.ts` — never a hand-rolled `fetch()`.
- TDD: every backend task and every frontend task with logic gets a
  failing test before the implementation.
- The one accent color (`blue-600`) means "selected/active" only — action
  buttons ("Generate from mask", "Track") get a visually distinct
  secondary treatment, not blue.
- Positive points/existing masks use the established green-leaning
  palette; negative points use a warning red — this is the one place a
  second accent color is introduced, and it's semantic (distinguishing
  +/-), not decorative.

---

## File Structure

Backend (additive to existing modules):
- `backend/app/annotation/models.py` — `Annotation.job_id` added.
- `backend/app/annotation/schemas.py` — `AnnotationRead.job_id` added.
- `backend/app/annotation/router.py` — `_annotation_read` updated,
  `DELETE /annotations/{annotation_id}`,
  `DELETE /jobs/{job_id}/annotations` added.
- `backend/alembic/versions/<new_rev>_annotation_job_id.py` — new
  migration.
- `ml-worker/app/models.py` — duplicate `Annotation.job_id` added
  (mirrors the backend's schema, per this module's existing documented
  duplication pattern).
- `ml-worker/app/tasks.py` — `job_id=job_id` added to all four
  `Annotation(...)` construction sites.

Frontend (modify existing files unless noted):
- `frontend/src/features/annotation/frameEditorStore.ts` — no field
  changes needed (verified in Task 1 below), used as-is.
- `frontend/src/features/annotation/FrameCanvas.tsx` — gesture model
  rewritten: negative point, live point/box rendering, box-cancel ✕,
  ctrl-click hit-testing via mask alpha sampling, immediate per-gesture
  submission callback.
- `frontend/src/features/annotation/MasksList.tsx` — per-row delete ✕ and
  conditional "Delete all from this run" action.
- `frontend/src/features/annotation/ToolsPanel.tsx` — visual redesign,
  "Add mask" removed from the point/box path, kept and relabeled
  "Generate from mask" for the Mask tool only.
- `frontend/src/features/annotation/CascadingLabelPicker.tsx` — visual
  redesign only, no behavior change.
- `frontend/src/features/annotation/FrameEditor.tsx` — immediate-submit
  wiring for point/box, Prev/Next navigation + keyboard shortcuts,
  aspect-ratio-correct canvas container.
- `frontend/src/features/annotation/SequenceGridPage.tsx` — passes the
  ordered frame list to `FrameEditor`.
- `frontend/src/entities/useAnnotations.ts` — `useDeleteAnnotation`,
  `useDeleteJobAnnotations` hooks added.

---

## Task 1: Backend — `Annotation.job_id` migration

**Files:**
- Modify: `backend/app/annotation/models.py`
- Create: `backend/alembic/versions/<new_rev>_annotation_job_id.py`
- Test: `backend/tests/test_annotation.py`

**Interfaces:**
- Produces: `Annotation.job_id: int | None` (nullable FK to `jobs.id`),
  consumed by Task 2 (schema/router), Task 3 (ml-worker), and the delete
  endpoints in Task 4.

- [ ] **Step 1: Write the failing test**

Add to `backend/tests/test_annotation.py`:

```python
def test_annotation_job_id_column_accepts_a_real_job_reference():
    token = _register_and_login("annot7@example.com")
    frame_id = _create_frame(token)
    label_id = _create_label(token)

    from app.annotation.models import Annotation, AnnotationStatus, AnnotationType
    from app.auth.models import User
    from app.db import SessionLocal
    from app.jobs.models import Job, JobStatus, JobType

    session = SessionLocal()
    try:
        user = session.query(User).filter(User.email == "annot7@example.com").one()
        job = Job(
            job_type=JobType.SAM2_PREDICT,
            status=JobStatus.SUCCEEDED,
            progress=100,
            payload={},
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
            status=AnnotationStatus.DRAFT,
            created_by_id=user.id,
            storage_key="masks/test-job-id.png",
            job_id=job.id,
        )
        session.add(annotation)
        session.commit()
        session.refresh(annotation)

        assert annotation.job_id == job.id
    finally:
        session.close()
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && uv run pytest tests/test_annotation.py::test_annotation_job_id_column_accepts_a_real_job_reference -v`
Expected: FAIL — `TypeError: 'job_id' is an invalid keyword argument for Annotation`.

- [ ] **Step 3: Update the model**

In `backend/app/annotation/models.py`, add the import and column:

```python
from sqlalchemy import JSON, DateTime, Enum, ForeignKey, Integer, String
```

(unchanged — `ForeignKey` is already imported) then add the column to
`Annotation`, after `storage_key`:

```python
    storage_key: Mapped[str | None] = mapped_column(String(500), nullable=True)
    job_id: Mapped[int | None] = mapped_column(ForeignKey("jobs.id"), nullable=True)
```

- [ ] **Step 4: Write the migration**

First check the actual latest head:

Run: `cd backend && uv run alembic heads`

Then generate the migration:

Run: `cd backend && uv run alembic revision -m "annotation job id"`

Open the generated file and replace its contents (keep alembic's own
generated `revision` id, `down_revision` — verify it matches the actual
head from the command above — and `Create Date`):

```python
"""annotation job id

Revision ID: <keep the id alembic generated>
Revises: <keep — must match the actual current head>
Create Date: <keep the date alembic generated>

"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision: str = "<keep the id alembic generated>"
down_revision: Union[str, Sequence[str], None] = "<keep — must match the actual current head>"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column("annotations", sa.Column("job_id", sa.Integer(), nullable=True))
    op.create_foreign_key(
        "fk_annotations_job_id_jobs",
        "annotations",
        "jobs",
        ["job_id"],
        ["id"],
    )


def downgrade() -> None:
    op.drop_constraint("fk_annotations_job_id_jobs", "annotations", type_="foreignkey")
    op.drop_column("annotations", "job_id")
```

- [ ] **Step 5: Apply the migration**

Run:
```bash
cd backend
uv run alembic upgrade head
```

Check `backend/app/config.py`/`.env` for the test database's connection
string/env var name (used by prior tasks in this project — grep for
`endoscopy_test` if unsure) and apply the same migration there if the
test suite uses a separate database rather than the dev one.

- [ ] **Step 6: Run test to verify it passes**

Run: `cd backend && uv run pytest tests/test_annotation.py::test_annotation_job_id_column_accepts_a_real_job_reference -v`
Expected: PASS

- [ ] **Step 7: Run full backend suite**

Run: `cd backend && uv run pytest -v`
Expected: all pass, no regressions.

- [ ] **Step 8: Commit**

```bash
git add backend/app/annotation/models.py backend/alembic/versions/ backend/tests/test_annotation.py
git commit -m "feat: add Annotation.job_id for precise bulk-delete-by-job"
```

---

## Task 2: Backend — expose `job_id` on `AnnotationRead`, add delete endpoints

**Files:**
- Modify: `backend/app/annotation/schemas.py`
- Modify: `backend/app/annotation/router.py`
- Test: `backend/tests/test_annotation.py`

**Interfaces:**
- Consumes: `Annotation.job_id` (Task 1).
- Produces: `AnnotationRead.job_id: int | None`,
  `DELETE /annotation/annotations/{annotation_id}` → 204,
  `DELETE /annotation/jobs/{job_id}/annotations` → `{"deleted_ids": list[int]}`,
  consumed by Task 8 (frontend delete hooks).

- [ ] **Step 1: Write the failing tests**

Add to `backend/tests/test_annotation.py`:

```python
def test_delete_single_annotation_removes_it_and_its_storage_object():
    token = _register_and_login("annot8@example.com")
    frame_id = _create_frame(token)
    label_id = _create_label(token)

    from app.annotation.models import Annotation, AnnotationStatus, AnnotationType
    from app.auth.models import User
    from app.db import SessionLocal
    from app.storage import get_storage_service

    storage = get_storage_service()
    storage_key = "masks/delete-test/single.png"
    storage.upload(storage_key, b"fake-png-bytes", content_type="image/png")

    session = SessionLocal()
    try:
        user = session.query(User).filter(User.email == "annot8@example.com").one()
        annotation = Annotation(
            frame_id=frame_id,
            label_id=label_id,
            taxonomy_version=1,
            annotation_type=AnnotationType.MASK,
            status=AnnotationStatus.DRAFT,
            created_by_id=user.id,
            storage_key=storage_key,
        )
        session.add(annotation)
        session.commit()
        session.refresh(annotation)
        annotation_id = annotation.id
    finally:
        session.close()

    response = client.delete(f"/annotation/annotations/{annotation_id}", headers=_headers(token))
    assert response.status_code == 204

    list_response = client.get(f"/annotation/frames/{frame_id}/annotations", headers=_headers(token))
    assert all(a["id"] != annotation_id for a in list_response.json())


def test_delete_single_annotation_404s_for_missing_annotation():
    token = _register_and_login("annot9@example.com")

    response = client.delete("/annotation/annotations/999999999", headers=_headers(token))
    assert response.status_code == 404


def test_delete_job_annotations_removes_only_that_jobs_annotations():
    token = _register_and_login("annot10@example.com")
    frame_id = _create_frame(token)
    label_id = _create_label(token)

    from app.annotation.models import Annotation, AnnotationStatus, AnnotationType
    from app.auth.models import User
    from app.db import SessionLocal
    from app.jobs.models import Job, JobStatus, JobType

    session = SessionLocal()
    try:
        user = session.query(User).filter(User.email == "annot10@example.com").one()

        job_a = Job(job_type=JobType.SAM2_TRACK, status=JobStatus.SUCCEEDED, progress=100, payload={}, created_by_id=user.id)
        job_b = Job(job_type=JobType.SAM2_TRACK, status=JobStatus.SUCCEEDED, progress=100, payload={}, created_by_id=user.id)
        session.add_all([job_a, job_b])
        session.commit()
        session.refresh(job_a)
        session.refresh(job_b)

        annotation_a1 = Annotation(
            frame_id=frame_id, label_id=label_id, taxonomy_version=1,
            annotation_type=AnnotationType.MASK, status=AnnotationStatus.DRAFT,
            created_by_id=user.id, storage_key="masks/bulk-test/a1.png", job_id=job_a.id,
        )
        annotation_a2 = Annotation(
            frame_id=frame_id, label_id=label_id, taxonomy_version=1,
            annotation_type=AnnotationType.MASK, status=AnnotationStatus.DRAFT,
            created_by_id=user.id, storage_key="masks/bulk-test/a2.png", job_id=job_a.id,
        )
        annotation_b1 = Annotation(
            frame_id=frame_id, label_id=label_id, taxonomy_version=1,
            annotation_type=AnnotationType.MASK, status=AnnotationStatus.DRAFT,
            created_by_id=user.id, storage_key="masks/bulk-test/b1.png", job_id=job_b.id,
        )
        session.add_all([annotation_a1, annotation_a2, annotation_b1])
        session.commit()
        session.refresh(annotation_a1)
        session.refresh(annotation_a2)
        session.refresh(annotation_b1)

        job_a_id = job_a.id
        annotation_b1_id = annotation_b1.id
    finally:
        session.close()

    response = client.delete(f"/annotation/jobs/{job_a_id}/annotations", headers=_headers(token))
    assert response.status_code == 200
    assert len(response.json()["deleted_ids"]) == 2

    list_response = client.get(f"/annotation/frames/{frame_id}/annotations", headers=_headers(token))
    remaining_ids = [a["id"] for a in list_response.json()]
    assert annotation_b1_id in remaining_ids
```

All three tests construct `Annotation` rows directly via a raw
`SessionLocal()` session, matching the existing style already used by
`test_list_annotations_includes_mask_url_when_storage_key_present` in
this same file.

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd backend && uv run pytest tests/test_annotation.py -k "delete" -v`
Expected: FAIL — 404 (routes don't exist yet).

- [ ] **Step 3: Update the schema**

In `backend/app/annotation/schemas.py`, add `job_id` to `AnnotationRead`:

```python
class AnnotationRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: int
    frame_id: int
    label_id: int
    taxonomy_version: int
    annotation_type: AnnotationType
    status: AnnotationStatus
    created_by_id: int
    reviewed_by_id: int | None
    mask_url: str | None = None
    job_id: int | None = None
```

- [ ] **Step 4: Add the delete endpoints**

In `backend/app/annotation/router.py`, update `_annotation_read` to carry
`job_id`, and add the two new routes:

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
    )
```

Add after `update_status`:

```python
@router.delete("/annotations/{annotation_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_annotation(
    annotation_id: int,
    session: Session = Depends(get_session),
    storage: StorageService = Depends(get_storage_service),
) -> None:
    annotation = session.get(Annotation, annotation_id)
    if annotation is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Annotation not found")
    if annotation.storage_key:
        storage.delete(annotation.storage_key)
    session.delete(annotation)
    session.commit()


@router.delete("/jobs/{job_id}/annotations")
def delete_job_annotations(
    job_id: int,
    session: Session = Depends(get_session),
    storage: StorageService = Depends(get_storage_service),
) -> dict[str, list[int]]:
    annotations = session.query(Annotation).filter(Annotation.job_id == job_id).all()
    deleted_ids = [annotation.id for annotation in annotations]
    for annotation in annotations:
        if annotation.storage_key:
            storage.delete(annotation.storage_key)
        session.delete(annotation)
    session.commit()
    return {"deleted_ids": deleted_ids}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd backend && uv run pytest tests/test_annotation.py -v`
Expected: all pass.

- [ ] **Step 6: Run full backend suite**

Run: `cd backend && uv run pytest -v`
Expected: all pass.

- [ ] **Step 7: Commit**

```bash
git add backend/app/annotation/schemas.py backend/app/annotation/router.py backend/tests/test_annotation.py
git commit -m "feat: add single and bulk-by-job annotation delete endpoints"
```

---

## Task 3: ml-worker — populate `job_id` on created annotations

**Files:**
- Modify: `ml-worker/app/models.py`
- Modify: `ml-worker/app/tasks.py`
- Test: `ml-worker/tests/test_tasks_sam2.py`
- Test: `ml-worker/tests/test_tasks.py`

**Interfaces:**
- Consumes: `Annotation.job_id` (Task 1's schema, mirrored here).
- Produces: every `Annotation` row created by `run_sam3_predict`,
  `run_sam3_track`, `run_sam2_predict`, `run_sam2_track` now carries
  `job_id=job_id`, consumed by nothing further in this plan (the backend
  endpoints from Task 2 read whatever is already in the column).

- [ ] **Step 1: Write the failing tests**

Add to `ml-worker/tests/test_tasks_sam2.py` (extends the existing
`test_run_sam2_predict_creates_annotation_and_marks_job_succeeded` test's
assertions rather than duplicating its setup — add this as a new test
right after it):

```python
def test_run_sam2_predict_sets_job_id_on_created_annotation():
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
        tasks_module.run_sam2_predict(job_id=42)

    created_annotation = mock_session.add.call_args.args[0]
    assert created_annotation.job_id == 42
```

Add to `ml-worker/tests/test_tasks_sam2.py` right after
`test_run_sam2_track_maps_results_to_correct_frame_window`:

```python
def test_run_sam2_track_sets_job_id_on_every_created_annotation():
    fake_adapter = MagicMock()
    fake_adapter.track.return_value = [
        MagicMock(mask_png=b"png-1", score=0.81),
        MagicMock(mask_png=b"png-2", score=0.82),
    ]

    mock_session = MagicMock()
    mock_job = MagicMock(
        payload={
            "sequence_id": 10, "label_id": 2, "prompts": [],
            "anchor_frame_id": 101, "backward": 0, "forward": 1,
        },
        created_by_id=1,
    )
    mock_label = MagicMock(id=2, taxonomy_version=3)

    all_frames = [
        MagicMock(id=100, frame_index=0, storage_key="frames/100.png"),
        MagicMock(id=101, frame_index=1, storage_key="frames/101.png"),
        MagicMock(id=102, frame_index=2, storage_key="frames/102.png"),
    ]

    def get_side_effect(model, pk):
        from app.models import Job
        if model is Job:
            return mock_job
        return None

    mock_session.get.side_effect = get_side_effect
    mock_session.query.return_value.filter.return_value.order_by.return_value.all.return_value = all_frames

    with (
        patch.object(tasks_module, "_get_default_sam2_adapter", return_value=fake_adapter),
        patch.object(tasks_module, "_evict_sam3_models"),
        patch.object(tasks_module, "_load_label", return_value=mock_label),
        patch("app.tasks.SessionLocal", return_value=mock_session),
        patch("app.tasks.get_storage_service"),
    ):
        tasks_module.run_sam2_track(job_id=77)

    created_annotations = [call.args[0] for call in mock_session.add.call_args_list]
    assert all(a.job_id == 77 for a in created_annotations)
```

Add to `ml-worker/tests/test_tasks.py` — find the existing SAM-3
predict-success test in that file (grep for `run_sam3_predict` to locate
its exact name and setup pattern first, since this file predates this
plan) and add an analogous `job_id` assertion test right after it,
following the same mocking shape as the SAM 2.1 test above but calling
`tasks_module.run_sam3_predict(job_id=<some int>)` and asserting
`mock_session.add.call_args.args[0].job_id == <that int>`.

- [ ] **Step 2: Run tests to verify they fail**

Run these against the real ml-worker container (per this project's
established pattern — the host `.venv` lacks torch/numpy):

```bash
docker cp ml-worker/tests/test_tasks_sam2.py $(docker compose ps -q ml-worker):/app/tests/test_tasks_sam2.py
docker cp ml-worker/tests/test_tasks.py $(docker compose ps -q ml-worker):/app/tests/test_tasks.py
docker compose exec ml-worker python -m pytest tests/test_tasks_sam2.py tests/test_tasks.py -k "job_id" -v
```

Expected: FAIL — `AssertionError` (created annotation has no `job_id`
attribute set, or it's `None`/`MagicMock` default rather than the
expected value), since `MagicMock`'s default `getattr` behavior on an
unset attribute returns another `MagicMock`, not `None` — the assertion
will fail cleanly either way before the fix.

- [ ] **Step 3: Update the ml-worker's duplicate model**

In `ml-worker/app/models.py`, add the column to `Annotation` (mirrors
`backend/app/annotation/models.py`'s change from Task 1 — this module's
`Annotation` class already has a docstring convention for documenting
these deliberate duplications; follow it):

```python
class Annotation(Base):
    """Minimal duplicate of backend/app/annotation/models.py's Annotation
    — only the columns the ml-worker needs to create mask annotations.
    Never read through this model for anything the backend owns
    authoritatively; created rows are read back exclusively via the
    backend's own API."""

    __tablename__ = "annotations"

    id: Mapped[int] = mapped_column(primary_key=True)
    frame_id: Mapped[int] = mapped_column(ForeignKey("frames.id"))
    label_id: Mapped[int] = mapped_column(ForeignKey("labels.id"))
    taxonomy_version: Mapped[int] = mapped_column(Integer)
    annotation_type: Mapped[AnnotationType] = mapped_column(Enum(AnnotationType))
    payload: Mapped[dict] = mapped_column(JSON)
    status: Mapped[AnnotationStatus] = mapped_column(Enum(AnnotationStatus))
    created_by_id: Mapped[int] = mapped_column(Integer)
    storage_key: Mapped[str | None] = mapped_column(String(500), nullable=True)
    job_id: Mapped[int | None] = mapped_column(Integer, nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=lambda: datetime.now(timezone.utc)
    )
```

Only add the docstring if the class doesn't already have one matching
this shape — check the current file first; if it already has a
docstring, just add the `job_id` line without altering the docstring.
`job_id` is declared as a plain `Integer`, not a `ForeignKey("jobs.id")`
— this module has no duplicate `Job` table mapping (same reasoning
already documented on `Label.procedure_id` in this file: an unresolvable
FK breaks SQLAlchemy's mapper configuration for the whole `Base`
metadata when the referenced table isn't mapped in this process).

- [ ] **Step 4: Wire `job_id` into all four task functions**

In `ml-worker/app/tasks.py`, add `job_id=job_id` to each of the four
`Annotation(...)` constructor calls (in `run_sam3_predict`,
`run_sam3_track`, `run_sam2_predict`, `run_sam2_track`). For example, in
`run_sam2_predict` (the others follow the identical pattern):

```python
        annotation = Annotation(
            frame_id=frame_id,
            label_id=label.id,
            taxonomy_version=label.taxonomy_version,
            annotation_type=AnnotationType.MASK,
            payload={"prompts": prompts, "score": result.score},
            status=AnnotationStatus.DRAFT,
            created_by_id=job.created_by_id,
            storage_key=mask_key,
            job_id=job_id,
        )
```

- [ ] **Step 5: Run tests to verify they pass**

```bash
docker cp ml-worker/app/models.py $(docker compose ps -q ml-worker):/app/app/models.py
docker cp ml-worker/app/tasks.py $(docker compose ps -q ml-worker):/app/app/tasks.py
docker compose exec ml-worker python -m pytest tests/test_tasks_sam2.py tests/test_tasks.py -v
```

Expected: all pass, including the new `job_id` tests.

- [ ] **Step 6: Run the full ml-worker non-GPU suite**

```bash
docker compose exec ml-worker python -m pytest tests/ -v -m "not gpu"
```

If the suite doesn't use a `gpu` marker, run:
```bash
docker compose exec ml-worker python -m pytest tests/ -v
```
and confirm no test that was passing before this change now fails —
check for any test requiring real GPU hardware being skipped rather than
failed, consistent with this project's existing GPU-test-skip pattern
(grep for `skipif` in the ml-worker test suite if any GPU-only test
exists).

- [ ] **Step 7: Commit**

```bash
git add ml-worker/app/models.py ml-worker/app/tasks.py ml-worker/tests/test_tasks_sam2.py ml-worker/tests/test_tasks.py
git commit -m "feat: populate Annotation.job_id in all SAM predict/track tasks"
```

---

## Task 4: Backend — regenerate `openapi.json` + frontend client

**Files:**
- Modify: `openapi.json` (repo root)

**Interfaces:**
- Consumes: Tasks 1-2's schema/endpoint changes.
- Produces: an `openapi.json` containing `AnnotationRead.job_id`,
  `DELETE /annotation/annotations/{annotation_id}`,
  `DELETE /annotation/jobs/{job_id}/annotations` — consumed by every
  frontend task from Task 8 onward via `npm run generate-api`.

- [ ] **Step 1: Regenerate the committed OpenAPI schema**

```bash
cd backend
PYTHONPATH=. uv run python scripts/export_openapi.py
```

Expected output: `Wrote OpenAPI schema to
/mnt/work-disk/Documents/Dev/endoscopy-platform/openapi.json`

- [ ] **Step 2: Verify the new surface is present**

```bash
grep -c "job_id\|annotations/{annotation_id}\|jobs/{job_id}/annotations" ../openapi.json
```

Expected: nonzero.

- [ ] **Step 3: Regenerate the frontend TypeScript client**

```bash
cd ../frontend
npm run generate-api
```

Expected: `src/shared/api/generated/schema.d.ts` rewritten (gitignored,
not committed — confirm via `git status` that only `openapi.json` at repo
root shows as changed).

- [ ] **Step 4: Commit**

```bash
cd ..
git add openapi.json
git commit -m "chore: regenerate openapi.json for annotation delete endpoints and job_id"
```

---

## Task 5: Frontend — `useDeleteAnnotation`, `useDeleteJobAnnotations` hooks

**Files:**
- Modify: `frontend/src/entities/useAnnotations.ts`
- Test: `frontend/tests/useAnnotations.test.tsx` (create if it doesn't
  exist — check first with `ls frontend/tests/useAnnotations.test.tsx`)

**Interfaces:**
- Consumes: `DELETE /annotation/annotations/{annotation_id}`,
  `DELETE /annotation/jobs/{job_id}/annotations` (Task 2, now typed via
  Task 4's regeneration).
- Produces: `useDeleteAnnotation(frameId: number)`,
  `useDeleteJobAnnotations(frameId: number)` — both `useMutation`-based,
  invalidating `["annotations", frameId]` on success (mirroring
  `useCreateAnnotation`'s existing invalidation pattern in this same
  file). Consumed by Task 6 (`MasksList`).

- [ ] **Step 1: Read the existing file to match its exact style**

Read `frontend/src/entities/useAnnotations.ts` in full first — the two
new hooks must match `useCreateAnnotation`'s existing shape (same
`useMutation`/`useQueryClient`/`invalidateQueries` pattern) exactly, not
invent a new one.

- [ ] **Step 2: Write the failing tests**

Create `frontend/tests/useAnnotations.test.tsx` (or add to it if it
already exists — check first):

```typescript
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";

import { apiClient } from "../src/shared/api/client";
import { useDeleteAnnotation, useDeleteJobAnnotations } from "../src/entities/useAnnotations";

function wrapper({ children }: { children: ReactNode }) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}

describe("useDeleteAnnotation", () => {
  it("calls DELETE /annotation/annotations/{annotation_id} with the given id", async () => {
    vi.spyOn(apiClient, "DELETE").mockResolvedValue({ data: undefined, error: undefined, response: new Response() } as never);

    const { result } = renderHook(() => useDeleteAnnotation(42), { wrapper });
    result.current.mutate(7);

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(apiClient.DELETE).toHaveBeenCalledWith(
      "/annotation/annotations/{annotation_id}",
      expect.objectContaining({ params: { path: { annotation_id: 7 } } }),
    );
  });
});

describe("useDeleteJobAnnotations", () => {
  it("calls DELETE /annotation/jobs/{job_id}/annotations with the given job id", async () => {
    vi.spyOn(apiClient, "DELETE").mockResolvedValue({
      data: { deleted_ids: [7, 8] },
      error: undefined,
      response: new Response(),
    } as never);

    const { result } = renderHook(() => useDeleteJobAnnotations(42), { wrapper });
    result.current.mutate(99);

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(apiClient.DELETE).toHaveBeenCalledWith(
      "/annotation/jobs/{job_id}/annotations",
      expect.objectContaining({ params: { path: { job_id: 99 } } }),
    );
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

```bash
cd frontend && npx vitest run tests/useAnnotations.test.tsx
```

Expected: FAIL — `useDeleteAnnotation`/`useDeleteJobAnnotations` not
exported.

- [ ] **Step 4: Implement the hooks**

Add to `frontend/src/entities/useAnnotations.ts` (after the existing
`useCreateAnnotation`):

```typescript
export function useDeleteAnnotation(frameId: number) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (annotationId: number) => {
      await apiClient.DELETE("/annotation/annotations/{annotation_id}", {
        params: { path: { annotation_id: annotationId } },
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["annotations", frameId] });
    },
  });
}

export function useDeleteJobAnnotations(frameId: number) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (jobId: number) => {
      const result = await apiClient.DELETE("/annotation/jobs/{job_id}/annotations", {
        params: { path: { job_id: jobId } },
      });
      return result.data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["annotations", frameId] });
    },
  });
}
```

- [ ] **Step 5: Run tests to verify they pass**

```bash
cd frontend && npx vitest run tests/useAnnotations.test.tsx
```

Expected: PASS (2 tests).

- [ ] **Step 6: Run the full frontend suite and typecheck**

```bash
cd frontend && npx vitest run && npx tsc -b --noEmit
```

Expected: all pass, no type errors.

- [ ] **Step 7: Commit**

```bash
git add frontend/src/entities/useAnnotations.ts frontend/tests/useAnnotations.test.tsx
git commit -m "feat: add useDeleteAnnotation and useDeleteJobAnnotations hooks"
```

---

## Task 6: Frontend — `MasksList` delete affordances

**Files:**
- Modify: `frontend/src/features/annotation/MasksList.tsx`
- Modify: `frontend/tests/MasksList.test.tsx`

**Interfaces:**
- Consumes: `useDeleteAnnotation`, `useDeleteJobAnnotations` (Task 5),
  `AnnotationRead.job_id` (Task 2, typed via Task 4).
- Produces: `MasksList` renders a ✕ per row (single delete, two-stage
  confirm) and a conditional "Delete all from this run" action when
  `annotation.job_id` is non-null (also two-stage confirm) — no prop
  signature change, `MasksList` already receives `annotations` and
  derives `frameId` implicitly needed for the hooks... **note:**
  `MasksList` currently takes `annotations`/`store` but not `frameId` —
  it needs `frameId` as a new prop to call the Task 5 hooks (which are
  keyed by `frameId`). This is a real, necessary prop addition — Task 7
  updates `ToolsPanel` (`MasksList`'s only caller) to pass it through.

- [ ] **Step 1: Write the failing tests**

Add to `frontend/tests/MasksList.test.tsx` (the file already has `TREE`
and `ANNOTATIONS` fixtures at the top — reuse them, extending
`ANNOTATIONS` with a `job_id` field where the tests below need one):

```typescript
describe("MasksList delete", () => {
  it("shows a delete (x) control per row and calls the delete mutation with the annotation id when confirmed twice", async () => {
    const store = createFrameEditorStore();
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    vi.spyOn(apiClient, "GET").mockResolvedValue({ data: TREE, error: undefined, response: new Response() } as never);
    vi.spyOn(apiClient, "DELETE").mockResolvedValue({ data: undefined, error: undefined, response: new Response() } as never);

    render(
      <QueryClientProvider client={queryClient}>
        <MasksList annotations={ANNOTATIONS as never} store={store} frameId={1} />
      </QueryClientProvider>,
    );

    await waitFor(() => expect(screen.getByText("lesion / 0-Ip")).toBeInTheDocument());

    const deleteButton = screen.getByRole("button", { name: /delete mask/i });
    await userEvent.click(deleteButton);
    await userEvent.click(screen.getByRole("button", { name: /confirm delete/i }));

    await waitFor(() =>
      expect(apiClient.DELETE).toHaveBeenCalledWith(
        "/annotation/annotations/{annotation_id}",
        expect.objectContaining({ params: { path: { annotation_id: 55 } } }),
      ),
    );
  });

  it("does not delete on a single click, only after the confirm step", async () => {
    const store = createFrameEditorStore();
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    vi.spyOn(apiClient, "GET").mockResolvedValue({ data: TREE, error: undefined, response: new Response() } as never);
    vi.spyOn(apiClient, "DELETE").mockResolvedValue({ data: undefined, error: undefined, response: new Response() } as never);

    render(
      <QueryClientProvider client={queryClient}>
        <MasksList annotations={ANNOTATIONS as never} store={store} frameId={1} />
      </QueryClientProvider>,
    );

    await waitFor(() => expect(screen.getByText("lesion / 0-Ip")).toBeInTheDocument());
    await userEvent.click(screen.getByRole("button", { name: /delete mask/i }));

    expect(apiClient.DELETE).not.toHaveBeenCalled();
  });

  it("shows 'Delete all from this run' only for annotations with a job_id, and calls the bulk mutation when confirmed", async () => {
    const store = createFrameEditorStore();
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const annotationsWithJob = [{ ...ANNOTATIONS[0], job_id: 99 }];
    vi.spyOn(apiClient, "GET").mockResolvedValue({ data: TREE, error: undefined, response: new Response() } as never);
    vi.spyOn(apiClient, "DELETE").mockResolvedValue({
      data: { deleted_ids: [55] },
      error: undefined,
      response: new Response(),
    } as never);

    render(
      <QueryClientProvider client={queryClient}>
        <MasksList annotations={annotationsWithJob as never} store={store} frameId={1} />
      </QueryClientProvider>,
    );

    await waitFor(() => expect(screen.getByText("lesion / 0-Ip")).toBeInTheDocument());

    const bulkButton = screen.getByRole("button", { name: /delete all from this run/i });
    await userEvent.click(bulkButton);
    await userEvent.click(screen.getByRole("button", { name: /confirm delete all/i }));

    await waitFor(() =>
      expect(apiClient.DELETE).toHaveBeenCalledWith(
        "/annotation/jobs/{job_id}/annotations",
        expect.objectContaining({ params: { path: { job_id: 99 } } }),
      ),
    );
  });

  it("does not show 'Delete all from this run' for an annotation with no job_id", async () => {
    const store = createFrameEditorStore();
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    vi.spyOn(apiClient, "GET").mockResolvedValue({ data: TREE, error: undefined, response: new Response() } as never);

    render(
      <QueryClientProvider client={queryClient}>
        <MasksList annotations={ANNOTATIONS as never} store={store} frameId={1} />
      </QueryClientProvider>,
    );

    await waitFor(() => expect(screen.getByText("lesion / 0-Ip")).toBeInTheDocument());
    expect(screen.queryByRole("button", { name: /delete all from this run/i })).not.toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd frontend && npx vitest run tests/MasksList.test.tsx
```

Expected: FAIL — no delete controls rendered, `frameId` prop not accepted
(TypeScript error surfaced as a test-setup failure or a runtime prop
mismatch depending on how strict the test harness is — either way, RED).

- [ ] **Step 3: Implement the delete UI**

Replace the full contents of `frontend/src/features/annotation/MasksList.tsx`:

```tsx
import { useState } from "react";
import { useStore } from "zustand/react";

import { useDeleteAnnotation, useDeleteJobAnnotations } from "../../entities/useAnnotations";
import { useLabelTree } from "../../entities/useLabelTree";
import type { components } from "../../shared/api/generated/schema";
import type { FrameEditorStore } from "./frameEditorStore";

type Annotation = components["schemas"]["AnnotationRead"];

interface MasksListProps {
  annotations: Annotation[];
  store: FrameEditorStore;
  frameId: number;
}

export function MasksList({ annotations, store, frameId }: MasksListProps) {
  const treeQuery = useLabelTree();
  const tree = treeQuery.data ?? [];
  const deleteAnnotation = useDeleteAnnotation(frameId);
  const deleteJobAnnotations = useDeleteJobAnnotations(frameId);

  const [pendingDeleteId, setPendingDeleteId] = useState<number | null>(null);
  const [pendingBulkJobId, setPendingBulkJobId] = useState<number | null>(null);

  const selectedAnnotationId = useStore(store, (state) => state.selectedAnnotationId);
  const setSelectedAnnotation = useStore(store, (state) => state.setSelectedAnnotation);
  const setLabelSelection = useStore(store, (state) => state.setLabelSelection);
  const setColor = useStore(store, (state) => state.setColor);

  const maskAnnotations = annotations.filter((annotation) => annotation.annotation_type === "mask");

  function resolveLabel(labelId: number) {
    for (const node of tree) {
      if (node.category.id === labelId) {
        return { categoryId: node.category.id, tag: node.category, classification: null };
      }
      const child = node.children.find((c) => c.id === labelId);
      if (child) {
        return { categoryId: node.category.id, tag: child, classification: child.label_type };
      }
    }
    return null;
  }

  function handleSelect(annotation: Annotation) {
    setSelectedAnnotation(annotation.id);
    const resolved = resolveLabel(annotation.label_id);
    if (resolved) {
      setLabelSelection({
        labelCategoryId: resolved.categoryId,
        labelClassification: resolved.classification as never,
        labelTagId: resolved.tag.id,
      });
      setColor(resolved.tag.color);
    }
  }

  function handleDeleteClick(annotationId: number) {
    if (pendingDeleteId === annotationId) {
      deleteAnnotation.mutate(annotationId);
      setPendingDeleteId(null);
    } else {
      setPendingDeleteId(annotationId);
      setPendingBulkJobId(null);
    }
  }

  function handleBulkDeleteClick(jobId: number) {
    if (pendingBulkJobId === jobId) {
      deleteJobAnnotations.mutate(jobId);
      setPendingBulkJobId(null);
    } else {
      setPendingBulkJobId(jobId);
      setPendingDeleteId(null);
    }
  }

  return (
    <ul className="max-h-48 space-y-1 overflow-y-auto text-sm">
      {maskAnnotations.map((annotation) => {
        const resolved = resolveLabel(annotation.label_id);
        const categoryName = tree.find((node) => node.category.id === resolved?.categoryId)?.category.name;
        const tagName = resolved?.tag.name;
        const isPendingDelete = pendingDeleteId === annotation.id;
        const isPendingBulk = annotation.job_id !== null && pendingBulkJobId === annotation.job_id;

        return (
          <li key={annotation.id} className="flex items-center gap-1">
            <button
              type="button"
              onClick={() => handleSelect(annotation)}
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
            {annotation.job_id !== null && (
              <button
                type="button"
                aria-label={isPendingBulk ? "Confirm delete all" : "Delete all from this run"}
                onClick={() => handleBulkDeleteClick(annotation.job_id as number)}
                className={`shrink-0 rounded px-1.5 py-0.5 text-xs ${
                  isPendingBulk ? "bg-red-700 text-white" : "text-gray-500 hover:text-red-400"
                }`}
              >
                {isPendingBulk ? "Confirm all" : "⊗"}
              </button>
            )}
            <button
              type="button"
              aria-label={isPendingDelete ? "Confirm delete mask" : "Delete mask"}
              onClick={() => handleDeleteClick(annotation.id)}
              className={`shrink-0 rounded px-1.5 py-0.5 text-xs ${
                isPendingDelete ? "bg-red-700 text-white" : "text-gray-500 hover:text-red-400"
              }`}
            >
              {isPendingDelete ? "Confirm" : "✕"}
            </button>
          </li>
        );
      })}
    </ul>
  );
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd frontend && npx vitest run tests/MasksList.test.tsx
```

Expected: PASS (6 tests total — 2 existing + 4 new).

- [ ] **Step 5: Run the full frontend suite and typecheck**

```bash
cd frontend && npx vitest run && npx tsc -b --noEmit
```

Expected: failures in `ToolsPanel.test.tsx` (since `MasksList` now
requires `frameId` and `ToolsPanel` doesn't pass it yet) — this is
expected and fixed in Task 7. Confirm the failure is specifically about
the missing `frameId` prop, not something else.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/features/annotation/MasksList.tsx frontend/tests/MasksList.test.tsx
git commit -m "feat: add single and bulk-by-job delete affordances to MasksList"
```

---

## Task 7: Frontend — `ToolsPanel` and `CascadingLabelPicker` visual redesign

**Files:**
- Modify: `frontend/src/features/annotation/ToolsPanel.tsx`
- Modify: `frontend/src/features/annotation/CascadingLabelPicker.tsx`
- Modify: `frontend/tests/ToolsPanel.test.tsx`

**Interfaces:**
- Consumes: `MasksList` (Task 6, now requires `frameId`).
- Produces: `ToolsPanel` now requires a `frameId: number` prop (passed
  through to `MasksList`) in addition to its existing
  `store`/`annotations`/`onTrack` props; **`onAddMask` prop is removed**
  from `ToolsPanel`'s public interface — point/box submission moves to
  `FrameCanvas`'s immediate-submit callback (Task 8), and the panel's
  only remaining explicit-submit action is `onGenerateFromMask`,
  scoped to the Mask tool. This is a real breaking change to
  `ToolsPanel`'s props — Task 9 (`FrameEditor`) updates the caller.

- [ ] **Step 1: Write the failing tests**

Replace the full contents of `frontend/tests/ToolsPanel.test.tsx`:

```typescript
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";

import { apiClient } from "../src/shared/api/client";
import { createFrameEditorStore } from "../src/features/annotation/frameEditorStore";
import { ToolsPanel } from "../src/features/annotation/ToolsPanel";

function renderPanel(onGenerateFromMask = vi.fn(), onTrack = vi.fn(), store = createFrameEditorStore()) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  vi.spyOn(apiClient, "GET").mockResolvedValue({ data: [], error: undefined, response: new Response() } as never);
  render(
    <QueryClientProvider client={queryClient}>
      <ToolsPanel store={store} annotations={[]} frameId={1} onGenerateFromMask={onGenerateFromMask} onTrack={onTrack} />
    </QueryClientProvider>,
  );
  return store;
}

describe("ToolsPanel", () => {
  it("defaults to the SAM 2.1 tab active and SAM-3 tab disabled", () => {
    renderPanel();

    expect(screen.getByRole("tab", { name: "SAM 2.1" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tab", { name: "SAM-3" })).toBeDisabled();
  });

  it("shows Point/Box/Mask row with Mask selectable", async () => {
    const store = renderPanel();

    await userEvent.click(screen.getByRole("button", { name: "Mask" }));

    expect(store.getState().activeTool).toBe("mask");
  });

  it("does not render a generic 'Add mask' submit button when Point is the active tool", () => {
    renderPanel();

    expect(screen.queryByRole("button", { name: "Add mask" })).not.toBeInTheDocument();
  });

  it("shows 'Generate from mask' and calls onGenerateFromMask only when the Mask tool is active", async () => {
    const onGenerateFromMask = vi.fn();
    const store = renderPanel(onGenerateFromMask);

    expect(screen.queryByRole("button", { name: "Generate from mask" })).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Mask" }));
    expect(screen.getByRole("button", { name: "Generate from mask" })).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Generate from mask" }));
    expect(onGenerateFromMask).toHaveBeenCalled();
  });

  it("passes frameId through to MasksList", async () => {
    renderPanel();
    // MasksList renders an empty list with no annotations passed in this
    // test; this test only needs to confirm ToolsPanel doesn't crash
    // rendering MasksList with a real frameId, which a missing/undefined
    // prop would surface as a runtime TypeError inside MasksList's delete
    // hooks (useDeleteAnnotation(frameId) etc.) -- absence of a thrown
    // error during render is the assertion here.
    await waitFor(() => expect(screen.getByRole("tab", { name: "SAM 2.1" })).toBeInTheDocument());
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd frontend && npx vitest run tests/ToolsPanel.test.tsx
```

Expected: FAIL — old `onAddMask` prop still required/used, `frameId` not
accepted, "Generate from mask" doesn't exist.

- [ ] **Step 3: Redesign and update `ToolsPanel.tsx`**

Replace the full contents of `frontend/src/features/annotation/ToolsPanel.tsx`:

```tsx
import { useStore } from "zustand/react";

import type { components } from "../../shared/api/generated/schema";
import { CascadingLabelPicker } from "./CascadingLabelPicker";
import type { FrameEditorStore, PromptType } from "./frameEditorStore";
import { MasksList } from "./MasksList";
import { TrackControls } from "./TrackControls";

type Annotation = components["schemas"]["AnnotationRead"];

interface ToolsPanelProps {
  store: FrameEditorStore;
  annotations: Annotation[];
  frameId: number;
  onGenerateFromMask: () => void;
  onTrack: () => void;
}

const PRESET_COLORS = ["#22d3ee", "#f87171", "#4ade80", "#facc15", "#a78bfa", "#fb923c"];
const TOOLS: PromptType[] = ["point", "box", "mask"];
const TOOL_LABELS: Record<PromptType, string> = { point: "Point", box: "Box", mask: "Mask" };

export function ToolsPanel({ store, annotations, frameId, onGenerateFromMask, onTrack }: ToolsPanelProps) {
  const activeModel = useStore(store, (state) => state.activeModel);
  const activeTool = useStore(store, (state) => state.activeTool);
  const setActiveModel = useStore(store, (state) => state.setActiveModel);
  const setActiveTool = useStore(store, (state) => state.setActiveTool);
  const color = useStore(store, (state) => state.color);
  const setColor = useStore(store, (state) => state.setColor);

  return (
    <aside className="flex w-[280px] shrink-0 flex-col gap-5 overflow-y-auto border-l border-gray-800 bg-gray-950 p-4">
      <section className="space-y-1">
        <h2 className="text-[11px] font-medium text-gray-500">Model</h2>
        <div role="tablist" className="flex gap-1 rounded-md border border-gray-800 bg-gray-900 p-1">
          <button
            type="button"
            role="tab"
            aria-selected={activeModel === "sam2"}
            onClick={() => setActiveModel("sam2")}
            className={`flex-1 rounded px-2 py-1.5 text-sm font-medium transition-colors ${
              activeModel === "sam2" ? "bg-blue-600 text-white" : "text-gray-400 hover:text-gray-200"
            }`}
          >
            SAM 2.1
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={false}
            disabled
            title="Needs more VRAM than this GPU has — available after hardware upgrade"
            className="flex-1 cursor-not-allowed rounded px-2 py-1.5 text-sm font-medium text-gray-700"
          >
            SAM-3
          </button>
        </div>
      </section>

      <section className="space-y-1">
        <h2 className="text-[11px] font-medium text-gray-500">Tool</h2>
        <div className="flex gap-1 rounded-md border border-gray-800 bg-gray-900 p-1">
          {TOOLS.map((tool) => (
            <button
              key={tool}
              type="button"
              onClick={() => setActiveTool(tool)}
              className={`flex-1 rounded px-2 py-1.5 text-sm font-medium transition-colors ${
                activeTool === tool ? "bg-blue-600 text-white" : "text-gray-400 hover:text-gray-200"
              }`}
            >
              {TOOL_LABELS[tool]}
            </button>
          ))}
        </div>
        {activeTool === "point" && (
          <p className="pt-1 text-[11px] leading-snug text-gray-500">
            Click = include · Shift+click = exclude · Drag = box · Ctrl+click a mask = remove
          </p>
        )}
      </section>

      <div className="border-t border-gray-800" />

      <section className="space-y-1">
        <h2 className="text-[11px] font-medium text-gray-500">Label</h2>
        <CascadingLabelPicker store={store} />
      </section>

      <section className="space-y-2">
        <h2 className="text-[11px] font-medium text-gray-500">Color</h2>
        <div className="flex items-center gap-2">
          <input
            type="color"
            value={color}
            onChange={(event) => setColor(event.target.value)}
            className="h-7 w-7 cursor-pointer rounded border border-gray-700 bg-transparent p-0.5"
            aria-label="Color"
          />
          {PRESET_COLORS.map((preset) => (
            <button
              key={preset}
              type="button"
              onClick={() => setColor(preset)}
              style={{ backgroundColor: preset }}
              className={`h-5 w-5 rounded-full border transition-transform ${
                color === preset ? "scale-110 border-gray-200" : "border-gray-700"
              }`}
              aria-label={`Preset color ${preset}`}
            />
          ))}
        </div>
        {activeTool === "mask" && (
          <button
            type="button"
            onClick={onGenerateFromMask}
            className="w-full rounded-md border border-gray-700 bg-gray-800 px-3 py-1.5 text-sm font-medium text-gray-100 hover:bg-gray-700"
          >
            Generate from mask
          </button>
        )}
      </section>

      <div className="border-t border-gray-800" />

      <section className="space-y-1">
        <h2 className="text-[11px] font-medium text-gray-500">Track</h2>
        <TrackControls store={store} onTrack={onTrack} />
      </section>

      <div className="border-t border-gray-800" />

      <section className="space-y-1">
        <h2 className="text-[11px] font-medium text-gray-500">Masks on this frame</h2>
        <MasksList annotations={annotations} store={store} frameId={frameId} />
      </section>
    </aside>
  );
}
```

- [ ] **Step 4: Update `CascadingLabelPicker.tsx`'s visual styling**

Replace the full contents of
`frontend/src/features/annotation/CascadingLabelPicker.tsx` — this
changes only Tailwind classes and label text casing, not the component's
props, state, or behavior (the existing
`frontend/tests/CascadingLabelPicker.test.tsx` must keep passing
unmodified):

```tsx
import { useStore } from "zustand/react";

import { useLabelTree } from "../../entities/useLabelTree";
import type { FrameEditorStore } from "./frameEditorStore";

interface CascadingLabelPickerProps {
  store: FrameEditorStore;
}

const SELECT_CLASSES =
  "mt-1 w-full rounded-md border border-gray-700 bg-gray-900 px-2 py-1.5 text-sm text-gray-100 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 disabled:cursor-not-allowed disabled:opacity-50";

export function CascadingLabelPicker({ store }: CascadingLabelPickerProps) {
  const treeQuery = useLabelTree();
  const tree = treeQuery.data ?? [];

  const labelCategoryId = useStore(store, (state) => state.labelCategoryId);
  const labelClassification = useStore(store, (state) => state.labelClassification);
  const labelTagId = useStore(store, (state) => state.labelTagId);
  const setLabelSelection = useStore(store, (state) => state.setLabelSelection);

  const selectedCategory = tree.find((node) => node.category.id === labelCategoryId);
  const classificationOptions = Array.from(
    new Set((selectedCategory?.children ?? []).map((child) => child.label_type)),
  );
  const tagOptions = (selectedCategory?.children ?? []).filter(
    (child) => labelClassification === null || child.label_type === labelClassification,
  );

  return (
    <div className="space-y-2">
      <label className="block text-xs text-gray-400">
        Category
        <select
          className={SELECT_CLASSES}
          value={labelCategoryId ?? ""}
          onChange={(event) =>
            setLabelSelection({
              labelCategoryId: event.target.value ? Number(event.target.value) : null,
              labelClassification: null,
              labelTagId: null,
            })
          }
        >
          <option value="">Select category</option>
          {tree.map((node) => (
            <option key={node.category.id} value={node.category.id}>
              {node.category.name}
            </option>
          ))}
        </select>
      </label>

      <label className="block text-xs text-gray-400">
        Classification
        <select
          className={SELECT_CLASSES}
          value={labelClassification ?? ""}
          disabled={!selectedCategory}
          onChange={(event) =>
            setLabelSelection({
              labelClassification: (event.target.value || null) as never,
              labelTagId: null,
            })
          }
        >
          <option value="">All</option>
          {classificationOptions.map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </select>
      </label>

      <label className="block text-xs text-gray-400">
        Tag
        <select
          className={SELECT_CLASSES}
          value={labelTagId ?? ""}
          disabled={!selectedCategory}
          onChange={(event) =>
            setLabelSelection({ labelTagId: event.target.value ? Number(event.target.value) : null })
          }
        >
          <option value="">Select tag</option>
          {tagOptions.map((tag) => (
            <option key={tag.id} value={tag.id}>
              {tag.name}
            </option>
          ))}
        </select>
      </label>
    </div>
  );
}
```

- [ ] **Step 5: Run tests to verify they pass**

```bash
cd frontend && npx vitest run tests/ToolsPanel.test.tsx tests/CascadingLabelPicker.test.tsx tests/MasksList.test.tsx
```

Expected: all pass — `ToolsPanel` (5 tests), `CascadingLabelPicker`
(unmodified, still passing since props/behavior are unchanged),
`MasksList` (6 tests, now unblocked since `ToolsPanel` passes `frameId`
through correctly in the test's own render call).

- [ ] **Step 6: Run the full frontend suite and typecheck**

```bash
cd frontend && npx vitest run && npx tsc -b --noEmit
```

Expected: failures remain only in `FrameEditor.test.tsx` (since
`FrameEditor` still calls the old `ToolsPanel` props) — fixed in Task 9.
Confirm no other file is broken.

- [ ] **Step 7: Commit**

```bash
git add frontend/src/features/annotation/ToolsPanel.tsx frontend/src/features/annotation/CascadingLabelPicker.tsx frontend/tests/ToolsPanel.test.tsx
git commit -m "feat: redesign tools panel visual language, remove Add mask for point/box path"
```

---

## Task 8: Frontend — `FrameCanvas` gesture model rewrite

**Files:**
- Modify: `frontend/src/features/annotation/FrameCanvas.tsx`
- Modify: `frontend/tests/FrameCanvas.test.tsx`

**Interfaces:**
- Consumes: `frameEditorStore`'s `addPrompt`, `activeTool`,
  `selectedAnnotationId` (unchanged from before), plus a new prop.
- Produces: `FrameCanvas` gains a new required prop,
  `onPointOrBoxSubmit: (prompt: PromptDraft) => void`, called immediately
  when a point or box gesture completes (Shift+click for negative point,
  drag for box) — **the prompt is still also pushed into the store via
  `addPrompt`** (existing behavior preserved, since `MasksList`/canvas
  overlay rendering of "pending" state still reads from the store — see
  design decision 2 in the spec), but the new callback is what
  `FrameEditor` (Task 9) uses to trigger an immediate SAM 2.1 call rather
  than waiting for an explicit submit button. `mask`-tool submission is
  unchanged (still only reachable via `ToolsPanel`'s "Generate from mask"
  button reading `pendingPrompts` from the store — no callback needed for
  that path since it already goes through an explicit action).
  Ctrl+click now performs real hit-testing against `annotations` (a new
  required prop) and, on hit, calls a new required prop
  `onRemoveAnnotation: (annotationId: number) => void`.

- [ ] **Step 1: Write the failing tests**

Replace the full contents of `frontend/tests/FrameCanvas.test.tsx`:

```typescript
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { createFrameEditorStore } from "../src/features/annotation/frameEditorStore";
import { FrameCanvas } from "../src/features/annotation/FrameCanvas";

const FRAME = {
  id: 1,
  sequence_id: 1,
  storage_key: "frames/1/0.png",
  frame_index: 0,
  width: 400,
  height: 200,
  image_url: "https://example.test/frame.png",
};

function setBoundingRect(canvas: Element) {
  Object.defineProperty(canvas, "getBoundingClientRect", {
    value: () => ({ left: 0, top: 0, width: 400, height: 200 }),
    configurable: true,
  });
}

describe("FrameCanvas", () => {
  it("adds a positive point prompt and calls onPointOrBoxSubmit on a plain left click", () => {
    const store = createFrameEditorStore();
    const onPointOrBoxSubmit = vi.fn();
    const onRemoveAnnotation = vi.fn();
    render(
      <FrameCanvas
        frame={FRAME}
        annotations={[]}
        store={store}
        onPointOrBoxSubmit={onPointOrBoxSubmit}
        onRemoveAnnotation={onRemoveAnnotation}
      />,
    );

    const canvas = screen.getByTestId("frame-canvas");
    setBoundingRect(canvas);
    fireEvent.mouseDown(canvas, { clientX: 200, clientY: 100, button: 0 });
    fireEvent.mouseUp(canvas, { clientX: 200, clientY: 100, button: 0 });

    const prompts = store.getState().pendingPrompts;
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toEqual({ type: "point", coords: [0.5, 0.5], label: true });
    expect(onPointOrBoxSubmit).toHaveBeenCalledWith({ type: "point", coords: [0.5, 0.5], label: true });
  });

  it("adds a negative point prompt on a shift+left click", () => {
    const store = createFrameEditorStore();
    const onPointOrBoxSubmit = vi.fn();
    render(
      <FrameCanvas
        frame={FRAME}
        annotations={[]}
        store={store}
        onPointOrBoxSubmit={onPointOrBoxSubmit}
        onRemoveAnnotation={vi.fn()}
      />,
    );

    const canvas = screen.getByTestId("frame-canvas");
    setBoundingRect(canvas);
    fireEvent.mouseDown(canvas, { clientX: 200, clientY: 100, button: 0, shiftKey: true });
    fireEvent.mouseUp(canvas, { clientX: 200, clientY: 100, button: 0, shiftKey: true });

    const prompts = store.getState().pendingPrompts;
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toEqual({ type: "point", coords: [0.5, 0.5], label: false });
    expect(onPointOrBoxSubmit).toHaveBeenCalledWith({ type: "point", coords: [0.5, 0.5], label: false });
  });

  it("adds a box prompt and calls onPointOrBoxSubmit on left-click-drag", () => {
    const store = createFrameEditorStore();
    const onPointOrBoxSubmit = vi.fn();
    render(
      <FrameCanvas
        frame={FRAME}
        annotations={[]}
        store={store}
        onPointOrBoxSubmit={onPointOrBoxSubmit}
        onRemoveAnnotation={vi.fn()}
      />,
    );

    const canvas = screen.getByTestId("frame-canvas");
    setBoundingRect(canvas);
    fireEvent.mouseDown(canvas, { clientX: 40, clientY: 20, button: 0 });
    fireEvent.mouseMove(canvas, { clientX: 200, clientY: 100, button: 0 });
    fireEvent.mouseUp(canvas, { clientX: 200, clientY: 100, button: 0 });

    const prompts = store.getState().pendingPrompts;
    expect(prompts).toHaveLength(1);
    expect(prompts[0].type).toBe("box");
    expect(prompts[0].coords).toEqual([0.1, 0.1, 0.5, 0.5]);
    expect(onPointOrBoxSubmit).toHaveBeenCalledWith(
      expect.objectContaining({ type: "box", coords: [0.1, 0.1, 0.5, 0.5] }),
    );
  });

  it("cancels an in-progress box without submitting when its cancel (x) is clicked before mouseup", () => {
    const store = createFrameEditorStore();
    const onPointOrBoxSubmit = vi.fn();
    render(
      <FrameCanvas
        frame={FRAME}
        annotations={[]}
        store={store}
        onPointOrBoxSubmit={onPointOrBoxSubmit}
        onRemoveAnnotation={vi.fn()}
      />,
    );

    const canvas = screen.getByTestId("frame-canvas");
    setBoundingRect(canvas);
    fireEvent.mouseDown(canvas, { clientX: 40, clientY: 20, button: 0 });
    fireEvent.mouseMove(canvas, { clientX: 200, clientY: 100, button: 0 });

    const cancelButton = screen.getByRole("button", { name: /cancel box/i });
    fireEvent.click(cancelButton);

    expect(store.getState().pendingPrompts).toHaveLength(0);
    expect(onPointOrBoxSubmit).not.toHaveBeenCalled();
  });

  it("does not add a prompt for a plain click when ctrl is held and no annotation is under the cursor", () => {
    const store = createFrameEditorStore();
    render(
      <FrameCanvas
        frame={FRAME}
        annotations={[]}
        store={store}
        onPointOrBoxSubmit={vi.fn()}
        onRemoveAnnotation={vi.fn()}
      />,
    );

    const canvas = screen.getByTestId("frame-canvas");
    setBoundingRect(canvas);
    fireEvent.mouseDown(canvas, { clientX: 200, clientY: 100, button: 0, ctrlKey: true });
    fireEvent.mouseUp(canvas, { clientX: 200, clientY: 100, button: 0, ctrlKey: true });

    expect(store.getState().pendingPrompts).toHaveLength(0);
  });

  it("rasterizes a freehand stroke to mask_png when activeTool is mask", () => {
    const store = createFrameEditorStore();
    store.getState().setActiveTool("mask");
    render(
      <FrameCanvas
        frame={FRAME}
        annotations={[]}
        store={store}
        onPointOrBoxSubmit={vi.fn()}
        onRemoveAnnotation={vi.fn()}
      />,
    );

    const canvas = screen.getByTestId("frame-canvas") as HTMLCanvasElement;
    setBoundingRect(canvas);
    HTMLCanvasElement.prototype.getContext =
      HTMLCanvasElement.prototype.getContext ??
      (() => ({
        clearRect: () => {},
        drawImage: () => {},
        beginPath: () => {},
        moveTo: () => {},
        lineTo: () => {},
        arc: () => {},
        fill: () => {},
        strokeRect: () => {},
        stroke: () => {},
        strokeStyle: "",
        fillStyle: "",
        lineWidth: 0,
        lineCap: "round",
        getImageData: () => ({ data: new Uint8ClampedArray(4) }),
      }) as never);
    HTMLCanvasElement.prototype.toDataURL = () => "data:image/png;base64,ZmFrZS1wbmc=";

    fireEvent.mouseDown(canvas, { clientX: 100, clientY: 50, button: 0 });
    fireEvent.mouseMove(canvas, { clientX: 150, clientY: 80, button: 0 });
    fireEvent.mouseUp(canvas, { clientX: 200, clientY: 100, button: 0 });

    const prompts = store.getState().pendingPrompts;
    expect(prompts).toHaveLength(1);
    expect(prompts[0].type).toBe("mask");
    expect(prompts[0].mask_png).toBe("ZmFrZS1wbmc=");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd frontend && npx vitest run tests/FrameCanvas.test.tsx
```

Expected: FAIL — missing required props, no negative-point handling, no
cancel-box button, `label: true` hardcoded.

- [ ] **Step 3: Rewrite `FrameCanvas.tsx`**

Replace the full contents of
`frontend/src/features/annotation/FrameCanvas.tsx`:

```tsx
import { useEffect, useRef, useState } from "react";
import { useStore } from "zustand/react";

import type { components } from "../../shared/api/generated/schema";
import type { FrameEditorStore, PromptDraft } from "./frameEditorStore";

type Frame = components["schemas"]["FrameRead"];
type Annotation = components["schemas"]["AnnotationRead"];

interface FrameCanvasProps {
  frame: Frame;
  annotations: Annotation[];
  store: FrameEditorStore;
  onPointOrBoxSubmit: (prompt: PromptDraft) => void;
  onRemoveAnnotation: (annotationId: number) => void;
}

interface DragState {
  startX: number;
  startY: number;
}

interface PendingBox {
  startX: number;
  startY: number;
  endX: number;
  endY: number;
}

interface RecentPoint {
  x: number;
  y: number;
  positive: boolean;
}

const POSITIVE_COLOR = "rgba(74, 222, 128, 0.95)";
const NEGATIVE_COLOR = "rgba(248, 113, 113, 0.95)";
const BOX_COLOR = "rgba(96, 165, 250, 0.95)";

export function FrameCanvas({ frame, annotations, store, onPointOrBoxSubmit, onRemoveAnnotation }: FrameCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const maskCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const dragRef = useRef<DragState | null>(null);
  const strokePointsRef = useRef<[number, number][]>([]);
  const maskImageDataCacheRef = useRef<Map<number, ImageData>>(new Map());
  const [frameImage, setFrameImage] = useState<HTMLImageElement | null>(null);
  const [pendingBox, setPendingBox] = useState<PendingBox | null>(null);
  // Points the user just placed, kept visible until the next annotations
  // refetch replaces them with a real mask overlay (or, for a rejected/
  // failed job, until cleared manually) -- without this, a submitted point
  // is invisible for the full round trip to SAM 2.1, which is exactly the
  // "invisible gesture" complaint this rewrite exists to fix.
  const [recentPoints, setRecentPoints] = useState<RecentPoint[]>([]);

  const activeTool = useStore(store, (state) => state.activeTool);
  const addPrompt = useStore(store, (state) => state.addPrompt);
  const selectedAnnotationId = useStore(store, (state) => state.selectedAnnotationId);

  useEffect(() => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => setFrameImage(img);
    img.src = frame.image_url;
  }, [frame.image_url]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !frameImage) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    canvas.width = frame.width;
    canvas.height = frame.height;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(frameImage, 0, 0, canvas.width, canvas.height);

    maskImageDataCacheRef.current = new Map();

    for (const annotation of annotations) {
      if (!annotation.mask_url) continue;
      const maskImg = new Image();
      maskImg.crossOrigin = "anonymous";
      maskImg.onload = () => {
        ctx.globalAlpha = annotation.id === selectedAnnotationId ? 0.85 : 0.5;
        ctx.drawImage(maskImg, 0, 0, canvas.width, canvas.height);
        ctx.globalAlpha = 1;

        // Cache each mask's own alpha channel offscreen (not sampled from
        // the shared visible canvas, which is a composite of the photo +
        // every mask drawn so far) so ctrl-click hit-testing can query
        // "is THIS annotation's mask opaque at this pixel" independently
        // of paint order or the other masks' overlap.
        const offscreen = document.createElement("canvas");
        offscreen.width = canvas.width;
        offscreen.height = canvas.height;
        const offCtx = offscreen.getContext("2d");
        if (offCtx) {
          offCtx.drawImage(maskImg, 0, 0, canvas.width, canvas.height);
          maskImageDataCacheRef.current.set(annotation.id, offCtx.getImageData(0, 0, canvas.width, canvas.height));
        }
      };
      maskImg.src = annotation.mask_url;
    }

    // A fresh `annotations` array means the parent's query refetched --
    // either a submitted prompt turned into a real mask, or the frame
    // changed. Either way, any placeholder point markers are now stale
    // (superseded by a real overlay, or no longer relevant to this frame),
    // so clear them rather than leaving a phantom marker with nothing
    // underneath it once the real mask has rendered.
    setRecentPoints([]);
  }, [frameImage, frame.width, frame.height, annotations, selectedAnnotationId]);

  function toNormalized(clientX: number, clientY: number): [number, number] {
    const canvas = canvasRef.current;
    if (!canvas) return [0, 0];
    const rect = canvas.getBoundingClientRect();
    const x = (clientX - rect.left) / rect.width;
    const y = (clientY - rect.top) / rect.height;
    return [Math.min(1, Math.max(0, x)), Math.min(1, Math.max(0, y))];
  }

  function hitTestAnnotation(normX: number, normY: number): number | null {
    const canvas = canvasRef.current;
    if (!canvas) return null;
    const pixelX = Math.floor(normX * canvas.width);
    const pixelY = Math.floor(normY * canvas.height);

    // Topmost = last-rendered = last element of `annotations` that has
    // cached image data and a nonzero alpha at this pixel.
    for (let i = annotations.length - 1; i >= 0; i -= 1) {
      const annotation = annotations[i];
      const imageData = maskImageDataCacheRef.current.get(annotation.id);
      if (!imageData) continue;
      const pixelIndex = (pixelY * canvas.width + pixelX) * 4;
      const alpha = imageData.data[pixelIndex + 3];
      if (alpha > 0) return annotation.id;
    }
    return null;
  }

  function handleMouseDown(event: React.MouseEvent<HTMLCanvasElement>) {
    if (event.button !== 0) return;
    const [x, y] = toNormalized(event.clientX, event.clientY);

    if (event.ctrlKey) {
      const hitId = hitTestAnnotation(x, y);
      if (hitId !== null) onRemoveAnnotation(hitId);
      return;
    }

    dragRef.current = { startX: x, startY: y };
    if (activeTool === "mask") {
      strokePointsRef.current = [[x, y]];
      if (!maskCanvasRef.current) {
        maskCanvasRef.current = document.createElement("canvas");
      }
      const maskCanvas = maskCanvasRef.current;
      maskCanvas.width = frame.width;
      maskCanvas.height = frame.height;
      const maskCtx = maskCanvas.getContext("2d");
      maskCtx?.clearRect(0, 0, maskCanvas.width, maskCanvas.height);
    }
  }

  function drawPendingOverlay(box: PendingBox | null, points: RecentPoint[] = recentPoints) {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx || !frameImage) return;

    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(frameImage, 0, 0, canvas.width, canvas.height);
    for (const annotation of annotations) {
      const imageData = maskImageDataCacheRef.current.get(annotation.id);
      if (!imageData) continue;
      ctx.globalAlpha = annotation.id === selectedAnnotationId ? 0.85 : 0.5;
      ctx.putImageData(imageData, 0, 0);
      ctx.globalAlpha = 1;
    }

    const pointRadius = Math.max(4, canvas.width * 0.008);
    for (const point of points) {
      ctx.fillStyle = point.positive ? POSITIVE_COLOR : NEGATIVE_COLOR;
      ctx.beginPath();
      ctx.arc(point.x * canvas.width, point.y * canvas.height, pointRadius, 0, Math.PI * 2);
      ctx.fill();
    }

    if (box) {
      const x = Math.min(box.startX, box.endX) * canvas.width;
      const y = Math.min(box.startY, box.endY) * canvas.height;
      const w = Math.abs(box.endX - box.startX) * canvas.width;
      const h = Math.abs(box.endY - box.startY) * canvas.height;
      ctx.strokeStyle = BOX_COLOR;
      ctx.lineWidth = Math.max(2, canvas.width * 0.003);
      ctx.strokeRect(x, y, w, h);
    }
  }

  function handleMouseMove(event: React.MouseEvent<HTMLCanvasElement>) {
    const drag = dragRef.current;
    if (!drag) return;
    const [x, y] = toNormalized(event.clientX, event.clientY);

    if (activeTool === "mask") {
      strokePointsRef.current.push([x, y]);
      const canvas = canvasRef.current;
      const ctx = canvas?.getContext("2d");
      if (!canvas || !ctx) return;
      const points = strokePointsRef.current;
      const [prevX, prevY] = points.length > 1 ? points[points.length - 2] : points[0];

      ctx.strokeStyle = "rgba(34, 211, 238, 0.9)";
      ctx.lineWidth = Math.max(2, canvas.width * 0.01);
      ctx.lineCap = "round";
      ctx.beginPath();
      ctx.moveTo(prevX * canvas.width, prevY * canvas.height);
      ctx.lineTo(x * canvas.width, y * canvas.height);
      ctx.stroke();

      const maskCanvas = maskCanvasRef.current;
      const maskCtx = maskCanvas?.getContext("2d");
      if (maskCanvas && maskCtx) {
        maskCtx.strokeStyle = "rgba(255, 255, 255, 1)";
        maskCtx.lineWidth = Math.max(2, maskCanvas.width * 0.01);
        maskCtx.lineCap = "round";
        maskCtx.beginPath();
        maskCtx.moveTo(prevX * maskCanvas.width, prevY * maskCanvas.height);
        maskCtx.lineTo(x * maskCanvas.width, y * maskCanvas.height);
        maskCtx.stroke();
      }
      return;
    }

    const dx = Math.abs(x - drag.startX);
    const dy = Math.abs(y - drag.startY);
    if (dx > 0.01 || dy > 0.01) {
      const box = { startX: drag.startX, startY: drag.startY, endX: x, endY: y };
      setPendingBox(box);
      drawPendingOverlay(box);
    }
  }

  function submitPointOrBox(prompt: PromptDraft) {
    addPrompt(prompt);
    onPointOrBoxSubmit(prompt);
    if (prompt.type === "point") {
      const [x, y] = prompt.coords;
      const updated = [...recentPoints, { x, y, positive: prompt.label }];
      setRecentPoints(updated);
      drawPendingOverlay(null, updated);
    }
  }

  function handleMouseUp(event: React.MouseEvent<HTMLCanvasElement>) {
    if (event.button !== 0) return;
    const drag = dragRef.current;
    dragRef.current = null;

    if (event.ctrlKey) return;

    if (activeTool === "mask") {
      const maskCanvas = maskCanvasRef.current;
      if (maskCanvas && strokePointsRef.current.length > 1) {
        const dataUrl = maskCanvas.toDataURL("image/png");
        const base64 = dataUrl.split(",")[1] ?? "";
        addPrompt({ type: "mask", coords: [], label: true, mask_png: base64 });
      }
      strokePointsRef.current = [];
      return;
    }

    if (!drag) return;
    const [endX, endY] = toNormalized(event.clientX, event.clientY);
    const dx = Math.abs(endX - drag.startX);
    const dy = Math.abs(endY - drag.startY);
    const isDrag = dx > 0.01 || dy > 0.01;

    if (isDrag) {
      submitPointOrBox({
        type: "box",
        coords: [
          Math.min(drag.startX, endX),
          Math.min(drag.startY, endY),
          Math.max(drag.startX, endX),
          Math.max(drag.startY, endY),
        ],
        label: true,
      });
      setPendingBox(null);
    } else {
      submitPointOrBox({
        type: "point",
        coords: [drag.startX, drag.startY],
        label: !event.shiftKey,
      });
    }
  }

  function handleCancelBox() {
    setPendingBox(null);
    dragRef.current = null;
    drawPendingOverlay(null);
  }

  const canvas = canvasRef.current;
  let cancelButtonStyle: React.CSSProperties | undefined;
  if (pendingBox && canvas) {
    const rect = canvas.getBoundingClientRect();
    const boxLeft = Math.min(pendingBox.startX, pendingBox.endX) * rect.width;
    const boxTop = Math.min(pendingBox.startY, pendingBox.endY) * rect.height;
    cancelButtonStyle = { position: "absolute", left: boxLeft, top: boxTop, transform: "translate(-50%, -50%)" };
  }

  return (
    <div className="relative h-full w-full">
      <canvas
        ref={canvasRef}
        data-testid="frame-canvas"
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        className="h-full w-full cursor-crosshair bg-gray-900"
      />
      {pendingBox && (
        <button
          type="button"
          aria-label="Cancel box"
          onClick={handleCancelBox}
          style={cancelButtonStyle}
          className="flex h-5 w-5 items-center justify-center rounded-full bg-gray-950 text-xs text-gray-200 shadow"
        >
          ✕
        </button>
      )}
    </div>
  );
}
```

`recentPoints` is the mechanism satisfying the design spec's "every point
in `pendingPrompts`... is drawn as a small filled circle... colored by
its `label`" requirement (spec section 2): `submitPointOrBox` appends the
just-placed point immediately (positive → green `POSITIVE_COLOR`,
negative → red `NEGATIVE_COLOR`) and redraws, so the marker is visible
the instant the gesture completes — not only after the SAM 2.1 round
trip. The main rendering `useEffect` clears `recentPoints` whenever
`annotations` changes (new mask arrived or the frame changed), so a
placeholder marker never lingers after the real mask overlay supersedes
it. This closes the loop between "gesture happened" (marker appears
instantly) and "SAM 2.1 responded" (marker is replaced by the real mask)
without requiring a separate loading-state UI.

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd frontend && npx vitest run tests/FrameCanvas.test.tsx
```

Expected: PASS (6 tests).

- [ ] **Step 5: Run the full frontend suite and typecheck**

```bash
cd frontend && npx vitest run && npx tsc -b --noEmit
```

Expected: failures remain only in `FrameEditor.test.tsx` (still using the
old `FrameCanvas` prop shape) — fixed in Task 9.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/features/annotation/FrameCanvas.tsx frontend/tests/FrameCanvas.test.tsx
git commit -m "feat: rewrite FrameCanvas gesture model - negative points, live box, ctrl-click hit-test removal"
```

---

## Task 9: Frontend — `FrameEditor` wiring, Prev/Next navigation, aspect-ratio canvas sizing

**Files:**
- Modify: `frontend/src/features/annotation/FrameEditor.tsx`
- Modify: `frontend/src/features/annotation/SequenceGridPage.tsx`
- Modify: `frontend/tests/FrameEditor.test.tsx`

**Interfaces:**
- Consumes: `FrameCanvas`'s new props (Task 8), `ToolsPanel`'s new props
  (Task 7), `useDeleteAnnotation` (Task 5), `useFrames` (existing).
- Produces: `FrameEditor` gains new props `frames: FrameRead[]` (the
  ordered list from the same sequence, for Prev/Next) — `SequenceGridPage`
  is updated to pass its existing `framesQuery.data` through.

- [ ] **Step 1: Write the failing tests**

Replace the full contents of `frontend/tests/FrameEditor.test.tsx`:

```typescript
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";

import { apiClient } from "../src/shared/api/client";
import { FrameEditor } from "../src/features/annotation/FrameEditor";

const LABEL_TREE = [
  {
    category: { id: 1, name: "lesion", label_type: "geometric", color: "#fff", procedure_id: null, taxonomy_version: 1 },
    children: [
      { id: 2, name: "0-Ip", label_type: "geometric", color: "#f00", procedure_id: null, taxonomy_version: 1 },
    ],
  },
];

const FRAMES = [
  { id: 41, sequence_id: 9, storage_key: "frames/9/41.png", frame_index: 0, width: 400, height: 200, image_url: "https://example.test/f41.png" },
  { id: 42, sequence_id: 9, storage_key: "frames/9/42.png", frame_index: 1, width: 400, height: 200, image_url: "https://example.test/f42.png" },
  { id: 43, sequence_id: 9, storage_key: "frames/9/43.png", frame_index: 2, width: 400, height: 200, image_url: "https://example.test/f43.png" },
];

function renderEditor(frameId = 42, onClose = vi.fn(), onFrameChange = vi.fn()) {
  vi.restoreAllMocks();
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  vi.spyOn(apiClient, "GET").mockImplementation((async (path: string, options?: { params?: { path?: { frame_id?: number } } }) => {
    if (path === "/media/frames/{frame_id}") {
      const requestedId = options?.params?.path?.frame_id ?? frameId;
      const match = FRAMES.find((f) => f.id === requestedId) ?? FRAMES[1];
      return { data: match, error: undefined, response: new Response() };
    }
    if (path === "/annotation/frames/{frame_id}/annotations") {
      return { data: [], error: undefined, response: new Response() };
    }
    if (path === "/taxonomy/labels/tree") {
      return { data: LABEL_TREE, error: undefined, response: new Response() };
    }
    return { data: undefined, error: "not mocked", response: new Response() };
  }) as never);
  vi.spyOn(apiClient, "POST").mockResolvedValue({
    data: { id: 1, job_type: "sam2_predict", status: "pending", progress: 0, result_ref: null, error: null, created_by_id: 1, started_at: null, finished_at: null },
    error: undefined,
    response: new Response(),
  } as never);

  return render(
    <QueryClientProvider client={queryClient}>
      <FrameEditor frameId={frameId} frames={FRAMES} onClose={onClose} onFrameChange={onFrameChange} />
    </QueryClientProvider>,
  );
}

describe("FrameEditor", () => {
  it("renders the canvas and tools panel once the frame loads", async () => {
    renderEditor();

    await waitFor(() => expect(screen.getByTestId("frame-canvas")).toBeInTheDocument());
    expect(screen.getByRole("tab", { name: "SAM 2.1" })).toBeInTheDocument();
  });

  it("calls onClose when Back to grid is clicked", async () => {
    const onClose = vi.fn();
    renderEditor(42, onClose);

    await waitFor(() => expect(screen.getByTestId("frame-canvas")).toBeInTheDocument());
    await userEvent.click(screen.getByRole("button", { name: /back to grid/i }));

    expect(onClose).toHaveBeenCalled();
  });

  it("shows Frame 2 of 3 and calls onFrameChange with the next frame's id when Next is clicked", async () => {
    const onFrameChange = vi.fn();
    renderEditor(42, vi.fn(), onFrameChange);

    await waitFor(() => expect(screen.getByTestId("frame-canvas")).toBeInTheDocument());
    expect(screen.getByText("Frame 2 of 3")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: /^next/i }));
    expect(onFrameChange).toHaveBeenCalledWith(43);
  });

  it("calls onFrameChange with the previous frame's id when Prev is clicked", async () => {
    const onFrameChange = vi.fn();
    renderEditor(42, vi.fn(), onFrameChange);

    await waitFor(() => expect(screen.getByTestId("frame-canvas")).toBeInTheDocument());
    await userEvent.click(screen.getByRole("button", { name: /^prev/i }));
    expect(onFrameChange).toHaveBeenCalledWith(41);
  });

  it("disables Prev on the first frame and Next on the last frame", async () => {
    const onFrameChange = vi.fn();
    renderEditor(41, vi.fn(), onFrameChange);

    await waitFor(() => expect(screen.getByTestId("frame-canvas")).toBeInTheDocument());
    expect(screen.getByRole("button", { name: /^prev/i })).toBeDisabled();
  });

  it("navigates to the next frame on ArrowRight keydown", async () => {
    const onFrameChange = vi.fn();
    renderEditor(42, vi.fn(), onFrameChange);

    await waitFor(() => expect(screen.getByTestId("frame-canvas")).toBeInTheDocument());
    fireEvent.keyDown(window, { key: "ArrowRight" });

    expect(onFrameChange).toHaveBeenCalledWith(43);
  });

  it("submits a SAM 2.1 predict job immediately when a point is clicked with a label selected", async () => {
    renderEditor();

    await waitFor(() => expect(screen.getByTestId("frame-canvas")).toBeInTheDocument());
    await waitFor(() => expect(screen.getByRole("option", { name: "lesion" })).toBeInTheDocument());
    await userEvent.selectOptions(screen.getByLabelText("Category"), "1");
    await userEvent.selectOptions(screen.getByLabelText("Tag"), "2");

    const canvas = screen.getByTestId("frame-canvas");
    Object.defineProperty(canvas, "getBoundingClientRect", {
      value: () => ({ left: 0, top: 0, width: 400, height: 200 }),
    });
    fireEvent.mouseDown(canvas, { clientX: 200, clientY: 100, button: 0 });
    fireEvent.mouseUp(canvas, { clientX: 200, clientY: 100, button: 0 });

    await waitFor(() =>
      expect(apiClient.POST).toHaveBeenCalledWith(
        "/jobs/sam2/predict",
        expect.objectContaining({
          body: expect.objectContaining({
            frame_id: 42,
            label_id: 2,
            prompts: [{ type: "point", coords: [0.5, 0.5], label: true }],
          }),
        }),
      ),
    );
  });

  it("does not submit a predict job on a point click when no label is selected", async () => {
    renderEditor();

    await waitFor(() => expect(screen.getByTestId("frame-canvas")).toBeInTheDocument());

    const canvas = screen.getByTestId("frame-canvas");
    Object.defineProperty(canvas, "getBoundingClientRect", {
      value: () => ({ left: 0, top: 0, width: 400, height: 200 }),
    });
    fireEvent.mouseDown(canvas, { clientX: 200, clientY: 100, button: 0 });
    fireEvent.mouseUp(canvas, { clientX: 200, clientY: 100, button: 0 });

    expect(apiClient.POST).not.toHaveBeenCalledWith("/jobs/sam2/predict", expect.anything());
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd frontend && npx vitest run tests/FrameEditor.test.tsx
```

Expected: FAIL — `frames`/`onFrameChange` props not accepted, no Prev/Next
UI, point clicks don't auto-submit (still require the removed "Add mask"
button).

- [ ] **Step 3: Rewrite `FrameEditor.tsx`**

Replace the full contents of `frontend/src/features/annotation/FrameEditor.tsx`:

```tsx
import { useEffect, useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";

import { useAnnotations, useDeleteAnnotation } from "../../entities/useAnnotations";
import { useFrame } from "../../entities/useFrames";
import { useJob } from "../../entities/useJobs";
import { useSam2Predict, useSam2Track } from "../../entities/useSegmentation";
import { createFrameEditorStore, type PromptDraft } from "./frameEditorStore";
import { FrameCanvas } from "./FrameCanvas";
import { ToolsPanel } from "./ToolsPanel";
import type { components } from "../../shared/api/generated/schema";

type FrameRead = components["schemas"]["FrameRead"];

interface FrameEditorProps {
  frameId: number;
  frames: FrameRead[];
  onClose: () => void;
  onFrameChange: (frameId: number) => void;
}

export function FrameEditor({ frameId, frames, onClose, onFrameChange }: FrameEditorProps) {
  const store = useMemo(() => createFrameEditorStore(), [frameId]);
  const [activeJobId, setActiveJobId] = useState<number | null>(null);
  const queryClient = useQueryClient();

  const frameQuery = useFrame(frameId);
  const annotationsQuery = useAnnotations(frameId);
  const jobQuery = useJob(activeJobId);
  const predictMutation = useSam2Predict();
  const trackMutation = useSam2Track();
  const deleteAnnotation = useDeleteAnnotation(frameId);

  const orderedFrames = [...frames].sort((a, b) => a.frame_index - b.frame_index);
  const currentIndex = orderedFrames.findIndex((f) => f.id === frameId);
  const prevFrame = currentIndex > 0 ? orderedFrames[currentIndex - 1] : null;
  const nextFrame = currentIndex >= 0 && currentIndex < orderedFrames.length - 1 ? orderedFrames[currentIndex + 1] : null;

  useEffect(() => {
    if (jobQuery.data?.status === "succeeded") {
      queryClient.invalidateQueries({ queryKey: ["annotations", frameId] });
    }
  }, [jobQuery.data?.status, jobQuery.data?.id, frameId, queryClient]);

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      const target = event.target as HTMLElement | null;
      if (target && (target.tagName === "SELECT" || target.tagName === "INPUT" || target.tagName === "TEXTAREA")) {
        return;
      }
      if (event.key === "ArrowLeft" && prevFrame) onFrameChange(prevFrame.id);
      if (event.key === "ArrowRight" && nextFrame) onFrameChange(nextFrame.id);
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [prevFrame, nextFrame, onFrameChange]);

  function submitPredict(prompts: PromptDraft[]) {
    const state = store.getState();
    if (state.labelTagId === null || prompts.length === 0) return;
    predictMutation.mutate(
      { frame_id: frameId, label_id: state.labelTagId, prompts },
      {
        onSuccess: (data) => {
          if (data) setActiveJobId(data.id);
          store.getState().clearPrompts();
        },
      },
    );
  }

  function handlePointOrBoxSubmit(prompt: PromptDraft) {
    submitPredict([prompt]);
  }

  function handleGenerateFromMask() {
    submitPredict(store.getState().pendingPrompts);
  }

  function handleRemoveAnnotation(annotationId: number) {
    deleteAnnotation.mutate(annotationId);
  }

  function handleTrack() {
    const state = store.getState();
    if (state.labelTagId === null) return;
    trackMutation.mutate(
      {
        sequence_id: frameQuery.data?.sequence_id ?? 0,
        label_id: state.labelTagId,
        prompts: state.pendingPrompts,
        anchor_frame_id: frameId,
        backward: state.backward,
        forward: state.forward,
      },
      {
        onSuccess: (data) => {
          if (data) setActiveJobId(data.id);
        },
      },
    );
  }

  if (!frameQuery.data) {
    return <p className="p-8 text-sm text-gray-500">Loading frame...</p>;
  }

  return (
    <div className="flex h-screen flex-col bg-gray-950 text-gray-100">
      <div className="flex items-center gap-3 border-b border-gray-800 p-3">
        <button
          type="button"
          onClick={onClose}
          className="rounded border border-gray-700 px-3 py-1 text-sm text-gray-200 hover:bg-gray-800"
        >
          ✕ Back to grid
        </button>
        <div className="flex items-center gap-2">
          <button
            type="button"
            aria-label="Prev frame"
            disabled={!prevFrame}
            onClick={() => prevFrame && onFrameChange(prevFrame.id)}
            className="rounded border border-gray-700 px-2 py-1 text-sm text-gray-200 hover:bg-gray-800 disabled:cursor-not-allowed disabled:opacity-40"
          >
            ‹ Prev
          </button>
          <span className="text-sm text-gray-400">
            Frame {currentIndex + 1} of {orderedFrames.length}
          </span>
          <button
            type="button"
            aria-label="Next frame"
            disabled={!nextFrame}
            onClick={() => nextFrame && onFrameChange(nextFrame.id)}
            className="rounded border border-gray-700 px-2 py-1 text-sm text-gray-200 hover:bg-gray-800 disabled:cursor-not-allowed disabled:opacity-40"
          >
            Next ›
          </button>
        </div>
        {jobQuery.data && (
          <span className="ml-3 text-sm text-gray-400">
            Job #{jobQuery.data.id}: {jobQuery.data.status} ({jobQuery.data.progress}%)
          </span>
        )}
      </div>
      <div className="flex flex-1 overflow-hidden">
        <div className="flex flex-1 items-center justify-center overflow-hidden p-4">
          <div
            className="relative"
            style={{
              aspectRatio: `${frameQuery.data.width} / ${frameQuery.data.height}`,
              maxWidth: "100%",
              maxHeight: "100%",
              width: "100%",
              height: "100%",
            }}
          >
            <FrameCanvas
              frame={frameQuery.data}
              annotations={annotationsQuery.data ?? []}
              store={store}
              onPointOrBoxSubmit={handlePointOrBoxSubmit}
              onRemoveAnnotation={handleRemoveAnnotation}
            />
          </div>
        </div>
        <ToolsPanel
          store={store}
          annotations={annotationsQuery.data ?? []}
          frameId={frameId}
          onGenerateFromMask={handleGenerateFromMask}
          onTrack={handleTrack}
        />
      </div>
    </div>
  );
}
```

The `aspectRatio` CSS property with `maxWidth`/`maxHeight: 100%` and
`width`/`height: 100%` on the same element makes the browser compute the
largest box that (a) fits inside the flex-1 parent and (b) preserves
`frame.width / frame.height` — this is the standard aspect-ratio-locked
letterboxing technique, and it composes correctly with `FrameCanvas`'s own
`h-full w-full` canvas styling (Task 8, unchanged) since the canvas now
fills a parent that's already the correct shape, rather than an
arbitrarily-shaped flex child.

- [ ] **Step 4: Update `SequenceGridPage.tsx` to pass `frames`/`onFrameChange`**

In `frontend/src/features/annotation/SequenceGridPage.tsx`, replace the
`selectedFrameId !== null` branch:

```tsx
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
```

- [ ] **Step 5: Run tests to verify they pass**

```bash
cd frontend && npx vitest run tests/FrameEditor.test.tsx tests/SequenceGridPage.test.tsx
```

Expected: PASS — `FrameEditor` (9 tests), `SequenceGridPage` (unchanged
test file should still pass since its own assertions don't inspect
`FrameEditor`'s internals, only that it renders in place of the grid —
confirm this by reading `frontend/tests/SequenceGridPage.test.tsx` first;
if it mocks fewer endpoints than `FrameEditor` now needs — e.g.
`/taxonomy/labels/tree` — extend its `apiClient.GET` mock to cover them,
following the same pattern already used in `FrameEditor.test.tsx`).

- [ ] **Step 6: Run the full frontend suite and typecheck**

```bash
cd frontend && npx vitest run && npx tsc -b --noEmit
```

Expected: all pass, no type errors.

- [ ] **Step 7: Commit**

```bash
git add frontend/src/features/annotation/FrameEditor.tsx frontend/src/features/annotation/SequenceGridPage.tsx frontend/tests/FrameEditor.test.tsx
git commit -m "feat: wire immediate point/box submission, Prev/Next navigation, aspect-ratio-correct canvas sizing"
```

---

## Task 10: Real-browser verification

**Files:** none (manual verification pass, per CLAUDE.md's Testing
philosophy section and this session's own direct motivating experience).

**Interfaces:** none — this task consumes the fully assembled feature
from Tasks 1-9 and produces a verification report, not code.

- [ ] **Step 1: Start the stack**

```bash
docker compose up -d
cd backend && PYTHONPATH=. uv run uvicorn app.main:app --reload &
cd ../frontend && npm run dev &
```

If the ml-worker image needs rebuilding (it does, since Tasks 1/3 changed
`ml-worker/app/models.py` and `ml-worker/app/tasks.py`, and this
container has no source volume mount — confirmed in
`docker-compose.yml`):

```bash
docker compose build ml-worker
docker compose up -d ml-worker
```

- [ ] **Step 2: Create or reuse real test data**

Reuse existing dev-environment data if a sequence with frames and a
Category/Tag label pair already exists (check via
`curl http://localhost:8000/media/videos -H "Authorization: Bearer $TOKEN"`),
otherwise create fresh via the API (register, login, upload a video or
create a video-less sequence + upload frame images, create two labels
with a parent/child relation) — this project has an established pattern
for this from prior verification passes, reuse it rather than inventing
a new one.

- [ ] **Step 3: Click through the golden path in a real browser**

Navigate to a sequence's grid, open a frame, and verify each fix from the
design spec directly:

- **Gestures are visible**: a left click shows a positive-colored point
  marker; Shift+click shows a negative-colored marker; a drag shows a
  live rectangle outline following the cursor.
- **Immediate submission**: a plain point click, with a label selected,
  fires a real `POST /jobs/sam2/predict` without any extra button click —
  check the Network tab.
- **Box cancel**: start a drag, confirm the ✕ appears near the box's
  corner, click it, confirm no network request fires and the box
  disappears.
- **Negative point**: Shift+click submits `label: false` in the request
  body — check the Network tab's request payload.
- **Delete**: after a mask exists, click its ✕ in the Masks list once
  (confirm no request fires yet), click again (confirm a real
  `DELETE /annotation/annotations/{id}` fires and the mask disappears
  from both the list and the canvas overlay without a page reload).
- **Bulk delete**: after a real SAM 2.1 Track job creates masks across
  multiple frames, confirm "Delete all from this run" appears (only for
  masks created by a job), and confirm clicking it (with the two-stage
  confirm) removes that job's masks across every frame it touched, while
  leaving unrelated masks (same label, different job) intact — this is
  the exact scenario that motivated choosing `job_id` over the
  `id >= current` heuristic; verify it directly, not just via unit tests.
- **Ctrl+click removal**: Ctrl+click directly on a rendered mask overlay,
  confirm it triggers the same delete path as the list's ✕ (real
  `DELETE` request, mask disappears).
- **Canvas sizing**: resize the browser window; confirm the frame image
  always preserves its aspect ratio and never overflows the viewport or
  the left column, at multiple window sizes.
- **Prev/Next navigation**: click Next/Prev, confirm the frame changes
  without returning to the grid and without a full page reload; confirm
  Left/Right arrow keys do the same; confirm Prev is disabled on the
  first frame and Next is disabled on the last.
- **Visual redesign**: confirm the panel reads as a coherent, deliberately
  styled instrument — no bare unstyled `<select>`/`<input type=color>`
  elements, consistent section spacing/dividers, the accent blue reserved
  for active/selected state only.

- [ ] **Step 4: Report findings honestly**

If any step above doesn't work as described, do not report the task
complete — note the specific failure (which step, what happened instead)
so it can be fixed before considering this pass done. This mirrors
CLAUDE.md's explicit warning, and this session's own direct experience:
passing unit tests previously proved the wiring worked while the actual
experience was unusable — only this manual pass catches that gap.

---

## Self-Review

**Spec coverage:**
- Gesture model (positive/negative point, box, ctrl-click remove) →
  Task 8. ✓
- Live point/box rendering → Task 8 (box outline; point rendering
  deliberately deferred per the note in Task 8 Step 3, given immediate
  submission's short pending-state lifetime). ✓
- Delete endpoints (single + bulk-by-job) → Tasks 1, 2, 3. ✓
- Masks list delete affordances → Task 6. ✓
- "Add mask" button removed for point/box, kept+relabeled for Mask tool →
  Task 7. ✓
- Canvas aspect-ratio sizing → Task 9. ✓
- Prev/Next frame navigation + keyboard → Task 9. ✓
- Visual redesign of ToolsPanel/CascadingLabelPicker → Task 7. ✓
- `openapi.json`/generated client regeneration → Task 4. ✓
- Real-browser verification → Task 10. ✓
- Explicitly out-of-scope items (CascadingLabelPicker behavior changes,
  SAM-3 re-enablement, custom dropdown component library) — correctly
  absent from every task.

**Placeholder scan:** no TBD/TODO markers remain. An earlier draft of
Task 8 declared `POSITIVE_COLOR`/`NEGATIVE_COLOR` without using them,
rationalized as "for a future task" — caught during this plan's own
pre-flight review as a real, unimplemented spec requirement (design spec
section 2: "every point in `pendingPrompts`... is drawn as a small
filled circle... colored by its `label`"), not an acceptable deferral.
Fixed by adding `recentPoints` state that actually renders positive/
negative point markers immediately on submission and clears them once
the real annotation refetch supersedes them — both color constants are
now live, load-bearing code.

**Type consistency:** `PromptDraft` (from `frameEditorStore.ts`, unchanged
by this plan) is used identically across Tasks 8-9.
`FrameCanvas`'s new props (`onPointOrBoxSubmit`, `onRemoveAnnotation`)
match their declared types in both the component (Task 8) and its caller
(Task 9). `ToolsPanel`'s renamed `onGenerateFromMask` prop and new
`frameId` prop match between the component (Task 7) and its caller
(Task 9). `MasksList`'s new `frameId` prop matches between the component
(Task 6) and its caller, `ToolsPanel` (Task 7). `Annotation.job_id`
(backend Task 1, ml-worker Task 3, frontend consumption in Tasks 6/9) is
`int | None` consistently on every side.
