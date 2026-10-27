# Frame Editor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a real frame editor (SAM 2.1-driven point/box/mask prompts,
cascading label picker, track controls, masks list) replacing the
`SegmentButton.tsx` placeholder, plus a minimal sequence grid to reach it,
plus four small backend additions the editor needs and that the current
API doesn't yet expose.

**Architecture:** Backend gains four additive, independently testable
pieces (video-less sequences, videos→sequences listing, a cascading label
tree endpoint, mask URLs on annotations) — no existing endpoint changes
shape. Frontend adds a `SequenceGridPage` (thumbnail grid, in-place swap
to editor) and a `FrameEditor` built around a Zustand store shared by a
hand-rolled `<canvas>`, a cascading label picker, track controls, and a
masks list — SAM 2.1 is the only live model path this session; SAM-3
renders as a disabled tab (VRAM-limited on current hardware).

**Tech Stack:** FastAPI + SQLAlchemy + Alembic + pytest (backend), React +
TypeScript + Zustand + TanStack Query + Vitest/Testing Library (frontend),
openapi-typescript for the generated client.

## Global Constraints

- English only in all code, comments, docstrings, UI copy — no Russian in
  committed content.
- Dark theme only — no light-background Tailwind classes.
- All binary media goes through `backend/app/storage.py`'s
  `StorageService` — no direct filesystem paths in domain code.
- Any data referencing a `Label` carries the `taxonomy_version` that
  `Label` had at creation time — never re-derived later.
- Frontend calls the backend only through `apiClient`
  (`frontend/src/shared/api/client.ts`) against the generated
  `schema.d.ts` — never a hand-rolled untyped `fetch()`.
- TDD: every backend task and every frontend task with logic gets a
  failing test before the implementation.
- SAM-3 tab renders but is disabled this session (GPU VRAM insufficient
  on current hardware) — no SAM-3 job-submission wiring or job-flow tests.

---

## File Structure

Backend (all additive to existing modules, following their established
one-router-one-service-per-module pattern):

- `backend/app/media/models.py` — `Sequence.video_id` becomes nullable,
  gains `procedure_id`.
- `backend/app/media/schemas.py` — `SequenceCreateStandalone`,
  `SequenceRead.procedure_id` added.
- `backend/app/media/router.py` — new `POST /media/sequences`,
  `GET /media/videos/{video_id}/sequences`,
  `GET /media/procedures/{id}/sequences`.
- `backend/alembic/versions/<rev>_sequence_video_nullable_procedure.py` —
  new migration.
- `backend/app/taxonomy/schemas.py` — `LabelTreeNode`.
- `backend/app/taxonomy/service.py` — `get_label_tree`.
- `backend/app/taxonomy/router.py` — new `GET /taxonomy/labels/tree`.
- `backend/app/annotation/schemas.py` — `AnnotationRead.mask_url`.
- `backend/app/annotation/router.py` — `_annotation_read` helper
  resolving `mask_url` via `StorageService`, both endpoints updated to use
  it.

Frontend (new `features/annotation/` files unless noted; entity hooks in
`entities/`):

- `frontend/src/entities/useSequences.ts` — `useSequencesForVideo`,
  `useCreateStandaloneSequence`.
- `frontend/src/entities/useLabelTree.ts` — `useLabelTree`.
- `frontend/src/features/annotation/SequenceGridPage.tsx`.
- `frontend/src/features/annotation/FrameThumbnail.tsx`.
- `frontend/src/features/annotation/frameEditorStore.ts` — Zustand store
  + hook factory (`createFrameEditorStore`), scoped per mount.
- `frontend/src/features/annotation/FrameEditor.tsx` — owns the store
  instance, two-column layout, replaces `SegmentButton` usage.
- `frontend/src/features/annotation/FrameCanvas.tsx`.
- `frontend/src/features/annotation/ToolsPanel.tsx`.
- `frontend/src/features/annotation/CascadingLabelPicker.tsx`.
- `frontend/src/features/annotation/MasksList.tsx`.
- `frontend/src/features/annotation/TrackControls.tsx`.
- `frontend/src/app/App.tsx` — route changes: add
  `/videos/:videoId/sequences/:sequenceId`, remove or repoint
  `/frames/:frameId` (see Task 14).
- `frontend/src/features/annotation/SegmentButton.tsx` — deleted (Task 14).
- `frontend/src/features/annotation/FrameAnnotationPage.tsx` — deleted
  (Task 14), replaced by `FrameEditor` reached via the grid.

---

## Task 1: Migration — `Sequence.video_id` nullable + `procedure_id`

**Files:**
- Modify: `backend/app/media/models.py`
- Create: `backend/alembic/versions/<new_rev>_sequence_video_nullable_procedure.py`
- Test: `backend/tests/test_media.py`

**Interfaces:**
- Produces: `Sequence.video_id: int | None`, `Sequence.procedure_id: int | None`
  (FK to `procedures.id`), consumed by Task 2's service functions and
  Task 3's schemas.

- [ ] **Step 1: Write the failing test**

Add to `backend/tests/test_media.py`:

```python
def test_sequence_can_be_created_without_a_video():
    headers = _auth_headers()
    procedure_response = client.post(
        "/taxonomy/procedures", json={"name": "Standalone import"}, headers=headers
    )
    procedure_id = procedure_response.json()["id"]

    from app.db import SessionLocal
    from app.media.models import Sequence

    session = SessionLocal()
    try:
        sequence = Sequence(video_id=None, procedure_id=procedure_id, start_time=0, duration=0)
        session.add(sequence)
        session.commit()
        session.refresh(sequence)
        assert sequence.id > 0
        assert sequence.video_id is None
        assert sequence.procedure_id == procedure_id
    finally:
        session.close()
```

Check `backend/app/db.py` for the actual session factory name before
writing this — use whatever `get_session`'s underlying factory is called
(likely `SessionLocal`; if it's named differently, use that name instead,
the rest of the test is unaffected).

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && uv run pytest tests/test_media.py::test_sequence_can_be_created_without_a_video -v`
Expected: FAIL — `IntegrityError` (NOT NULL constraint on `video_id`) or
`AttributeError` (`procedure_id` doesn't exist on `Sequence`).

- [ ] **Step 3: Update the model**

In `backend/app/media/models.py`, change:

```python
class Sequence(Base):
    __tablename__ = "sequences"

    id: Mapped[int] = mapped_column(primary_key=True)
    video_id: Mapped[int] = mapped_column(ForeignKey("videos.id"))
    start_time: Mapped[int] = mapped_column(Integer, default=0)
    duration: Mapped[int] = mapped_column(Integer, default=0)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=lambda: datetime.now(timezone.utc)
    )
```

to:

```python
class Sequence(Base):
    __tablename__ = "sequences"

    id: Mapped[int] = mapped_column(primary_key=True)
    video_id: Mapped[int | None] = mapped_column(ForeignKey("videos.id"), nullable=True)
    procedure_id: Mapped[int | None] = mapped_column(ForeignKey("procedures.id"), nullable=True)
    start_time: Mapped[int] = mapped_column(Integer, default=0)
    duration: Mapped[int] = mapped_column(Integer, default=0)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=lambda: datetime.now(timezone.utc)
    )
```

- [ ] **Step 4: Write the migration**

Run: `cd backend && uv run alembic revision -m "sequence video nullable procedure"`

This prints the generated revision file path with its auto-generated
revision id — open it and replace its contents with:

```python
"""sequence video nullable procedure

Revision ID: <keep the id alembic generated>
Revises: a9ad82e131f0
Create Date: <keep the date alembic generated>

"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision: str = "<keep the id alembic generated>"
down_revision: Union[str, Sequence[str], None] = "a9ad82e131f0"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.alter_column("sequences", "video_id", existing_type=sa.Integer(), nullable=True)
    op.add_column("sequences", sa.Column("procedure_id", sa.Integer(), nullable=True))
    op.create_foreign_key(
        "fk_sequences_procedure_id_procedures",
        "sequences",
        "procedures",
        ["procedure_id"],
        ["id"],
    )


def downgrade() -> None:
    op.drop_constraint("fk_sequences_procedure_id_procedures", "sequences", type_="foreignkey")
    op.drop_column("sequences", "procedure_id")
    op.alter_column("sequences", "video_id", existing_type=sa.Integer(), nullable=False)
```

Keep alembic's own generated `revision`, `down_revision` (confirm it
points to `a9ad82e131f0`, the most recent existing migration — check
`backend/alembic/versions/` if a newer one has landed since this plan was
written), and `Create Date` values — only the body above is prescriptive.

- [ ] **Step 5: Apply the migration to both databases**

Run:
```bash
cd backend
uv run alembic upgrade head
DATABASE_URL=postgresql://endoscopy:endoscopy@localhost:5432/endoscopy_test uv run alembic upgrade head
```

Check `backend/app/config.py` or `.env` for the actual test-database
env var name/connection string pattern before running the second command
— use whatever this repo's test suite actually reads.

- [ ] **Step 6: Run test to verify it passes**

Run: `cd backend && uv run pytest tests/test_media.py::test_sequence_can_be_created_without_a_video -v`
Expected: PASS

- [ ] **Step 7: Run full backend suite to confirm no regression**

Run: `cd backend && uv run pytest -v`
Expected: all tests pass (existing `test_create_sequence_extracts_frames`
etc. still create sequences with a `video_id` and must be unaffected).

- [ ] **Step 8: Commit**

```bash
git add backend/app/media/models.py backend/alembic/versions/ backend/tests/test_media.py
git commit -m "feat: make Sequence.video_id nullable, add procedure_id for video-less sequences"
```

---

## Task 2: `POST /media/sequences` (video-less create) + `frames/upload`

**Files:**
- Modify: `backend/app/media/schemas.py`
- Modify: `backend/app/media/router.py`
- Test: `backend/tests/test_media.py`
- Fixture (already present, created during plan pre-flight review — do
  not regenerate it): `backend/tests/fixtures/tiny_frame.png` (a real
  4x4 RGB PNG, valid for `PIL.Image.open`)

**Interfaces:**
- Consumes: `Sequence.procedure_id`, `Sequence.video_id: int | None` (Task 1).
- Produces: `SequenceCreateStandalone(procedure_id: int, start_time: int = 0, duration: int = 0)`,
  `POST /media/sequences` → `SequenceRead`,
  `POST /media/sequences/{id}/frames/upload` (multipart, one `file` field)
  → `FrameRead`, consumed by no other task this plan (frontend doesn't
  wire this up this session per the design spec's explicit scope note).

- [ ] **Step 1: Write the failing tests**

Add to `backend/tests/test_media.py`:

```python
def test_create_standalone_sequence_without_video():
    headers = _auth_headers()
    procedure_id = client.post(
        "/taxonomy/procedures", json={"name": "Downloaded polyp set"}, headers=headers
    ).json()["id"]

    response = client.post(
        "/media/sequences", json={"procedure_id": procedure_id}, headers=headers
    )

    assert response.status_code == 201
    body = response.json()
    assert body["video_id"] is None
    assert body["procedure_id"] == procedure_id


def test_upload_frame_to_standalone_sequence():
    headers = _auth_headers()
    procedure_id = client.post(
        "/taxonomy/procedures", json={"name": "Downloaded polyp set 2"}, headers=headers
    ).json()["id"]
    sequence_id = client.post(
        "/media/sequences", json={"procedure_id": procedure_id}, headers=headers
    ).json()["id"]

    fixture = Path(__file__).parent / "fixtures" / "tiny_frame.png"
    with open(fixture, "rb") as f:
        response = client.post(
            f"/media/sequences/{sequence_id}/frames/upload",
            files={"file": ("frame_0.png", f, "image/png")},
            headers=headers,
        )

    assert response.status_code == 201
    body = response.json()
    assert body["sequence_id"] == sequence_id
    assert body["image_url"].startswith("http")


def test_create_standalone_sequence_requires_procedure_id():
    headers = _auth_headers()
    response = client.post("/media/sequences", json={}, headers=headers)
    assert response.status_code == 422
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd backend && uv run pytest tests/test_media.py -k standalone -v`
Expected: FAIL — 404 (routes don't exist yet).

- [ ] **Step 3: Add the schema**

In `backend/app/media/schemas.py`, add:

```python
class SequenceCreateStandalone(BaseModel):
    procedure_id: int
    start_time: int = 0
    duration: int = 0
```

Update `SequenceRead` to include the two new fields:

```python
class SequenceRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: int
    video_id: int | None
    procedure_id: int | None
    start_time: int
    duration: int
```

- [ ] **Step 4: Add the endpoints**

In `backend/app/media/router.py`, add imports for `Procedure` (from
`app.taxonomy.models`) and `SequenceCreateStandalone`, then add:

```python
@router.post("/sequences", response_model=SequenceRead, status_code=status.HTTP_201_CREATED)
def create_standalone_sequence(
    payload: SequenceCreateStandalone,
    session: Session = Depends(get_session),
) -> Sequence:
    procedure = session.get(Procedure, payload.procedure_id)
    if procedure is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Procedure not found")

    sequence = Sequence(
        video_id=None,
        procedure_id=payload.procedure_id,
        start_time=payload.start_time,
        duration=payload.duration,
    )
    session.add(sequence)
    session.commit()
    session.refresh(sequence)
    return sequence


@router.post(
    "/sequences/{sequence_id}/frames/upload",
    response_model=FrameRead,
    status_code=status.HTTP_201_CREATED,
)
async def upload_standalone_frame(
    sequence_id: int,
    file: UploadFile,
    session: Session = Depends(get_session),
    storage: StorageService = Depends(get_storage_service),
) -> FrameRead:
    sequence = session.get(Sequence, sequence_id)
    if sequence is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Sequence not found")

    data = await file.read()
    existing_count = session.query(Frame).filter(Frame.sequence_id == sequence_id).count()
    frame_index = existing_count
    storage_key = f"frames/{sequence_id}/{frame_index}.png"
    storage.upload(storage_key, data, content_type="image/png")

    from PIL import Image
    import io
    with Image.open(io.BytesIO(data)) as img:
        width, height = img.size

    frame = Frame(
        sequence_id=sequence_id,
        storage_key=storage_key,
        frame_index=frame_index,
        width=width,
        height=height,
    )
    session.add(frame)
    session.commit()
    session.refresh(frame)
    return _frame_read(frame, storage)
```

Check `backend/pyproject.toml` (or `uv.lock`) for whether `Pillow` is
already a dependency before using `PIL.Image` — `ml-worker` likely
depends on it but `backend` may not. If it isn't in `backend`'s own
dependency list, run `cd backend && uv add pillow` first (it's a small,
justified addition: the endpoint needs real width/height from the
uploaded bytes, matching what `extract_frames` already provides for the
video path — don't hardcode/omit these fields).

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd backend && uv run pytest tests/test_media.py -v`
Expected: all pass, including the 3 new tests and all pre-existing ones
(the `SequenceRead` field addition must not break
`test_create_sequence_extracts_frames`, which reads `body["id"]` etc. but
doesn't currently assert on the full shape — confirm by reading that
test's assertions if it fails).

- [ ] **Step 6: Commit**

```bash
git add backend/app/media/schemas.py backend/app/media/router.py backend/tests/test_media.py backend/pyproject.toml backend/uv.lock
git commit -m "feat: add video-less sequence creation and standalone frame upload"
```

---

## Task 3: `GET /media/videos/{video_id}/sequences` and `GET /media/procedures/{id}/sequences`

**Files:**
- Modify: `backend/app/media/router.py`
- Test: `backend/tests/test_media.py`

**Interfaces:**
- Consumes: `SequenceRead` (Task 2).
- Produces: `GET /media/videos/{video_id}/sequences` → `list[SequenceRead]`,
  `GET /media/procedures/{id}/sequences` → `list[SequenceRead]`, consumed
  by Task 8's `useSequencesForVideo` frontend hook.

- [ ] **Step 1: Write the failing tests**

Add to `backend/tests/test_media.py`:

```python
def test_list_sequences_for_video():
    headers = _auth_headers()
    with open(FIXTURE_VIDEO, "rb") as f:
        video_id = client.post(
            "/media/videos",
            files={"file": ("tiny.mp4", f, "video/mp4")},
            data={"title": "Sequence listing source"},
            headers=headers,
        ).json()["id"]

    sequence_id = client.post(
        f"/media/videos/{video_id}/sequences",
        json={"start_time": 0, "duration": 2},
        headers=headers,
    ).json()["id"]

    response = client.get(f"/media/videos/{video_id}/sequences", headers=headers)

    assert response.status_code == 200
    ids = [s["id"] for s in response.json()]
    assert sequence_id in ids


def test_list_sequences_for_procedure():
    headers = _auth_headers()
    procedure_id = client.post(
        "/taxonomy/procedures", json={"name": "Listing procedure"}, headers=headers
    ).json()["id"]
    sequence_id = client.post(
        "/media/sequences", json={"procedure_id": procedure_id}, headers=headers
    ).json()["id"]

    response = client.get(f"/media/procedures/{procedure_id}/sequences", headers=headers)

    assert response.status_code == 200
    ids = [s["id"] for s in response.json()]
    assert sequence_id in ids
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd backend && uv run pytest tests/test_media.py -k "list_sequences" -v`
Expected: FAIL — 404.

- [ ] **Step 3: Add the endpoints**

In `backend/app/media/router.py`, add:

```python
@router.get("/videos/{video_id}/sequences", response_model=list[SequenceRead])
def list_sequences_for_video(video_id: int, session: Session = Depends(get_session)) -> list[Sequence]:
    return session.query(Sequence).filter(Sequence.video_id == video_id).all()


@router.get("/procedures/{procedure_id}/sequences", response_model=list[SequenceRead])
def list_sequences_for_procedure(procedure_id: int, session: Session = Depends(get_session)) -> list[Sequence]:
    return session.query(Sequence).filter(Sequence.procedure_id == procedure_id).all()
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd backend && uv run pytest tests/test_media.py -v`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add backend/app/media/router.py backend/tests/test_media.py
git commit -m "feat: list sequences by video and by procedure"
```

---

## Task 4: `GET /taxonomy/labels/tree`

**Files:**
- Modify: `backend/app/taxonomy/schemas.py`
- Modify: `backend/app/taxonomy/service.py`
- Modify: `backend/app/taxonomy/router.py`
- Test: `backend/tests/test_taxonomy.py`

**Interfaces:**
- Consumes: `Label`, `LabelRelation` (existing models, unchanged).
- Produces: `LabelTreeNode(category: LabelRead, children: list[LabelRead])`,
  `GET /taxonomy/labels/tree` → `list[LabelTreeNode]`, consumed by Task 9's
  `useLabelTree` frontend hook and Task 12's `CascadingLabelPicker`.

- [ ] **Step 1: Write the failing test**

Add to `backend/tests/test_taxonomy.py`:

```python
def test_label_tree_groups_children_under_root_labels():
    token = _auth_headers(_register_and_login("tax4@example.com"))

    lesion = client.post(
        "/taxonomy/labels", json={"name": "lesion", "label_type": "geometric"}, headers=token
    ).json()
    polyp_shape = client.post(
        "/taxonomy/labels", json={"name": "0-Ip", "label_type": "geometric"}, headers=token
    ).json()
    landmark = client.post(
        "/taxonomy/labels", json={"name": "landmark", "label_type": "geometric"}, headers=token
    ).json()

    client.post(
        "/taxonomy/labels/relations",
        json={"parent_id": lesion["id"], "child_id": polyp_shape["id"], "confidence": 1.0},
        headers=token,
    )

    response = client.get("/taxonomy/labels/tree", headers=token)

    assert response.status_code == 200
    tree = response.json()
    lesion_node = next(node for node in tree if node["category"]["id"] == lesion["id"])
    assert [child["id"] for child in lesion_node["children"]] == [polyp_shape["id"]]

    landmark_node = next(node for node in tree if node["category"]["id"] == landmark["id"])
    assert landmark_node["children"] == []

    # polyp_shape is a child, not a root -- it must not appear as its own
    # top-level category node.
    assert all(node["category"]["id"] != polyp_shape["id"] for node in tree)
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && uv run pytest tests/test_taxonomy.py::test_label_tree_groups_children_under_root_labels -v`
Expected: FAIL — 404.

- [ ] **Step 3: Add the schema**

In `backend/app/taxonomy/schemas.py`, add:

```python
class LabelTreeNode(BaseModel):
    category: LabelRead
    children: list[LabelRead]
```

- [ ] **Step 4: Add the service function**

In `backend/app/taxonomy/service.py`, add:

```python
def get_label_tree(session: Session) -> list[dict]:
    child_ids_query = text("SELECT DISTINCT child_id FROM label_relations")
    child_ids = {row.child_id for row in session.execute(child_ids_query).fetchall()}

    all_labels = session.query(Label).all()
    roots = [label for label in all_labels if label.id not in child_ids]

    relations_query = text("SELECT parent_id, child_id FROM label_relations")
    relations = session.execute(relations_query).fetchall()
    children_by_parent: dict[int, list[int]] = {}
    for row in relations:
        children_by_parent.setdefault(row.parent_id, []).append(row.child_id)

    labels_by_id = {label.id: label for label in all_labels}

    tree = []
    for root in roots:
        child_labels = [
            labels_by_id[child_id]
            for child_id in children_by_parent.get(root.id, [])
            if child_id in labels_by_id
        ]
        tree.append({"category": root, "children": child_labels})
    return tree
```

- [ ] **Step 5: Add the endpoint**

In `backend/app/taxonomy/router.py`, import `LabelTreeNode` and
`get_label_tree`, then add (before the `{label_id}/descendants` route so
FastAPI doesn't try to match `tree` as a `label_id` path param — actually
irrelevant here since `tree` is under a different path segment, but place
it near the other `/labels` routes for readability):

```python
@router.get("/labels/tree", response_model=list[LabelTreeNode])
def label_tree(session: Session = Depends(get_session)) -> list[dict]:
    return get_label_tree(session)
```

- [ ] **Step 6: Run test to verify it passes**

Run: `cd backend && uv run pytest tests/test_taxonomy.py -v`
Expected: all pass.

- [ ] **Step 7: Commit**

```bash
git add backend/app/taxonomy/schemas.py backend/app/taxonomy/service.py backend/app/taxonomy/router.py backend/tests/test_taxonomy.py
git commit -m "feat: add GET /taxonomy/labels/tree for cascading label picker"
```

---

## Task 5: `AnnotationRead.mask_url`

**Files:**
- Modify: `backend/app/annotation/schemas.py`
- Modify: `backend/app/annotation/router.py`
- Test: `backend/tests/test_annotation.py`

**Interfaces:**
- Consumes: `Annotation.storage_key` (existing), `StorageService.url_for`
  (existing, `backend/app/storage.py:40`).
- Produces: `AnnotationRead.mask_url: str | None`, consumed by Task 11's
  `FrameCanvas` (mask overlay) and Task 13's `MasksList`.

- [ ] **Step 1: Write the failing test**

Add to `backend/tests/test_annotation.py`. This needs a mask annotation
with a `storage_key`, which the router currently has no way to create
directly (only jobs create mask annotations via `ml-worker`) — write the
row directly via the DB session, matching how `test_media.py`'s new
standalone-sequence test above accesses `SessionLocal`/DB session
directly when there's no HTTP path for the setup it needs:

```python
def test_list_annotations_includes_mask_url_when_storage_key_present():
    token = _register_and_login("annot5@example.com")
    frame_id = _create_frame(token)
    label_id = _create_label(token)

    from app.annotation.models import Annotation, AnnotationStatus, AnnotationType
    from app.auth.models import User
    from app.db import SessionLocal

    session = SessionLocal()
    try:
        user = session.query(User).filter(User.email == "annot5@example.com").one()
        annotation = Annotation(
            frame_id=frame_id,
            label_id=label_id,
            taxonomy_version=1,
            annotation_type=AnnotationType.MASK,
            status=AnnotationStatus.DRAFT,
            created_by_id=user.id,
            storage_key="masks/test-mask.png",
        )
        session.add(annotation)
        session.commit()
    finally:
        session.close()

    response = client.get(f"/annotation/frames/{frame_id}/annotations", headers=_headers(token))

    assert response.status_code == 200
    mask_annotation = next(a for a in response.json() if a["annotation_type"] == "mask")
    assert mask_annotation["mask_url"] is not None
    assert mask_annotation["mask_url"].startswith("http")


def test_annotation_mask_url_is_null_for_classification_annotations():
    token = _register_and_login("annot6@example.com")
    frame_id = _create_frame(token)
    label_id = _create_label(token)
    client.post(f"/annotation/frames/{frame_id}/annotations", json={"label_id": label_id}, headers=_headers(token))

    response = client.get(f"/annotation/frames/{frame_id}/annotations", headers=_headers(token))

    assert response.status_code == 200
    assert response.json()[0]["mask_url"] is None
```

Check `backend/app/db.py` for the real session factory name (as in Task
1) before using `SessionLocal` — adjust the import if it's named
differently.

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd backend && uv run pytest tests/test_annotation.py -k mask_url -v`
Expected: FAIL — `KeyError`/`AssertionError` (`mask_url` missing from
response body).

- [ ] **Step 3: Update the schema**

In `backend/app/annotation/schemas.py`, add `mask_url` to `AnnotationRead`:

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
```

- [ ] **Step 4: Compute `mask_url` in the router**

In `backend/app/annotation/router.py`, add a helper and use it in both
GET-shaped responses (the POST response for a fresh classification
annotation always has `storage_key=None`, so it's fine for
`create_annotation` to keep returning the ORM object directly — FastAPI's
`response_model` will serialize `mask_url` as `None` via the schema
default; only `list_annotations`, which is the one place existing mask
annotations get read back, needs the explicit computed field):

```python
from app.storage import StorageService, get_storage_service


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
    )


@router.get("/frames/{frame_id}/annotations", response_model=list[AnnotationRead])
def list_annotations(
    frame_id: int,
    session: Session = Depends(get_session),
    storage: StorageService = Depends(get_storage_service),
) -> list[AnnotationRead]:
    annotations = session.query(Annotation).filter(Annotation.frame_id == frame_id).all()
    return [_annotation_read(annotation, storage) for annotation in annotations]
```

Leave `create_annotation` and `update_status` returning `Annotation` ORM
objects as-is — the `AnnotationRead` schema's `mask_url` default of `None`
covers them correctly since neither path ever sets `storage_key`.

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd backend && uv run pytest tests/test_annotation.py -v`
Expected: all pass.

- [ ] **Step 6: Run full backend suite**

Run: `cd backend && uv run pytest -v`
Expected: all pass (44+ tests, plus the new ones from Tasks 1-5).

- [ ] **Step 7: Commit**

```bash
git add backend/app/annotation/schemas.py backend/app/annotation/router.py backend/tests/test_annotation.py
git commit -m "feat: expose mask_url on AnnotationRead for mask overlay rendering"
```

---

## Task 6: Regenerate `openapi.json` and the frontend generated client

**Files:**
- Modify: `openapi.json` (repo root)

**Interfaces:**
- Consumes: all backend changes from Tasks 1-5.
- Produces: an `openapi.json` containing `/jobs/sam2/*` (already
  implemented in Phase 2a.2 but never regenerated),
  `/media/videos/{video_id}/sequences`, `/media/sequences`,
  `/media/sequences/{sequence_id}/frames/upload`,
  `/media/procedures/{id}/sequences`, `/taxonomy/labels/tree`, and
  `AnnotationRead.mask_url` — consumed by every frontend task from Task 7
  onward via `npm run generate-api`.

- [ ] **Step 1: Regenerate the committed OpenAPI schema**

Run:
```bash
cd backend && uv run python scripts/export_openapi.py
```
Expected output: `Wrote OpenAPI schema to <repo-root>/openapi.json`

- [ ] **Step 2: Verify the new paths are present**

Run: `grep -c "sam2/predict\|labels/tree\|videos/{video_id}/sequences" openapi.json`
Expected: a nonzero count (at least 3 matches).

- [ ] **Step 3: Regenerate the frontend TypeScript client**

Run: `cd frontend && npm run generate-api`
Expected: `src/shared/api/generated/schema.d.ts` rewritten (gitignored,
not committed — confirm via `git status` that only `openapi.json` shows
as changed at repo root, not anything under `frontend/src/shared/api/generated/`).

- [ ] **Step 4: Commit**

```bash
git add openapi.json
git commit -m "chore: regenerate openapi.json for SAM 2.1 and frame editor endpoints"
```

---

## Task 7: `frameEditorStore` — Zustand store

**Files:**
- Create: `frontend/src/features/annotation/frameEditorStore.ts`
- Test: `frontend/tests/frameEditorStore.test.ts`

**Interfaces:**
- Produces: `createFrameEditorStore()` returning a Zustand store with
  shape:
  ```typescript
  interface FrameEditorState {
    activeModel: "sam2" | "sam3";
    activeTool: "point" | "box" | "mask";
    pendingPrompts: PromptDraft[];
    selectedAnnotationId: number | null;
    labelCategoryId: number | null;
    labelClassification: "geometric" | "morphological" | "quality" | null;
    labelTagId: number | null;
    color: string;
    backward: number;
    forward: number;
    setActiveModel: (model: "sam2" | "sam3") => void;
    setActiveTool: (tool: "point" | "box" | "mask") => void;
    addPrompt: (prompt: PromptDraft) => void;
    clearPrompts: () => void;
    setSelectedAnnotation: (id: number | null) => void;
    setLabelSelection: (partial: Partial<{
      labelCategoryId: number | null;
      labelClassification: FrameEditorState["labelClassification"];
      labelTagId: number | null;
    }>) => void;
    setColor: (color: string) => void;
    setBackward: (value: number) => void;
    setForward: (value: number) => void;
    reset: () => void;
  }

  interface PromptDraft {
    type: "point" | "box" | "mask";
    coords: number[];
    label: boolean;
    mask_png?: string;
  }
  ```
  Consumed by Task 10 (`FrameEditor`), Task 11 (`FrameCanvas`), Task 12
  (`CascadingLabelPicker`), Task 13 (`MasksList`), Task 14
  (`TrackControls`).

- [ ] **Step 1: Write the failing test**

Create `frontend/tests/frameEditorStore.test.ts`:

```typescript
import { describe, expect, it } from "vitest";

import { createFrameEditorStore } from "../src/features/annotation/frameEditorStore";

describe("frameEditorStore", () => {
  it("defaults to the sam2 model and point tool", () => {
    const store = createFrameEditorStore();
    const state = store.getState();
    expect(state.activeModel).toBe("sam2");
    expect(state.activeTool).toBe("point");
    expect(state.backward).toBeGreaterThan(0);
    expect(state.forward).toBeGreaterThan(0);
  });

  it("accumulates prompts and clears them", () => {
    const store = createFrameEditorStore();
    store.getState().addPrompt({ type: "point", coords: [0.5, 0.5], label: true });
    expect(store.getState().pendingPrompts).toHaveLength(1);

    store.getState().clearPrompts();
    expect(store.getState().pendingPrompts).toHaveLength(0);
  });

  it("selecting an annotation fills the label selection from setLabelSelection", () => {
    const store = createFrameEditorStore();
    store.getState().setSelectedAnnotation(7);
    store.getState().setLabelSelection({ labelCategoryId: 1, labelClassification: "geometric", labelTagId: 3 });

    const state = store.getState();
    expect(state.selectedAnnotationId).toBe(7);
    expect(state.labelCategoryId).toBe(1);
    expect(state.labelClassification).toBe("geometric");
    expect(state.labelTagId).toBe(3);
  });

  it("reset clears prompts, selection, and tool back to defaults", () => {
    const store = createFrameEditorStore();
    store.getState().addPrompt({ type: "box", coords: [0, 0, 1, 1], label: true });
    store.getState().setSelectedAnnotation(3);
    store.getState().setActiveTool("mask");

    store.getState().reset();

    const state = store.getState();
    expect(state.pendingPrompts).toHaveLength(0);
    expect(state.selectedAnnotationId).toBeNull();
    expect(state.activeTool).toBe("point");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run tests/frameEditorStore.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the store**

Create `frontend/src/features/annotation/frameEditorStore.ts`:

```typescript
import { createStore } from "zustand/vanilla";

export type PromptType = "point" | "box" | "mask";
export type SegmentationModel = "sam2" | "sam3";
export type LabelClassification = "geometric" | "morphological" | "quality";

export interface PromptDraft {
  type: PromptType;
  coords: number[];
  label: boolean;
  mask_png?: string;
}

export interface FrameEditorState {
  activeModel: SegmentationModel;
  activeTool: PromptType;
  pendingPrompts: PromptDraft[];
  selectedAnnotationId: number | null;
  labelCategoryId: number | null;
  labelClassification: LabelClassification | null;
  labelTagId: number | null;
  color: string;
  backward: number;
  forward: number;
  setActiveModel: (model: SegmentationModel) => void;
  setActiveTool: (tool: PromptType) => void;
  addPrompt: (prompt: PromptDraft) => void;
  clearPrompts: () => void;
  setSelectedAnnotation: (id: number | null) => void;
  setLabelSelection: (partial: Partial<{
    labelCategoryId: number | null;
    labelClassification: LabelClassification | null;
    labelTagId: number | null;
  }>) => void;
  setColor: (color: string) => void;
  setBackward: (value: number) => void;
  setForward: (value: number) => void;
  reset: () => void;
}

const DEFAULT_BACKWARD = 5;
const DEFAULT_FORWARD = 5;
const DEFAULT_COLOR = "#22d3ee";

export function createFrameEditorStore() {
  return createStore<FrameEditorState>((set) => ({
    activeModel: "sam2",
    activeTool: "point",
    pendingPrompts: [],
    selectedAnnotationId: null,
    labelCategoryId: null,
    labelClassification: null,
    labelTagId: null,
    color: DEFAULT_COLOR,
    backward: DEFAULT_BACKWARD,
    forward: DEFAULT_FORWARD,
    setActiveModel: (model) => set({ activeModel: model }),
    setActiveTool: (tool) => set({ activeTool: tool }),
    addPrompt: (prompt) => set((state) => ({ pendingPrompts: [...state.pendingPrompts, prompt] })),
    clearPrompts: () => set({ pendingPrompts: [] }),
    setSelectedAnnotation: (id) => set({ selectedAnnotationId: id }),
    setLabelSelection: (partial) => set(partial),
    setColor: (color) => set({ color }),
    setBackward: (value) => set({ backward: value }),
    setForward: (value) => set({ forward: value }),
    reset: () =>
      set({
        activeTool: "point",
        pendingPrompts: [],
        selectedAnnotationId: null,
        labelCategoryId: null,
        labelClassification: null,
        labelTagId: null,
        color: DEFAULT_COLOR,
      }),
  }));
}

export type FrameEditorStore = ReturnType<typeof createFrameEditorStore>;
```

Uses `zustand/vanilla` (not the React hook form) since the store instance
is created once per `FrameEditor` mount and needs to be passed down —
Task 10 wraps it with `zustand/react`'s `useStore` for component
subscriptions.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd frontend && npx vitest run tests/frameEditorStore.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add frontend/src/features/annotation/frameEditorStore.ts frontend/tests/frameEditorStore.test.ts
git commit -m "feat: add frameEditorStore, a per-mount Zustand store for the frame editor"
```

---

## Task 8: `useSequencesForVideo`, `useLabelTree` entity hooks

**Files:**
- Create: `frontend/src/entities/useSequences.ts`
- Create: `frontend/src/entities/useLabelTree.ts`
- Test: `frontend/tests/useSequences.test.tsx`
- Test: `frontend/tests/useLabelTree.test.tsx`

**Interfaces:**
- Consumes: `GET /media/videos/{video_id}/sequences` (Task 3),
  `GET /taxonomy/labels/tree` (Task 4), both now typed via the
  regenerated schema (Task 6).
- Produces: `useSequencesForVideo(videoId: number)`,
  `useLabelTree()`, consumed by Task 9 (`SequenceGridPage`) and Task 12
  (`CascadingLabelPicker`) respectively.

- [ ] **Step 1: Write the failing tests**

Create `frontend/tests/useSequences.test.tsx`:

```typescript
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";

import { apiClient } from "../src/shared/api/client";
import { useSequencesForVideo } from "../src/entities/useSequences";

function wrapper({ children }: { children: ReactNode }) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}

describe("useSequencesForVideo", () => {
  it("fetches sequences for a video id", async () => {
    vi.spyOn(apiClient, "GET").mockResolvedValue({
      data: [{ id: 1, video_id: 9, procedure_id: null, start_time: 0, duration: 2 }],
      error: undefined,
      response: new Response(),
    } as never);

    const { result } = renderHook(() => useSequencesForVideo(9), { wrapper });

    await waitFor(() => expect(result.current.data).toHaveLength(1));
    expect(apiClient.GET).toHaveBeenCalledWith(
      "/media/videos/{video_id}/sequences",
      expect.objectContaining({ params: { path: { video_id: 9 } } }),
    );
  });
});
```

Create `frontend/tests/useLabelTree.test.tsx`:

```typescript
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";

import { apiClient } from "../src/shared/api/client";
import { useLabelTree } from "../src/entities/useLabelTree";

function wrapper({ children }: { children: ReactNode }) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}

describe("useLabelTree", () => {
  it("fetches the label tree", async () => {
    vi.spyOn(apiClient, "GET").mockResolvedValue({
      data: [
        {
          category: { id: 1, name: "lesion", label_type: "geometric", color: "#fff", procedure_id: null, taxonomy_version: 1 },
          children: [],
        },
      ],
      error: undefined,
      response: new Response(),
    } as never);

    const { result } = renderHook(() => useLabelTree(), { wrapper });

    await waitFor(() => expect(result.current.data).toHaveLength(1));
    expect(apiClient.GET).toHaveBeenCalledWith("/taxonomy/labels/tree", expect.anything());
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd frontend && npx vitest run tests/useSequences.test.tsx tests/useLabelTree.test.tsx`
Expected: FAIL — modules not found.

- [ ] **Step 3: Implement `useSequences.ts`**

Create `frontend/src/entities/useSequences.ts`:

```typescript
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { apiClient } from "../shared/api/client";

export function useSequencesForVideo(videoId: number) {
  return useQuery({
    queryKey: ["sequences", "video", videoId],
    queryFn: async () => {
      const result = await apiClient.GET("/media/videos/{video_id}/sequences", {
        params: { path: { video_id: videoId } },
      });
      return result.data ?? [];
    },
    enabled: Number.isFinite(videoId),
  });
}

export function useCreateStandaloneSequence() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (procedureId: number) => {
      const result = await apiClient.POST("/media/sequences", {
        body: { procedure_id: procedureId },
      });
      return result.data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["sequences"] });
    },
  });
}
```

- [ ] **Step 4: Implement `useLabelTree.ts`**

Create `frontend/src/entities/useLabelTree.ts`:

```typescript
import { useQuery } from "@tanstack/react-query";

import { apiClient } from "../shared/api/client";

export function useLabelTree() {
  return useQuery({
    queryKey: ["labels", "tree"],
    queryFn: async () => {
      const result = await apiClient.GET("/taxonomy/labels/tree", {});
      return result.data ?? [];
    },
  });
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd frontend && npx vitest run tests/useSequences.test.tsx tests/useLabelTree.test.tsx`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/entities/useSequences.ts frontend/src/entities/useLabelTree.ts frontend/tests/useSequences.test.tsx frontend/tests/useLabelTree.test.tsx
git commit -m "feat: add useSequencesForVideo and useLabelTree entity hooks"
```

---

## Task 9: `SequenceGridPage` + `FrameThumbnail`

**Files:**
- Create: `frontend/src/features/annotation/FrameThumbnail.tsx`
- Create: `frontend/src/features/annotation/SequenceGridPage.tsx`
- Test: `frontend/tests/SequenceGridPage.test.tsx`

**Interfaces:**
- Consumes: `useFrames(sequenceId)` (existing,
  `frontend/src/entities/useFrames.ts:5`), `useAnnotations(frameId)`
  (existing, `frontend/src/entities/useAnnotations.ts:5`).
- Produces: `<SequenceGridPage />` (reads `sequenceId` from the route
  param), renders `<FrameEditor frameId={...} onClose={...} />` in place
  when a thumbnail is clicked — the `FrameEditor` import is added in Task
  14 once it exists; until then this task can render a placeholder `<div>`
  in its place so the grid itself is independently testable (Task 14
  swaps the placeholder for the real import, updating this file).

- [ ] **Step 1: Write the failing test**

Create `frontend/tests/SequenceGridPage.test.tsx`:

```typescript
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { apiClient } from "../src/shared/api/client";
import { SequenceGridPage } from "../src/features/annotation/SequenceGridPage";

function renderPage() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={["/videos/1/sequences/9"]}>
        <Routes>
          <Route path="/videos/:videoId/sequences/:sequenceId" element={<SequenceGridPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("SequenceGridPage", () => {
  beforeEach(() => {
    vi.spyOn(apiClient, "GET").mockImplementation((async (path: string, options: never) => {
      if (path === "/media/sequences/{sequence_id}/frames") {
        return {
          data: [
            { id: 101, sequence_id: 9, storage_key: "frames/9/0.png", frame_index: 0, width: 100, height: 100, image_url: "https://example.test/f0.png" },
            { id: 102, sequence_id: 9, storage_key: "frames/9/1.png", frame_index: 1, width: 100, height: 100, image_url: "https://example.test/f1.png" },
          ],
          error: undefined,
          response: new Response(),
        };
      }
      if (path === "/annotation/frames/{frame_id}/annotations") {
        return { data: [], error: undefined, response: new Response() };
      }
      return { data: undefined, error: "not mocked", response: new Response() };
    }) as never);
  });

  it("renders one thumbnail per frame in the sequence", async () => {
    renderPage();

    await waitFor(() => expect(screen.getAllByRole("img")).toHaveLength(2));
  });

  it("swaps the grid for the frame editor placeholder when a thumbnail is clicked", async () => {
    renderPage();

    await waitFor(() => expect(screen.getAllByRole("img")).toHaveLength(2));
    await userEvent.click(screen.getAllByRole("img")[0]);

    await waitFor(() => expect(screen.getByTestId("frame-editor-slot")).toBeInTheDocument());
    expect(screen.queryAllByRole("img")).toHaveLength(0);
  });

  it("returns to the grid when Back to grid is clicked", async () => {
    renderPage();

    await waitFor(() => expect(screen.getAllByRole("img")).toHaveLength(2));
    await userEvent.click(screen.getAllByRole("img")[0]);
    await waitFor(() => expect(screen.getByTestId("frame-editor-slot")).toBeInTheDocument());

    await userEvent.click(screen.getByRole("button", { name: /back to grid/i }));

    await waitFor(() => expect(screen.getAllByRole("img")).toHaveLength(2));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run tests/SequenceGridPage.test.tsx`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `FrameThumbnail.tsx`**

Create `frontend/src/features/annotation/FrameThumbnail.tsx`:

```tsx
import { useAnnotations } from "../../entities/useAnnotations";

interface FrameThumbnailProps {
  frameId: number;
  imageUrl: string;
  onClick: () => void;
}

export function FrameThumbnail({ frameId, imageUrl, onClick }: FrameThumbnailProps) {
  const annotationsQuery = useAnnotations(frameId);
  const annotations = annotationsQuery.data ?? [];

  return (
    <button
      type="button"
      onClick={onClick}
      className="group relative aspect-square overflow-hidden rounded border border-gray-800 bg-gray-900"
    >
      <img src={imageUrl} alt={`Frame ${frameId}`} className="h-full w-full object-cover" />
      {annotations.length > 0 && (
        <div className="absolute inset-x-0 bottom-0 flex gap-1 truncate bg-gray-950/80 px-1 py-0.5 text-xs text-gray-200">
          {annotations.map((annotation) => (
            <span key={annotation.id}>{`● label ${annotation.label_id}`}</span>
          ))}
        </div>
      )}
    </button>
  );
}
```

The label strip shows `label ${label_id}` rather than a resolved tag name
— resolving `label_id` to a name/color needs a labels lookup this
component doesn't have wired in yet (the grid's job is navigation, not
full label display; the editor is where label names matter and it has
the cascading picker's tree data available). This is a deliberate,
narrower rendering than the UI spec's "colored dot + short tag name," left
as a known simplification rather than pulled into scope — flag it to the
user if it needs closing this session, otherwise it's a fast follow once
a shared label-lookup hook exists.

- [ ] **Step 4: Implement `SequenceGridPage.tsx`**

Create `frontend/src/features/annotation/SequenceGridPage.tsx`:

```tsx
import { useState } from "react";
import { useParams } from "react-router-dom";

import { useFrames } from "../../entities/useFrames";
import { FrameThumbnail } from "./FrameThumbnail";

export function SequenceGridPage() {
  const { sequenceId } = useParams<{ sequenceId: string }>();
  const sequenceIdNumber = Number(sequenceId);
  const [selectedFrameId, setSelectedFrameId] = useState<number | null>(null);

  const framesQuery = useFrames(sequenceIdNumber);

  if (selectedFrameId !== null) {
    return (
      <div className="min-h-screen bg-gray-950 text-gray-100">
        <div className="border-b border-gray-800 p-3">
          <button
            type="button"
            onClick={() => setSelectedFrameId(null)}
            className="rounded border border-gray-700 px-3 py-1 text-sm text-gray-200 hover:bg-gray-800"
          >
            ✕ Back to grid
          </button>
        </div>
        {/* Replaced with <FrameEditor frameId={selectedFrameId} /> once it exists (Task 14). */}
        <div data-testid="frame-editor-slot" />
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-950 p-8 text-gray-100">
      <h1 className="mb-4 text-xl font-semibold">Sequence #{sequenceId}</h1>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5">
        {(framesQuery.data ?? []).map((frame) => (
          <FrameThumbnail
            key={frame.id}
            frameId={frame.id}
            imageUrl={frame.image_url}
            onClick={() => setSelectedFrameId(frame.id)}
          />
        ))}
      </div>
    </div>
  );
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd frontend && npx vitest run tests/SequenceGridPage.test.tsx`
Expected: PASS (3 tests).

- [ ] **Step 6: Commit**

```bash
git add frontend/src/features/annotation/FrameThumbnail.tsx frontend/src/features/annotation/SequenceGridPage.tsx frontend/tests/SequenceGridPage.test.tsx
git commit -m "feat: add sequence grid screen with in-place frame editor slot"
```

---

## Task 10: `FrameCanvas` — rendering and gesture capture

**Files:**
- Create: `frontend/src/features/annotation/FrameCanvas.tsx`
- Test: `frontend/tests/FrameCanvas.test.tsx`

**Interfaces:**
- Consumes: `FrameEditorStore` (Task 7) via `useStore` from
  `zustand/react`, a frame's `image_url`/`width`/`height`
  (`components["schemas"]["FrameRead"]`), a list of
  `components["schemas"]["AnnotationRead"]` (for mask overlays,
  `mask_url` from Task 5).
- Produces: `<FrameCanvas frame={FrameRead} annotations={AnnotationRead[]} store={FrameEditorStore} />`,
  consumed by Task 15 (`FrameEditor`).

- [ ] **Step 1: Write the failing tests**

Create `frontend/tests/FrameCanvas.test.tsx`:

```typescript
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

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

describe("FrameCanvas", () => {
  it("adds a point prompt to the store on left click", () => {
    const store = createFrameEditorStore();
    render(<FrameCanvas frame={FRAME} annotations={[]} store={store} />);

    const canvas = screen.getByTestId("frame-canvas");
    Object.defineProperty(canvas, "getBoundingClientRect", {
      value: () => ({ left: 0, top: 0, width: 400, height: 200 }),
    });
    fireEvent.mouseDown(canvas, { clientX: 200, clientY: 100, button: 0 });
    fireEvent.mouseUp(canvas, { clientX: 200, clientY: 100, button: 0 });

    const prompts = store.getState().pendingPrompts;
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toEqual({ type: "point", coords: [0.5, 0.5], label: true });
  });

  it("adds a box prompt to the store on left-click-drag", () => {
    const store = createFrameEditorStore();
    render(<FrameCanvas frame={FRAME} annotations={[]} store={store} />);

    const canvas = screen.getByTestId("frame-canvas");
    Object.defineProperty(canvas, "getBoundingClientRect", {
      value: () => ({ left: 0, top: 0, width: 400, height: 200 }),
    });
    fireEvent.mouseDown(canvas, { clientX: 40, clientY: 20, button: 0 });
    fireEvent.mouseMove(canvas, { clientX: 200, clientY: 100, button: 0 });
    fireEvent.mouseUp(canvas, { clientX: 200, clientY: 100, button: 0 });

    const prompts = store.getState().pendingPrompts;
    expect(prompts).toHaveLength(1);
    expect(prompts[0].type).toBe("box");
    expect(prompts[0].coords).toEqual([0.1, 0.1, 0.5, 0.5]);
  });

  it("does not add a prompt for a plain click when ctrl is held (remove gesture, no shape under cursor)", () => {
    const store = createFrameEditorStore();
    render(<FrameCanvas frame={FRAME} annotations={[]} store={store} />);

    const canvas = screen.getByTestId("frame-canvas");
    Object.defineProperty(canvas, "getBoundingClientRect", {
      value: () => ({ left: 0, top: 0, width: 400, height: 200 }),
    });
    fireEvent.mouseDown(canvas, { clientX: 200, clientY: 100, button: 0, ctrlKey: true });
    fireEvent.mouseUp(canvas, { clientX: 200, clientY: 100, button: 0, ctrlKey: true });

    expect(store.getState().pendingPrompts).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd frontend && npx vitest run tests/FrameCanvas.test.tsx`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `FrameCanvas.tsx`**

Create `frontend/src/features/annotation/FrameCanvas.tsx`:

```tsx
import { useEffect, useRef, useState } from "react";
import { useStore } from "zustand/react";

import type { components } from "../../shared/api/generated/schema";
import type { FrameEditorStore } from "./frameEditorStore";

type Frame = components["schemas"]["FrameRead"];
type Annotation = components["schemas"]["AnnotationRead"];

interface FrameCanvasProps {
  frame: Frame;
  annotations: Annotation[];
  store: FrameEditorStore;
}

interface DragState {
  startX: number;
  startY: number;
}

export function FrameCanvas({ frame, annotations, store }: FrameCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const dragRef = useRef<DragState | null>(null);
  const [frameImage, setFrameImage] = useState<HTMLImageElement | null>(null);

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

    for (const annotation of annotations) {
      if (!annotation.mask_url) continue;
      const maskImg = new Image();
      maskImg.crossOrigin = "anonymous";
      maskImg.onload = () => {
        ctx.globalAlpha = annotation.id === selectedAnnotationId ? 0.85 : 0.5;
        ctx.drawImage(maskImg, 0, 0, canvas.width, canvas.height);
        ctx.globalAlpha = 1;
      };
      maskImg.src = annotation.mask_url;
    }
  }, [frameImage, frame.width, frame.height, annotations, selectedAnnotationId]);

  function toNormalized(clientX: number, clientY: number): [number, number] {
    const canvas = canvasRef.current;
    if (!canvas) return [0, 0];
    const rect = canvas.getBoundingClientRect();
    const x = (clientX - rect.left) / rect.width;
    const y = (clientY - rect.top) / rect.height;
    return [Math.min(1, Math.max(0, x)), Math.min(1, Math.max(0, y))];
  }

  function handleMouseDown(event: React.MouseEvent<HTMLCanvasElement>) {
    if (event.button !== 0) return;
    if (event.ctrlKey) return; // remove-shape gesture, handled on mouseup below
    const [x, y] = toNormalized(event.clientX, event.clientY);
    dragRef.current = { startX: x, startY: y };
  }

  function handleMouseUp(event: React.MouseEvent<HTMLCanvasElement>) {
    if (event.button !== 0) return;
    const drag = dragRef.current;
    dragRef.current = null;

    if (event.ctrlKey) {
      // Remove-shape gesture: no hit-testing wired to canvas clicks yet --
      // removal is handled by the masks list (Task 13) via its own
      // selection + delete affordance, not by clicking the canvas.
      return;
    }
    if (!drag || activeTool === "mask") return;

    const [endX, endY] = toNormalized(event.clientX, event.clientY);
    const dx = Math.abs(endX - drag.startX);
    const dy = Math.abs(endY - drag.startY);
    const isDrag = dx > 0.01 || dy > 0.01;

    if (isDrag) {
      addPrompt({
        type: "box",
        coords: [
          Math.min(drag.startX, endX),
          Math.min(drag.startY, endY),
          Math.max(drag.startX, endX),
          Math.max(drag.startY, endY),
        ],
        label: true,
      });
    } else {
      addPrompt({ type: "point", coords: [drag.startX, drag.startY], label: true });
    }
  }

  return (
    <canvas
      ref={canvasRef}
      data-testid="frame-canvas"
      onMouseDown={handleMouseDown}
      onMouseUp={handleMouseUp}
      className="h-full w-full cursor-crosshair bg-gray-900"
    />
  );
}
```

Freehand mask-brush drawing (the `activeTool === "mask"` path) is
intentionally not implemented in this task — it needs its own
mousemove-tracked stroke path and `toDataURL()` rasterization, and is
built in Task 11 as a focused follow-up so this task's gesture logic
(point/box/ctrl-click) stays reviewable on its own.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd frontend && npx vitest run tests/FrameCanvas.test.tsx`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add frontend/src/features/annotation/FrameCanvas.tsx frontend/tests/FrameCanvas.test.tsx
git commit -m "feat: add FrameCanvas with point/box gesture capture and mask overlay rendering"
```

---

## Task 11: `FrameCanvas` — freehand mask brush

**Files:**
- Modify: `frontend/src/features/annotation/FrameCanvas.tsx`
- Modify: `frontend/tests/FrameCanvas.test.tsx`

**Interfaces:**
- Consumes: `activeTool === "mask"` from `FrameEditorStore` (Task 7/10).
- Produces: when a freehand stroke ends while `activeTool === "mask"`,
  calls `addPrompt({ type: "mask", coords: [], label: true, mask_png })`
  where `mask_png` is a base64 PNG data URL suffix (matching the backend
  contract's `mask_png: str` — confirm against
  `backend/app/jobs/schemas.py:34`, which stores it as an opaque base64
  string the ml-worker decodes; strip the `data:image/png;base64,` prefix
  before sending, since the backend expects raw base64, not a data URL).

- [ ] **Step 1: Write the failing test**

Add to `frontend/tests/FrameCanvas.test.tsx`:

```typescript
it("rasterizes a freehand stroke to mask_png when activeTool is mask", () => {
  const store = createFrameEditorStore();
  store.getState().setActiveTool("mask");
  render(<FrameCanvas frame={FRAME} annotations={[]} store={store} />);

  const canvas = screen.getByTestId("frame-canvas") as HTMLCanvasElement;
  Object.defineProperty(canvas, "getBoundingClientRect", {
    value: () => ({ left: 0, top: 0, width: 400, height: 200 }),
  });
  canvas.getContext =
    canvas.getContext ??
    (() => ({
      clearRect: () => {},
      drawImage: () => {},
      beginPath: () => {},
      moveTo: () => {},
      lineTo: () => {},
      stroke: () => {},
      strokeStyle: "",
      lineWidth: 0,
      lineCap: "round",
    }) as never);
  canvas.toDataURL = () => "data:image/png;base64,ZmFrZS1wbmc=";

  fireEvent.mouseDown(canvas, { clientX: 100, clientY: 50, button: 0 });
  fireEvent.mouseMove(canvas, { clientX: 150, clientY: 80, button: 0 });
  fireEvent.mouseUp(canvas, { clientX: 200, clientY: 100, button: 0 });

  const prompts = store.getState().pendingPrompts;
  expect(prompts).toHaveLength(1);
  expect(prompts[0].type).toBe("mask");
  expect(prompts[0].mask_png).toBe("ZmFrZS1wbmc=");
});
```

`jsdom` doesn't implement real canvas 2D drawing, so this test stubs
`getContext`/`toDataURL` directly rather than asserting pixel content —
it proves the wiring (stroke → `toDataURL` → strip prefix → `addPrompt`),
not the rendering itself, which is exactly what's testable in this
environment.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run tests/FrameCanvas.test.tsx -t "rasterizes a freehand stroke"`
Expected: FAIL — no `mask_png` prompt added (mouse-move stroke tracking
doesn't exist yet).

- [ ] **Step 3: Add freehand mask-brush drawing**

In `frontend/src/features/annotation/FrameCanvas.tsx`, add a
`strokePointsRef` and a `handleMouseMove`, and branch `handleMouseUp` for
the mask tool:

```tsx
  const strokePointsRef = useRef<[number, number][]>([]);

  function handleMouseMove(event: React.MouseEvent<HTMLCanvasElement>) {
    if (activeTool !== "mask" || !dragRef.current) return;
    const [x, y] = toNormalized(event.clientX, event.clientY);
    strokePointsRef.current.push([x, y]);

    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;
    ctx.strokeStyle = "rgba(34, 211, 238, 0.9)";
    ctx.lineWidth = Math.max(2, canvas.width * 0.01);
    ctx.lineCap = "round";
    ctx.beginPath();
    const points = strokePointsRef.current;
    const [prevX, prevY] = points.length > 1 ? points[points.length - 2] : points[0];
    ctx.moveTo(prevX * canvas.width, prevY * canvas.height);
    ctx.lineTo(x * canvas.width, y * canvas.height);
    ctx.stroke();
  }
```

Update `handleMouseDown` to seed `strokePointsRef` when the mask tool is
active:

```tsx
  function handleMouseDown(event: React.MouseEvent<HTMLCanvasElement>) {
    if (event.button !== 0) return;
    if (event.ctrlKey) return;
    const [x, y] = toNormalized(event.clientX, event.clientY);
    dragRef.current = { startX: x, startY: y };
    if (activeTool === "mask") {
      strokePointsRef.current = [[x, y]];
    }
  }
```

Update `handleMouseUp` to branch for the mask tool before the existing
point/box logic:

```tsx
  function handleMouseUp(event: React.MouseEvent<HTMLCanvasElement>) {
    if (event.button !== 0) return;
    const drag = dragRef.current;
    dragRef.current = null;

    if (event.ctrlKey) {
      return;
    }

    if (activeTool === "mask") {
      const canvas = canvasRef.current;
      if (canvas && strokePointsRef.current.length > 1) {
        const dataUrl = canvas.toDataURL("image/png");
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
      addPrompt({
        type: "box",
        coords: [
          Math.min(drag.startX, endX),
          Math.min(drag.startY, endY),
          Math.max(drag.startX, endX),
          Math.max(drag.startY, endY),
        ],
        label: true,
      });
    } else {
      addPrompt({ type: "point", coords: [drag.startX, drag.startY], label: true });
    }
  }
```

Add `onMouseMove={handleMouseMove}` to the `<canvas>` element in the JSX.

Note this makes `handleMouseUp`'s freehand-stroke canvas
`toDataURL("image/png")` composite the live brush strokes drawn directly
onto the same canvas as the frame/mask rendering (Task 10's rendering
`useEffect`) — meaning a real freehand mask capture will actually rasterize
the frame image and mask overlays underneath the stroke, not just the
stroke on transparent background. This is a known limitation worth
flagging in code review: the ml-worker's `mask_png` handling
(`backend/app/jobs/schemas.py`) expects a mask (foreground/background),
not a full composited image. If this surfaces as a real problem during
Task 17's browser verification, the fix is drawing the brush stroke on an
offscreen second canvas (transparent background, stroke only) and calling
`toDataURL` on *that* instead — flag this to the user rather than
silently shipping a broken mask_png if browser verification shows visibly
wrong SAM 2.1 mask results from brush-drawn prompts.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd frontend && npx vitest run tests/FrameCanvas.test.tsx`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add frontend/src/features/annotation/FrameCanvas.tsx frontend/tests/FrameCanvas.test.tsx
git commit -m "feat: add freehand mask-brush drawing to FrameCanvas"
```

---

## Task 12: `CascadingLabelPicker`

**Files:**
- Create: `frontend/src/features/annotation/CascadingLabelPicker.tsx`
- Test: `frontend/tests/CascadingLabelPicker.test.tsx`

**Interfaces:**
- Consumes: `useLabelTree()` (Task 8), `FrameEditorStore`'s
  `labelCategoryId`/`labelClassification`/`labelTagId`/`setLabelSelection`
  (Task 7).
- Produces: `<CascadingLabelPicker store={FrameEditorStore} />`, consumed
  by Task 16 (`ToolsPanel`).

- [ ] **Step 1: Write the failing test**

Create `frontend/tests/CascadingLabelPicker.test.tsx`:

```typescript
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";

import { apiClient } from "../src/shared/api/client";
import { createFrameEditorStore } from "../src/features/annotation/frameEditorStore";
import { CascadingLabelPicker } from "../src/features/annotation/CascadingLabelPicker";

const TREE = [
  {
    category: { id: 1, name: "lesion", label_type: "geometric", color: "#fff", procedure_id: null, taxonomy_version: 1 },
    children: [
      { id: 2, name: "0-Ip", label_type: "geometric", color: "#f00", procedure_id: null, taxonomy_version: 1 },
      { id: 3, name: "scar", label_type: "morphological", color: "#0f0", procedure_id: null, taxonomy_version: 1 },
    ],
  },
];

function renderPicker(store = createFrameEditorStore()) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  vi.spyOn(apiClient, "GET").mockResolvedValue({ data: TREE, error: undefined, response: new Response() } as never);
  render(
    <QueryClientProvider client={queryClient}>
      <CascadingLabelPicker store={store} />
    </QueryClientProvider>,
  );
  return store;
}

describe("CascadingLabelPicker", () => {
  it("lists categories, then filters children by classification, then lists tags", async () => {
    renderPicker();

    await waitFor(() => expect(screen.getByRole("option", { name: "lesion" })).toBeInTheDocument());
    await userEvent.selectOptions(screen.getByLabelText("Category"), "1");

    await userEvent.selectOptions(screen.getByLabelText("Classification"), "geometric");
    expect(screen.getByRole("option", { name: "0-Ip" })).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: "scar" })).not.toBeInTheDocument();

    await userEvent.selectOptions(screen.getByLabelText("Tag"), "2");

    const store = createFrameEditorStore(); // placeholder; real assertion below reads the passed-in store
  });

  it("writes the selection into the store", async () => {
    const store = renderPicker();

    await waitFor(() => expect(screen.getByRole("option", { name: "lesion" })).toBeInTheDocument());
    await userEvent.selectOptions(screen.getByLabelText("Category"), "1");
    await userEvent.selectOptions(screen.getByLabelText("Classification"), "geometric");
    await userEvent.selectOptions(screen.getByLabelText("Tag"), "2");

    const state = store.getState();
    expect(state.labelCategoryId).toBe(1);
    expect(state.labelClassification).toBe("geometric");
    expect(state.labelTagId).toBe(2);
  });
});
```

Remove the stray unused `const store = createFrameEditorStore();` line
inside the first test before implementing — it was left in to show the
selection flow works end-to-end without asserting store state twice; the
second test is the one that actually checks store writes. Keep only the
second test's assertion pattern; the first test should end after its two
`expect` calls on rendered options.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run tests/CascadingLabelPicker.test.tsx`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `CascadingLabelPicker.tsx`**

Create `frontend/src/features/annotation/CascadingLabelPicker.tsx`:

```tsx
import { useStore } from "zustand/react";

import { useLabelTree } from "../../entities/useLabelTree";
import type { FrameEditorStore } from "./frameEditorStore";

interface CascadingLabelPickerProps {
  store: FrameEditorStore;
}

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
          className="mt-1 w-full rounded border border-gray-700 bg-gray-800 px-2 py-1 text-sm text-gray-100"
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
          className="mt-1 w-full rounded border border-gray-700 bg-gray-800 px-2 py-1 text-sm text-gray-100"
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
          className="mt-1 w-full rounded border border-gray-700 bg-gray-800 px-2 py-1 text-sm text-gray-100"
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

- [ ] **Step 4: Run test to verify it passes**

Run: `cd frontend && npx vitest run tests/CascadingLabelPicker.test.tsx`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add frontend/src/features/annotation/CascadingLabelPicker.tsx frontend/tests/CascadingLabelPicker.test.tsx
git commit -m "feat: add CascadingLabelPicker (Category -> Classification -> Tag)"
```

---

## Task 13: `MasksList`

**Files:**
- Create: `frontend/src/features/annotation/MasksList.tsx`
- Test: `frontend/tests/MasksList.test.tsx`

**Interfaces:**
- Consumes: `components["schemas"]["AnnotationRead"][]`,
  `FrameEditorStore`'s `selectedAnnotationId`/`setSelectedAnnotation`/
  `setLabelSelection`/`setColor` (Task 7), `useLabelTree()` (Task 8, to
  resolve a clicked annotation's `label_id` back to
  category/classification/tag for auto-fill).
- Produces: `<MasksList annotations={AnnotationRead[]} store={FrameEditorStore} />`,
  consumed by Task 16 (`ToolsPanel`).

- [ ] **Step 1: Write the failing test**

Create `frontend/tests/MasksList.test.tsx`:

```typescript
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";

import { apiClient } from "../src/shared/api/client";
import { createFrameEditorStore } from "../src/features/annotation/frameEditorStore";
import { MasksList } from "../src/features/annotation/MasksList";

const TREE = [
  {
    category: { id: 1, name: "lesion", label_type: "geometric", color: "#fff", procedure_id: null, taxonomy_version: 1 },
    children: [
      { id: 2, name: "0-Ip", label_type: "geometric", color: "#f00", procedure_id: null, taxonomy_version: 1 },
    ],
  },
];

const ANNOTATIONS = [
  {
    id: 55,
    frame_id: 1,
    label_id: 2,
    taxonomy_version: 1,
    annotation_type: "mask",
    status: "draft",
    created_by_id: 1,
    reviewed_by_id: null,
    mask_url: "https://example.test/mask-55.png",
  },
];

describe("MasksList", () => {
  it("lists one row per mask annotation", () => {
    const store = createFrameEditorStore();
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    vi.spyOn(apiClient, "GET").mockResolvedValue({ data: TREE, error: undefined, response: new Response() } as never);

    render(
      <QueryClientProvider client={queryClient}>
        <MasksList annotations={ANNOTATIONS as never} store={store} />
      </QueryClientProvider>,
    );

    expect(screen.getByText("lesion / 0-Ip")).toBeInTheDocument();
  });

  it("clicking a row selects the annotation and fills the label selection", async () => {
    const store = createFrameEditorStore();
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    vi.spyOn(apiClient, "GET").mockResolvedValue({ data: TREE, error: undefined, response: new Response() } as never);

    render(
      <QueryClientProvider client={queryClient}>
        <MasksList annotations={ANNOTATIONS as never} store={store} />
      </QueryClientProvider>,
    );

    await waitFor(() => expect(screen.getByText("lesion / 0-Ip")).toBeInTheDocument());
    await userEvent.click(screen.getByText("lesion / 0-Ip"));

    const state = store.getState();
    expect(state.selectedAnnotationId).toBe(55);
    expect(state.labelCategoryId).toBe(1);
    expect(state.labelTagId).toBe(2);
    expect(state.labelClassification).toBe("geometric");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run tests/MasksList.test.tsx`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `MasksList.tsx`**

Create `frontend/src/features/annotation/MasksList.tsx`:

```tsx
import { useStore } from "zustand/react";

import { useLabelTree } from "../../entities/useLabelTree";
import type { components } from "../../shared/api/generated/schema";
import type { FrameEditorStore } from "./frameEditorStore";

type Annotation = components["schemas"]["AnnotationRead"];

interface MasksListProps {
  annotations: Annotation[];
  store: FrameEditorStore;
}

export function MasksList({ annotations, store }: MasksListProps) {
  const treeQuery = useLabelTree();
  const tree = treeQuery.data ?? [];

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

  return (
    <ul className="max-h-48 space-y-1 overflow-y-auto text-sm">
      {maskAnnotations.map((annotation) => {
        const resolved = resolveLabel(annotation.label_id);
        const categoryName = tree.find((node) => node.category.id === resolved?.categoryId)?.category.name;
        const tagName = resolved?.tag.name;
        return (
          <li key={annotation.id}>
            <button
              type="button"
              onClick={() => handleSelect(annotation)}
              className={`flex w-full items-center gap-2 rounded px-2 py-1 text-left hover:bg-gray-800 ${
                annotation.id === selectedAnnotationId ? "bg-gray-800" : ""
              }`}
            >
              <span
                className="h-3 w-3 rounded-full"
                style={{ backgroundColor: resolved?.tag.color ?? "#666" }}
              />
              {categoryName && tagName ? `${categoryName} / ${tagName}` : `label ${annotation.label_id}`}
            </button>
          </li>
        );
      })}
    </ul>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd frontend && npx vitest run tests/MasksList.test.tsx`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add frontend/src/features/annotation/MasksList.tsx frontend/tests/MasksList.test.tsx
git commit -m "feat: add MasksList with click-to-select and label auto-fill"
```

---

## Task 14: `TrackControls`

**Files:**
- Create: `frontend/src/features/annotation/TrackControls.tsx`
- Test: `frontend/tests/TrackControls.test.tsx`

**Interfaces:**
- Consumes: `FrameEditorStore`'s `backward`/`forward`/`setBackward`/
  `setForward` (Task 7).
- Produces: `<TrackControls store={FrameEditorStore} onTrack={() => void}>`,
  consumed by Task 16 (`ToolsPanel`).

- [ ] **Step 1: Write the failing test**

Create `frontend/tests/TrackControls.test.tsx`:

```typescript
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { createFrameEditorStore } from "../src/features/annotation/frameEditorStore";
import { TrackControls } from "../src/features/annotation/TrackControls";

describe("TrackControls", () => {
  it("shows nonzero default values for both fields, never blank", () => {
    const store = createFrameEditorStore();
    render(<TrackControls store={store} onTrack={vi.fn()} />);

    expect(screen.getByLabelText("Backward")).toHaveValue(store.getState().backward);
    expect(screen.getByLabelText("Forward")).toHaveValue(store.getState().forward);
  });

  it("updates the store when a field changes", async () => {
    const store = createFrameEditorStore();
    render(<TrackControls store={store} onTrack={vi.fn()} />);

    await userEvent.clear(screen.getByLabelText("Backward"));
    await userEvent.type(screen.getByLabelText("Backward"), "3");

    expect(store.getState().backward).toBe(3);
  });

  it("calls onTrack when the Track button is clicked", async () => {
    const store = createFrameEditorStore();
    const onTrack = vi.fn();
    render(<TrackControls store={store} onTrack={onTrack} />);

    await userEvent.click(screen.getByRole("button", { name: "Track" }));

    expect(onTrack).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run tests/TrackControls.test.tsx`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `TrackControls.tsx`**

Create `frontend/src/features/annotation/TrackControls.tsx`:

```tsx
import { useStore } from "zustand/react";

import type { FrameEditorStore } from "./frameEditorStore";

interface TrackControlsProps {
  store: FrameEditorStore;
  onTrack: () => void;
}

export function TrackControls({ store, onTrack }: TrackControlsProps) {
  const backward = useStore(store, (state) => state.backward);
  const forward = useStore(store, (state) => state.forward);
  const setBackward = useStore(store, (state) => state.setBackward);
  const setForward = useStore(store, (state) => state.setForward);

  return (
    <div className="space-y-2">
      <div className="flex gap-2">
        <label className="flex-1 text-xs text-gray-400">
          Backward
          <input
            type="number"
            min={0}
            value={backward}
            onChange={(event) => setBackward(Number(event.target.value))}
            className="mt-1 w-full rounded border border-gray-700 bg-gray-800 px-2 py-1 text-sm text-gray-100"
          />
        </label>
        <label className="flex-1 text-xs text-gray-400">
          Forward
          <input
            type="number"
            min={0}
            value={forward}
            onChange={(event) => setForward(Number(event.target.value))}
            className="mt-1 w-full rounded border border-gray-700 bg-gray-800 px-2 py-1 text-sm text-gray-100"
          />
        </label>
      </div>
      <button
        type="button"
        onClick={onTrack}
        className="w-full rounded bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-500"
      >
        Track
      </button>
    </div>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd frontend && npx vitest run tests/TrackControls.test.tsx`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add frontend/src/features/annotation/TrackControls.tsx frontend/tests/TrackControls.test.tsx
git commit -m "feat: add TrackControls with explicit nonzero Backward/Forward defaults"
```

---

## Task 15: `useCreateMaskJob` — job submission hooks for SAM 2.1 predict/track

**Files:**
- Create: `frontend/src/entities/useSegmentation.ts`
- Test: `frontend/tests/useSegmentation.test.tsx`

**Interfaces:**
- Consumes: `POST /jobs/sam2/predict`, `POST /jobs/sam2/track` (both
  already implemented backend-side per Phase 2a.2, now typed via Task 6's
  regenerated schema).
- Produces: `useSam2Predict()`, `useSam2Track()` — both
  `useMutation`-based, mirroring `SegmentButton.tsx`'s existing
  `createJob` mutation pattern (`frontend/src/features/annotation/SegmentButton.tsx:21-31`).
  Consumed by Task 17 (`FrameEditor`).

- [ ] **Step 1: Write the failing tests**

Create `frontend/tests/useSegmentation.test.tsx`:

```typescript
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";

import { apiClient } from "../src/shared/api/client";
import { useSam2Predict, useSam2Track } from "../src/entities/useSegmentation";

function wrapper({ children }: { children: ReactNode }) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}

describe("useSam2Predict", () => {
  it("posts to /jobs/sam2/predict with frame_id, label_id, prompts", async () => {
    vi.spyOn(apiClient, "POST").mockResolvedValue({
      data: { id: 1, job_type: "sam2_predict", status: "pending", progress: 0, result_ref: null, error: null, created_by_id: 1, started_at: null, finished_at: null },
      error: undefined,
      response: new Response(),
    } as never);

    const { result } = renderHook(() => useSam2Predict(), { wrapper });
    result.current.mutate({ frame_id: 42, label_id: 5, prompts: [{ type: "point", coords: [0.5, 0.5], label: true }] });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(apiClient.POST).toHaveBeenCalledWith(
      "/jobs/sam2/predict",
      expect.objectContaining({ body: { frame_id: 42, label_id: 5, prompts: [{ type: "point", coords: [0.5, 0.5], label: true }] } }),
    );
  });
});

describe("useSam2Track", () => {
  it("posts to /jobs/sam2/track with anchor_frame_id, backward, forward", async () => {
    vi.spyOn(apiClient, "POST").mockResolvedValue({
      data: { id: 2, job_type: "sam2_track", status: "pending", progress: 0, result_ref: null, error: null, created_by_id: 1, started_at: null, finished_at: null },
      error: undefined,
      response: new Response(),
    } as never);

    const { result } = renderHook(() => useSam2Track(), { wrapper });
    result.current.mutate({
      sequence_id: 9,
      label_id: 5,
      prompts: [{ type: "point", coords: [0.5, 0.5], label: true }],
      anchor_frame_id: 42,
      backward: 5,
      forward: 5,
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(apiClient.POST).toHaveBeenCalledWith(
      "/jobs/sam2/track",
      expect.objectContaining({
        body: { sequence_id: 9, label_id: 5, prompts: [{ type: "point", coords: [0.5, 0.5], label: true }], anchor_frame_id: 42, backward: 5, forward: 5 },
      }),
    );
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd frontend && npx vitest run tests/useSegmentation.test.tsx`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `useSegmentation.ts`**

Create `frontend/src/entities/useSegmentation.ts`:

```typescript
import { useMutation } from "@tanstack/react-query";

import { apiClient } from "../shared/api/client";
import type { components } from "../shared/api/generated/schema";

type Sam2PredictRequest = components["schemas"]["Sam2PredictRequest"];
type Sam2TrackRequest = components["schemas"]["Sam2TrackRequest"];

export function useSam2Predict() {
  return useMutation({
    mutationFn: async (body: Sam2PredictRequest) => {
      const result = await apiClient.POST("/jobs/sam2/predict", { body });
      return result.data;
    },
  });
}

export function useSam2Track() {
  return useMutation({
    mutationFn: async (body: Sam2TrackRequest) => {
      const result = await apiClient.POST("/jobs/sam2/track", { body });
      return result.data;
    },
  });
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd frontend && npx vitest run tests/useSegmentation.test.tsx`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add frontend/src/entities/useSegmentation.ts frontend/tests/useSegmentation.test.tsx
git commit -m "feat: add useSam2Predict and useSam2Track job submission hooks"
```

---

## Task 16: `ToolsPanel`

**Files:**
- Create: `frontend/src/features/annotation/ToolsPanel.tsx`
- Test: `frontend/tests/ToolsPanel.test.tsx`

**Interfaces:**
- Consumes: `FrameEditorStore` (Task 7), `CascadingLabelPicker` (Task 12),
  `MasksList` (Task 13), `TrackControls` (Task 14).
- Produces: `<ToolsPanel store={FrameEditorStore} annotations={AnnotationRead[]} onAddMask={() => void} onTrack={() => void} />`,
  consumed by Task 17 (`FrameEditor`).

- [ ] **Step 1: Write the failing tests**

Create `frontend/tests/ToolsPanel.test.tsx`:

```typescript
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";

import { apiClient } from "../src/shared/api/client";
import { createFrameEditorStore } from "../src/features/annotation/frameEditorStore";
import { ToolsPanel } from "../src/features/annotation/ToolsPanel";

function renderPanel(onAddMask = vi.fn(), onTrack = vi.fn(), store = createFrameEditorStore()) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  vi.spyOn(apiClient, "GET").mockResolvedValue({ data: [], error: undefined, response: new Response() } as never);
  render(
    <QueryClientProvider client={queryClient}>
      <ToolsPanel store={store} annotations={[]} onAddMask={onAddMask} onTrack={onTrack} />
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

  it("calls onAddMask when Add mask is clicked", async () => {
    const onAddMask = vi.fn();
    renderPanel(onAddMask);

    await userEvent.click(screen.getByRole("button", { name: "Add mask" }));

    expect(onAddMask).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd frontend && npx vitest run tests/ToolsPanel.test.tsx`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `ToolsPanel.tsx`**

Create `frontend/src/features/annotation/ToolsPanel.tsx`:

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
  onAddMask: () => void;
  onTrack: () => void;
}

const PRESET_COLORS = ["#22d3ee", "#f87171", "#4ade80", "#facc15", "#a78bfa", "#fb923c"];
const TOOLS: PromptType[] = ["point", "box", "mask"];
const TOOL_LABELS: Record<PromptType, string> = { point: "Point", box: "Box", mask: "Mask" };

export function ToolsPanel({ store, annotations, onAddMask, onTrack }: ToolsPanelProps) {
  const activeModel = useStore(store, (state) => state.activeModel);
  const activeTool = useStore(store, (state) => state.activeTool);
  const setActiveModel = useStore(store, (state) => state.setActiveModel);
  const setActiveTool = useStore(store, (state) => state.setActiveTool);
  const color = useStore(store, (state) => state.color);
  const setColor = useStore(store, (state) => state.setColor);

  return (
    <aside className="flex w-[270px] shrink-0 flex-col gap-4 overflow-y-auto border-l border-gray-800 p-4">
      <div role="tablist" className="flex gap-1 rounded border border-gray-800 p-1">
        <button
          type="button"
          role="tab"
          aria-selected={activeModel === "sam2"}
          onClick={() => setActiveModel("sam2")}
          className={`flex-1 rounded px-2 py-1 text-sm ${activeModel === "sam2" ? "bg-blue-600 text-white" : "text-gray-300"}`}
        >
          SAM 2.1
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={false}
          disabled
          title="Needs more VRAM than this GPU has — available after hardware upgrade"
          className="flex-1 cursor-not-allowed rounded px-2 py-1 text-sm text-gray-600"
        >
          SAM-3
        </button>
      </div>

      <div className="flex gap-1 rounded border border-gray-800 p-1">
        {TOOLS.map((tool) => (
          <button
            key={tool}
            type="button"
            onClick={() => setActiveTool(tool)}
            className={`flex-1 rounded px-2 py-1 text-sm ${activeTool === tool ? "bg-blue-600 text-white" : "text-gray-300"}`}
          >
            {TOOL_LABELS[tool]}
          </button>
        ))}
      </div>

      <CascadingLabelPicker store={store} />

      <div className="flex items-center gap-2">
        <input
          type="color"
          value={color}
          onChange={(event) => setColor(event.target.value)}
          className="h-8 w-8 rounded border border-gray-700 bg-transparent"
          aria-label="Color"
        />
        {PRESET_COLORS.map((preset) => (
          <button
            key={preset}
            type="button"
            onClick={() => setColor(preset)}
            style={{ backgroundColor: preset }}
            className="h-5 w-5 rounded-full border border-gray-700"
            aria-label={`Preset color ${preset}`}
          />
        ))}
        <button
          type="button"
          onClick={onAddMask}
          className="ml-auto rounded bg-blue-600 px-2 py-1 text-xs font-medium text-white hover:bg-blue-500"
        >
          Add mask
        </button>
      </div>

      <TrackControls store={store} onTrack={onTrack} />

      <div>
        <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-gray-400">Masks</h3>
        <MasksList annotations={annotations} store={store} />
      </div>
    </aside>
  );
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd frontend && npx vitest run tests/ToolsPanel.test.tsx`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add frontend/src/features/annotation/ToolsPanel.tsx frontend/tests/ToolsPanel.test.tsx
git commit -m "feat: add ToolsPanel with model tabs, tool row, label picker, track controls, masks list"
```

---

## Task 17: `FrameEditor` — assembling the pieces, wiring job submission

**Files:**
- Create: `frontend/src/features/annotation/FrameEditor.tsx`
- Test: `frontend/tests/FrameEditor.test.tsx`

**Interfaces:**
- Consumes: `useFrame(frameId)` (existing,
  `frontend/src/entities/useFrames.ts:18`), `useAnnotations(frameId)`
  (existing), `useJob(jobId)` (existing,
  `frontend/src/entities/useJobs.ts:7`), `useSam2Predict`/`useSam2Track`
  (Task 15), `createFrameEditorStore` (Task 7), `FrameCanvas` (Task
  10/11), `ToolsPanel` (Task 16).
- Produces: `<FrameEditor frameId={number} onClose={() => void} />`,
  consumed by Task 18 (wiring into `SequenceGridPage`).

- [ ] **Step 1: Write the failing tests**

Create `frontend/tests/FrameEditor.test.tsx`:

```typescript
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";

import { apiClient } from "../src/shared/api/client";
import { FrameEditor } from "../src/features/annotation/FrameEditor";

function renderEditor(onClose = vi.fn()) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  vi.spyOn(apiClient, "GET").mockImplementation((async (path: string) => {
    if (path === "/media/frames/{frame_id}") {
      return {
        data: { id: 42, sequence_id: 9, storage_key: "frames/9/42.png", frame_index: 42, width: 400, height: 200, image_url: "https://example.test/f42.png" },
        error: undefined,
        response: new Response(),
      };
    }
    if (path === "/annotation/frames/{frame_id}/annotations") {
      return { data: [], error: undefined, response: new Response() };
    }
    if (path === "/taxonomy/labels/tree") {
      return { data: [], error: undefined, response: new Response() };
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
      <FrameEditor frameId={42} onClose={onClose} />
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
    renderEditor(onClose);

    await waitFor(() => expect(screen.getByTestId("frame-canvas")).toBeInTheDocument());
    await userEvent.click(screen.getByRole("button", { name: /back to grid/i }));

    expect(onClose).toHaveBeenCalled();
  });

  it("submits a SAM 2.1 predict job when Add mask is clicked with a pending point prompt", async () => {
    renderEditor();

    await waitFor(() => expect(screen.getByTestId("frame-canvas")).toBeInTheDocument());

    const canvas = screen.getByTestId("frame-canvas");
    Object.defineProperty(canvas, "getBoundingClientRect", {
      value: () => ({ left: 0, top: 0, width: 400, height: 200 }),
    });
    const { fireEvent } = await import("@testing-library/react");
    fireEvent.mouseDown(canvas, { clientX: 200, clientY: 100, button: 0 });
    fireEvent.mouseUp(canvas, { clientX: 200, clientY: 100, button: 0 });

    await userEvent.click(screen.getByRole("button", { name: "Add mask" }));

    await waitFor(() =>
      expect(apiClient.POST).toHaveBeenCalledWith(
        "/jobs/sam2/predict",
        expect.objectContaining({
          body: expect.objectContaining({ frame_id: 42, prompts: [{ type: "point", coords: [0.5, 0.5], label: true }] }),
        }),
      ),
    );
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd frontend && npx vitest run tests/FrameEditor.test.tsx`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `FrameEditor.tsx`**

Create `frontend/src/features/annotation/FrameEditor.tsx`:

```tsx
import { useMemo, useState } from "react";

import { useAnnotations } from "../../entities/useAnnotations";
import { useFrame } from "../../entities/useFrames";
import { useJob } from "../../entities/useJobs";
import { useSam2Predict, useSam2Track } from "../../entities/useSegmentation";
import { createFrameEditorStore } from "./frameEditorStore";
import { FrameCanvas } from "./FrameCanvas";
import { ToolsPanel } from "./ToolsPanel";

interface FrameEditorProps {
  frameId: number;
  onClose: () => void;
}

export function FrameEditor({ frameId, onClose }: FrameEditorProps) {
  const store = useMemo(() => createFrameEditorStore(), [frameId]);
  const [activeJobId, setActiveJobId] = useState<number | null>(null);

  const frameQuery = useFrame(frameId);
  const annotationsQuery = useAnnotations(frameId);
  const jobQuery = useJob(activeJobId);
  const predictMutation = useSam2Predict();
  const trackMutation = useSam2Track();

  function handleAddMask() {
    const state = store.getState();
    if (state.labelTagId === null || state.pendingPrompts.length === 0) return;
    predictMutation.mutate(
      { frame_id: frameId, label_id: state.labelTagId, prompts: state.pendingPrompts },
      {
        onSuccess: (data) => {
          if (data) setActiveJobId(data.id);
          store.getState().clearPrompts();
        },
      },
    );
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
    <div className="flex min-h-screen bg-gray-950 text-gray-100">
      <div className="flex flex-1 flex-col">
        <div className="border-b border-gray-800 p-3">
          <button
            type="button"
            onClick={onClose}
            className="rounded border border-gray-700 px-3 py-1 text-sm text-gray-200 hover:bg-gray-800"
          >
            ✕ Back to grid
          </button>
          {jobQuery.data && (
            <span className="ml-3 text-sm text-gray-400">
              Job #{jobQuery.data.id}: {jobQuery.data.status} ({jobQuery.data.progress}%)
            </span>
          )}
        </div>
        <div className="flex-1 p-4">
          <FrameCanvas frame={frameQuery.data} annotations={annotationsQuery.data ?? []} store={store} />
        </div>
      </div>
      <ToolsPanel
        store={store}
        annotations={annotationsQuery.data ?? []}
        onAddMask={handleAddMask}
        onTrack={handleTrack}
      />
    </div>
  );
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd frontend && npx vitest run tests/FrameEditor.test.tsx`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add frontend/src/features/annotation/FrameEditor.tsx frontend/tests/FrameEditor.test.tsx
git commit -m "feat: add FrameEditor assembling canvas, tools panel, and SAM 2.1 job submission"
```

---

## Task 18: Wire `FrameEditor` into the grid, update routes, remove the old placeholder

**Files:**
- Modify: `frontend/src/features/annotation/SequenceGridPage.tsx`
- Modify: `frontend/tests/SequenceGridPage.test.tsx`
- Modify: `frontend/src/app/App.tsx`
- Delete: `frontend/src/features/annotation/SegmentButton.tsx`
- Delete: `frontend/src/features/annotation/FrameAnnotationPage.tsx`
- Delete: `frontend/tests/SegmentButton.test.tsx`
- Delete: `frontend/tests/FrameAnnotationPage.test.tsx`

**Interfaces:**
- Consumes: `FrameEditor` (Task 17).
- Produces: the grid at `/videos/:videoId/sequences/:sequenceId` now
  swaps in the real editor, not a placeholder `<div>`.

- [ ] **Step 1: Update the failing-first test for the real editor slot**

In `frontend/tests/SequenceGridPage.test.tsx`, replace the
`"frame-editor-slot"` assertions (from Task 9) with assertions on the
real editor's rendered content. Replace:

```typescript
  it("swaps the grid for the frame editor placeholder when a thumbnail is clicked", async () => {
    renderPage();

    await waitFor(() => expect(screen.getAllByRole("img")).toHaveLength(2));
    await userEvent.click(screen.getAllByRole("img")[0]);

    await waitFor(() => expect(screen.getByTestId("frame-editor-slot")).toBeInTheDocument());
    expect(screen.queryAllByRole("img")).toHaveLength(0);
  });
```

with:

```typescript
  it("swaps the grid for the frame editor when a thumbnail is clicked", async () => {
    renderPage();

    await waitFor(() => expect(screen.getAllByRole("img")).toHaveLength(2));
    await userEvent.click(screen.getAllByRole("img")[0]);

    await waitFor(() => expect(screen.getByTestId("frame-canvas")).toBeInTheDocument());
  });
```

This requires extending the `beforeEach` mock in the same file to also
answer `/media/frames/{frame_id}` and `/taxonomy/labels/tree` (both now
hit by the real `FrameEditor`):

```typescript
      if (path === "/media/frames/{frame_id}") {
        return {
          data: { id: 101, sequence_id: 9, storage_key: "frames/9/0.png", frame_index: 0, width: 100, height: 100, image_url: "https://example.test/f0.png" },
          error: undefined,
          response: new Response(),
        };
      }
      if (path === "/taxonomy/labels/tree") {
        return { data: [], error: undefined, response: new Response() };
      }
```

Add these two `if` blocks into the existing mock implementation from Task
9's `SequenceGridPage.test.tsx`, alongside the existing
`/media/sequences/{sequence_id}/frames` and
`/annotation/frames/{frame_id}/annotations` cases.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run tests/SequenceGridPage.test.tsx`
Expected: FAIL — `frame-canvas` testid not found (still rendering the
Task 9 placeholder `<div data-testid="frame-editor-slot" />`).

- [ ] **Step 3: Wire `FrameEditor` into `SequenceGridPage.tsx`**

In `frontend/src/features/annotation/SequenceGridPage.tsx`, replace:

```tsx
import { useFrames } from "../../entities/useFrames";
import { FrameThumbnail } from "./FrameThumbnail";
```

with:

```tsx
import { useFrames } from "../../entities/useFrames";
import { FrameEditor } from "./FrameEditor";
import { FrameThumbnail } from "./FrameThumbnail";
```

and replace the `selectedFrameId !== null` branch's body:

```tsx
  if (selectedFrameId !== null) {
    return (
      <div className="min-h-screen bg-gray-950 text-gray-100">
        <div className="border-b border-gray-800 p-3">
          <button
            type="button"
            onClick={() => setSelectedFrameId(null)}
            className="rounded border border-gray-700 px-3 py-1 text-sm text-gray-200 hover:bg-gray-800"
          >
            ✕ Back to grid
          </button>
        </div>
        {/* Replaced with <FrameEditor frameId={selectedFrameId} /> once it exists (Task 14). */}
        <div data-testid="frame-editor-slot" />
      </div>
    );
  }
```

with:

```tsx
  if (selectedFrameId !== null) {
    return <FrameEditor frameId={selectedFrameId} onClose={() => setSelectedFrameId(null)} />;
  }
```

`FrameEditor` already renders its own "✕ Back to grid" button (Task 17)
— the outer wrapper `<div>` with a duplicate back button is removed here,
not kept alongside it.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd frontend && npx vitest run tests/SequenceGridPage.test.tsx`
Expected: PASS (3 tests, including the updated one).

- [ ] **Step 5: Update routes in `App.tsx`**

In `frontend/src/app/App.tsx`, replace:

```tsx
import { FrameAnnotationPage } from "../features/annotation/FrameAnnotationPage";
import { LoginPage } from "../features/auth/LoginPage";
import { useAuth } from "../features/auth/useAuth";
import { VideoListPage } from "../features/media/VideoListPage";
```

with:

```tsx
import { SequenceGridPage } from "../features/annotation/SequenceGridPage";
import { LoginPage } from "../features/auth/LoginPage";
import { useAuth } from "../features/auth/useAuth";
import { VideoListPage } from "../features/media/VideoListPage";
```

and replace:

```tsx
        <Route
          path="/frames/:frameId"
          element={
            <RequireAuth>
              <FrameAnnotationPage />
            </RequireAuth>
          }
        />
```

with:

```tsx
        <Route
          path="/videos/:videoId/sequences/:sequenceId"
          element={
            <RequireAuth>
              <SequenceGridPage />
            </RequireAuth>
          }
        />
```

- [ ] **Step 6: Delete the superseded placeholder files**

```bash
git rm frontend/src/features/annotation/SegmentButton.tsx
git rm frontend/src/features/annotation/FrameAnnotationPage.tsx
git rm frontend/tests/SegmentButton.test.tsx
git rm frontend/tests/FrameAnnotationPage.test.tsx
```

`LabelPicker.tsx` is NOT deleted — it stays, unused by the new editor
(which uses `CascadingLabelPicker` instead) but still a reasonable
building block for a future Tags screen, per the design spec.

- [ ] **Step 7: Run the full frontend test suite**

Run: `cd frontend && npx vitest run`
Expected: all tests pass, none reference the deleted files.

- [ ] **Step 8: Run the TypeScript build to catch any stale references**

Run: `cd frontend && npx tsc -b --noEmit`
Expected: no errors (confirms nothing else imports the deleted
`SegmentButton`/`FrameAnnotationPage`).

- [ ] **Step 9: Commit**

```bash
git add frontend/src/features/annotation/SequenceGridPage.tsx frontend/tests/SequenceGridPage.test.tsx frontend/src/app/App.tsx
git commit -m "feat: wire FrameEditor into the sequence grid, replace the old placeholder route"
```

---

## Task 19: Real-browser verification

**Files:** none (manual verification pass, per CLAUDE.md's Testing
philosophy section).

**Interfaces:** none — this task consumes the fully assembled feature
from Tasks 1-18 and produces a verification report, not code.

- [ ] **Step 1: Start the stack**

```bash
docker compose up -d
cd backend && uv run uvicorn app.main:app --reload &
cd frontend && npm run dev &
```

Confirm `backend` connects to Postgres/MinIO/Redis and `frontend` builds
without the `--legacy-peer-deps` install step having been skipped
(`npm install --legacy-peer-deps` first if `node_modules` is stale).

- [ ] **Step 2: Create real data for a walkthrough**

Through the running UI or `curl`, ensure at least one video with an
extracted sequence, and at least one `Label` (root) with a child
(`LabelRelation`) exist — reuse existing dev-environment data if any
already exists from prior phases' manual testing, otherwise create fresh
via `POST /media/videos`, `POST /media/videos/{id}/sequences`,
`POST /taxonomy/labels` (twice — parent and child),
`POST /taxonomy/labels/relations`.

- [ ] **Step 3: Click through the golden path in a real browser**

Navigate to `/videos/{video_id}/sequences/{sequence_id}`. Verify:
- The grid renders one thumbnail per extracted frame.
- Clicking a thumbnail swaps in the frame editor in place (URL doesn't
  change, no page reload).
- The SAM 2.1 tab is active by default; the SAM-3 tab is visibly disabled
  with the VRAM tooltip.
- Category → Classification → Tag selects cascade correctly (picking a
  category populates Classification/Tag; changing Classification narrows
  Tag).
- A left click on the frame image adds a point; a left-click-drag adds a
  box (verify by checking the pending prompt visually reflects on canvas,
  if implemented, or by checking the Network tab's request body on Add
  mask).
- Clicking "Add mask" with a label selected and at least one pending
  prompt fires a real `POST /jobs/sam2/predict` (check the Network tab)
  and a job status line appears and eventually reaches `succeeded`.
- The resulting mask shows up in the Masks list, and clicking it
  highlights the mask on the canvas and re-fills the label picker/color
  fields.
- Backward/Forward fields show small nonzero defaults, never blank;
  clicking "Track" fires `POST /jobs/sam2/track` with the current
  anchor frame and both directions.
- "✕ Back to grid" returns to the grid without a page reload.

- [ ] **Step 4: Report findings honestly**

If any step above doesn't work as described, do not report the task
complete — note the specific failure (which step, what happened instead)
so it can be fixed before considering the frame editor done. This mirrors
CLAUDE.md's explicit warning: passing unit tests is not proof a feature
works; only this manual pass is.

---

## Self-Review

**Spec coverage:**
- Video-less sequences (spec §1) → Tasks 1-2. ✓
- Sequences-by-video listing (spec §2) → Task 3. ✓
- Cascading label tree (spec §3) → Task 4. ✓
- Mask visibility on annotations (spec §4) → Task 5. ✓
- OpenAPI regeneration → Task 6. ✓
- Sequence grid screen → Task 9. ✓
- Frame editor architecture (store, canvas, tools panel, cascading
  picker, masks list, track controls) → Tasks 7, 10, 11, 12, 13, 14, 16,
  17. ✓
- SAM 2.1 job submission → Task 15, wired in Task 17. ✓
- SAM-3 disabled tab → Task 16 (rendered disabled with VRAM tooltip). ✓
- Route/placeholder cleanup → Task 18. ✓
- Real-browser verification → Task 19. ✓
- Explicitly out of scope items (Sequences list screen, Tags screen,
  Select mode, standalone-frame upload UI, baked-in thumbnail overlays)
  — correctly not present in any task.

**Placeholder scan:** no TBD/TODO markers remain in task bodies; the one
open judgment call (Task 11's freehand-brush compositing limitation) is
flagged as an explicit decision point for Task 19's verification pass,
with a concrete fix described if it surfaces — not a placeholder.

**Type consistency:** `FrameEditorState`/`FrameEditorStore` (Task 7) used
identically in Tasks 10-17. `PromptDraft` shape
(`{type, coords, label, mask_png?}`) matches the backend's `PromptIn`
schema (`backend/app/jobs/schemas.py:30-34`) field-for-field.
`AnnotationRead.mask_url` (Task 5) is the field name used consistently in
Tasks 10, 13. `useSam2Predict`/`useSam2Track` (Task 15) match
`Sam2PredictRequest`/`Sam2TrackRequest` (`backend/app/jobs/schemas.py:60-72`)
field-for-field, including `Sam2TrackRequest`'s `anchor_frame_id`,
`backward`, `forward`.
