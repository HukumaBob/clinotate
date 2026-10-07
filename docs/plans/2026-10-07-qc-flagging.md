# QC Flagging Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** On the QC run view, let a person flag processed frames as `fp` (nothing real) or `fn` (a real object to label), and send the flagged frames into the platform as an ordinary `Sequence` backed by the QC video, ready for the existing frame editor and the Dataset screen.

**Architecture:** The `inference` backend module gains a `qc_flags` table (one row per processed frame of a run), flag endpoints, and a synchronous commit that cuts the flagged frames from the stored video in one pass and creates a `Sequence` plus `Frame` rows (`fp` frames are saved as `no_findings_reviewed`). `sequences.origin_qc_run_id` records the origin. The frontend adds a flagging UI to `RunViewPage` (buttons and F/N keys that snap to a processed frame, strip marks, a Flags panel, a commit dialog, counts).

**Tech Stack:** FastAPI, SQLAlchemy, Alembic, OpenCV, MinIO (boto3); React 19, TypeScript, TanStack Query v5, Vitest 4, Testing Library.

**Spec:** [docs/specs/2026-10-07-qc-flagging-design.md](../specs/2026-10-07-qc-flagging-design.md). Builds on the inference and inspection sub-projects (both implemented).

## Global Constraints

- English only: code, comments, docstrings, UI copy, commit messages. No Russian in the repo.
- Work directly on `master`; no branches, no worktrees. Never commit `yolo_qc_playground_architecture.pdf` (untracked, the user's).
- Dark theme only; no light-background classes.
- Frontend API access only through `apiClient`; never hand-edit `frontend/src/shared/api/generated/`. After any backend schema or route change regenerate `openapi.json` (`cd backend && PYTHONPATH=. uv run python scripts/export_openapi.py`, then check `git diff --stat openapi.json`) and then `cd frontend && npm run generate-api`.
- Backend tests must never write to the real `endoscopy` database: use `import app.db as db_module` and `db_module.SessionLocal()`, never `from app.db import SessionLocal`. Every fixture deletes what it creates.
- All binary data goes through `StorageService`. The only sanctioned temp-file use is OpenCV needing a real path (as `media/service.py` already does).
- `taxonomy_version` does not apply: this sub-project creates no `Annotation`.
- A flag points at a **processed** frame: `frame_index >= 0` and a multiple of the run's `frame_stride`.
- Unique `(run_id, frame_index)` on flags; flagging a frame already sent to training answers 409.
- Commit is all or nothing and synchronous; a frame number past the end of the video answers 422 with nothing created.
- `sequences.origin_qc_run_id` is a plain integer with NO foreign key (the origin must outlive deleting the run).
- Keys: `F` = false positive, `N` = missed object; matched by physical key (`KeyF`/`KeyN`) so they work on any layout; ignored while typing and with Ctrl/Meta/Alt; ignored while the commit dialog is open.
- Every commit message ends with `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>` as a second `-m`.
- The dev stack is running (backend :8000, frontend :5173, ml-worker). Do not stop or restart any dev server or touch ports unless a task says so. Inference run #82 in the dev database is the user's: never delete or modify it.

## Review Focus

Inputs the spec implies but no happy-path test covers; each has a test in the named task.

1. A commit that fails midway (a frame past the end of the video, or storage failing on the Nth upload) must leave no sequence, no frame rows, no uploaded objects, and the flags still pending (Task 4).
2. Committing twice, or two commits at once, must never send the same frame to training twice (Task 4: the second commit is 409; Task 3: unique constraint and 409 on re-flagging a sent frame).
3. A flag on a frame the model never processed (not a multiple of the stride) must be refused, not stored (Task 3).
4. Changing or removing a flag that was already sent must be refused (Tasks 3 and 5).
5. Deleting a run that has pending and sent flags must work, and the sequence it created must keep its origin (Task 4).
6. The F/N keys must work on a non-US layout, must not fire while typing or with modifiers, and must not fire behind the open commit dialog (Task 5 and Task 7).

## File Structure

Create:
- `backend/alembic/versions/e5f6a7b8c9d0_add_qc_flags.py`
- `backend/tests/test_qc_flags_model.py`, `backend/tests/test_extract_frames_at.py`, `backend/tests/test_qc_flags_api.py`
- `frontend/src/entities/useQcFlags.ts` (+ test)
- `frontend/src/features/qc/processedFrame.ts`, `flagDecision.ts` (+ tests)
- `frontend/src/features/qc/FlagButtons.tsx`, `FlagsPanel.tsx`, `CommitDialog.tsx` (+ tests)

Modify:
- `backend/app/inference/models.py`, `schemas.py`, `service.py`, `router.py`
- `backend/app/media/models.py`, `schemas.py`, `router.py` (the `_sequence_read` helper), `service.py`
- `backend/tests/conftest.py` (teardown of the new rows)
- `frontend/src/features/qc/eventKeys.ts` (+ test), `TimelineStrip.tsx`, `RunViewPage.tsx`, `RunsTable.tsx` (+ test), and any test fixture that builds an `InferenceRun` or `Sequence`
- `docs/specs/2026-10-07-qc-flagging-design.md`, `ROADMAP.md`, `openapi.json`

---

### Task 1: Data model, migration and the origin column

**Files:**
- Modify: `backend/app/inference/models.py`, `backend/app/media/models.py`, `backend/app/media/schemas.py`, `backend/app/media/router.py`, `backend/tests/conftest.py`
- Create: `backend/alembic/versions/e5f6a7b8c9d0_add_qc_flags.py`, `backend/tests/test_qc_flags_model.py`

**Interfaces:**
- Produces: `app.inference.models.QcFlagKind` (`FP = "fp"`, `FN = "fn"`), `app.inference.models.QcFlag` (columns as in the spec), `Sequence.origin_qc_run_id: int | None`, and `SequenceRead.origin_qc_run_id: int | None = None`. Later tasks use these names verbatim.

- [ ] **Step 1: Write the failing tests**

Create `backend/tests/test_qc_flags_model.py`:

```python
import app.db as db_module
import app.main  # noqa: F401 -- registers every model on Base.metadata
import pytest
from sqlalchemy.exc import IntegrityError

from app.inference.models import InferenceRun, InferenceRunStatus, QcFlag, QcFlagKind
from app.media.models import Frame, Sequence


def _run(session, rows) -> InferenceRun:
    run = InferenceRun(
        video_id=rows.video_id,
        model_version_id=rows.detect_version_id,
        model_name="seed-detection",
        frame_stride=5,
        status=InferenceRunStatus.SUCCEEDED,
        created_by_id=rows.user_id,
    )
    session.add(run)
    session.commit()
    return run


def _flag(run_id: int, user_id: int, frame_index: int = 5, **overrides) -> QcFlag:
    return QcFlag(
        run_id=run_id,
        kind=QcFlagKind.FP,
        frame_index=frame_index,
        timestamp_ms=frame_index * 100,
        created_by_id=user_id,
        **overrides,
    )


def test_a_frame_of_a_run_can_be_flagged_only_once(committed_inference_rows):
    rows = committed_inference_rows
    session = db_module.SessionLocal()
    try:
        run = _run(session, rows)
        session.add(_flag(run.id, rows.user_id))
        session.commit()
        session.add(_flag(run.id, rows.user_id))
        with pytest.raises(IntegrityError):
            session.commit()
        session.rollback()
        # A different frame of the same run is fine.
        session.add(_flag(run.id, rows.user_id, frame_index=10))
        session.commit()
    finally:
        session.close()


def test_deleting_a_run_deletes_its_flags(committed_inference_rows):
    rows = committed_inference_rows
    session = db_module.SessionLocal()
    try:
        run = _run(session, rows)
        run_id = run.id
        session.add(_flag(run_id, rows.user_id))
        session.commit()

        session.query(InferenceRun).filter(InferenceRun.id == run_id).delete()
        session.commit()

        assert session.query(QcFlag).filter(QcFlag.run_id == run_id).count() == 0
    finally:
        session.close()


def test_deleting_the_frame_keeps_the_flag_as_history(committed_inference_rows):
    rows = committed_inference_rows
    session = db_module.SessionLocal()
    try:
        run = _run(session, rows)
        sequence = Sequence(video_id=rows.video_id, name="qc", origin_qc_run_id=run.id)
        session.add(sequence)
        session.flush()
        frame = Frame(
            sequence_id=sequence.id, storage_key="frames/x/0.png", frame_index=0, width=1, height=1
        )
        session.add(frame)
        session.flush()
        flag = _flag(run.id, rows.user_id, frame_id=frame.id)
        session.add(flag)
        session.commit()
        flag_id, frame_id = flag.id, frame.id

        session.query(Frame).filter(Frame.id == frame_id).delete()
        session.commit()
        session.expire_all()

        assert session.get(QcFlag, flag_id).frame_id is None
    finally:
        session.close()


def test_a_sequence_keeps_its_origin_after_the_run_is_deleted(committed_inference_rows):
    """origin_qc_run_id has no foreign key on purpose."""
    rows = committed_inference_rows
    session = db_module.SessionLocal()
    try:
        run = _run(session, rows)
        run_id = run.id
        sequence = Sequence(video_id=rows.video_id, name="qc", origin_qc_run_id=run_id)
        session.add(sequence)
        session.commit()
        sequence_id = sequence.id

        session.query(InferenceRun).filter(InferenceRun.id == run_id).delete()
        session.commit()
        session.expire_all()

        assert session.get(Sequence, sequence_id).origin_qc_run_id == run_id
    finally:
        session.close()
```

In `backend/tests/conftest.py`, inside the teardown of `committed_inference_rows`, add (before the line `session.query(Video).filter(Video.id.in_(video_ids)).delete(...)`):

```python
    from app.media.models import Frame, Sequence

    sequence_ids = [
        row[0] for row in session.query(Sequence.id).filter(Sequence.video_id.in_(video_ids)).all()
    ]
    if sequence_ids:
        session.query(Frame).filter(Frame.sequence_id.in_(sequence_ids)).delete(
            synchronize_session=False
        )
        session.query(Sequence).filter(Sequence.id.in_(sequence_ids)).delete(
            synchronize_session=False
        )
```

(The flags go with their runs through `ON DELETE CASCADE`; the runs are deleted earlier in the same teardown.)

- [ ] **Step 2: Run them to verify they fail**

Run: `cd backend && uv run pytest tests/test_qc_flags_model.py -v`
Expected: FAIL with `ImportError: cannot import name 'QcFlag'`.

- [ ] **Step 3: Implement**

In `backend/app/inference/models.py` change the imports to include `UniqueConstraint` and append:

```python
class QcFlagKind(str, enum.Enum):
    """fp: nothing real in the frame (saved as a hard negative).
    fn: a real object needs labelling (saved unannotated)."""

    FP = "fp"
    FN = "fn"


class QcFlag(Base):
    """A reviewer's mark on one processed frame of a run.

    Pending until a commit turns it into a Frame (committed_at/frame_id).
    Deleted with its run; the Sequence a commit created is not.
    """

    __tablename__ = "qc_flags"
    __table_args__ = (UniqueConstraint("run_id", "frame_index", name="uq_qc_flags_run_frame"),)

    id: Mapped[int] = mapped_column(primary_key=True)
    run_id: Mapped[int] = mapped_column(ForeignKey("inference_runs.id", ondelete="CASCADE"))
    kind: Mapped[QcFlagKind] = mapped_column(Enum(QcFlagKind))
    frame_index: Mapped[int] = mapped_column(Integer)
    timestamp_ms: Mapped[int] = mapped_column(Integer)
    note: Mapped[str | None] = mapped_column(String(500), nullable=True)
    created_by_id: Mapped[int] = mapped_column(ForeignKey("users.id"))
    committed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    frame_id: Mapped[int | None] = mapped_column(
        ForeignKey("frames.id", ondelete="SET NULL"), nullable=True
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=lambda: datetime.now(timezone.utc)
    )
```

In `backend/app/media/models.py` add to `Sequence` (after `crop_box`):

```python
    # The QC run whose flagged frames this sequence was made from. A plain
    # integer, not a foreign key: the origin must outlive deleting the run.
    origin_qc_run_id: Mapped[int | None] = mapped_column(Integer, nullable=True)
```

In `backend/app/media/schemas.py` add `origin_qc_run_id: int | None = None` to `SequenceRead` (after `crop_box`), and in `backend/app/media/router.py` `_sequence_read` add `origin_qc_run_id=sequence.origin_qc_run_id,` to the `SequenceRead(...)` call.

Create `backend/alembic/versions/e5f6a7b8c9d0_add_qc_flags.py`:

```python
"""add qc flags

Revision ID: e5f6a7b8c9d0
Revises: d3e4f5a6b7c8
Create Date: 2026-10-07 00:00:00.000000

"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = 'e5f6a7b8c9d0'
down_revision: Union[str, Sequence[str], None] = 'd3e4f5a6b7c8'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    # Postgres enums store the member NAME, so the values are upper case.
    op.execute("DO $$BEGIN IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'qcflagkind') THEN CREATE TYPE qcflagkind AS ENUM ('FP', 'FN'); END IF; END$$")

    op.create_table(
        'qc_flags',
        sa.Column('id', sa.Integer(), nullable=False),
        sa.Column('run_id', sa.Integer(), nullable=False),
        sa.Column('kind', postgresql.ENUM('FP', 'FN', name='qcflagkind', create_type=False), nullable=False),
        sa.Column('frame_index', sa.Integer(), nullable=False),
        sa.Column('timestamp_ms', sa.Integer(), nullable=False),
        sa.Column('note', sa.String(length=500), nullable=True),
        sa.Column('created_by_id', sa.Integer(), nullable=False),
        sa.Column('committed_at', sa.DateTime(timezone=True), nullable=True),
        sa.Column('frame_id', sa.Integer(), nullable=True),
        sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(['run_id'], ['inference_runs.id'], ondelete='CASCADE'),
        sa.ForeignKeyConstraint(['created_by_id'], ['users.id'], ),
        sa.ForeignKeyConstraint(['frame_id'], ['frames.id'], ondelete='SET NULL'),
        sa.PrimaryKeyConstraint('id'),
        sa.UniqueConstraint('run_id', 'frame_index', name='uq_qc_flags_run_frame'),
    )

    op.add_column('sequences', sa.Column('origin_qc_run_id', sa.Integer(), nullable=True))


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_column('sequences', 'origin_qc_run_id')
    op.drop_table('qc_flags')
    sa.Enum(name='qcflagkind').drop(op.get_bind(), checkfirst=True)
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd backend && uv run pytest tests/test_qc_flags_model.py tests/test_inference_api.py tests/test_media.py -v`
Expected: PASS (the existing inference and media suites must still pass: the fixture teardown changed and `SequenceRead` gained a defaulted field). Compare any failure elsewhere with the ~16 known pre-existing backend failures; none may mention `qc_flags`, `inference` or `sequence`.

- [ ] **Step 5: Apply the migration to the dev database**

The migration is additive. Run: `cd backend && uv run alembic upgrade head` and expect `Running upgrade d3e4f5a6b7c8 -> e5f6a7b8c9d0, add qc flags`. Verify: `docker compose exec -T postgres psql -U endoscopy -d endoscopy -c "\d qc_flags"` lists the columns and the unique constraint, and `\d sequences` shows `origin_qc_run_id`. Then `uv run alembic heads` shows a single head `e5f6a7b8c9d0`. Do not touch any data.

- [ ] **Step 6: Commit**

```bash
git add backend/app/inference/models.py backend/app/media/models.py backend/app/media/schemas.py backend/app/media/router.py backend/alembic/versions/e5f6a7b8c9d0_add_qc_flags.py backend/tests/conftest.py backend/tests/test_qc_flags_model.py
git commit -m "feat: add qc_flags and the sequence origin column" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Cut exact frames from a video

**Files:**
- Modify: `backend/app/media/service.py`
- Test: `backend/tests/test_extract_frames_at.py`

**Interfaces:**
- Produces: `app.media.service.FramesOutOfRange(Exception)` with attribute `indices: list[int]`, and `extract_frames_at(video_bytes: bytes, frame_indices: list[int]) -> list[tuple[int, bytes, int, int]]` returning `(frame_index, png_bytes, width, height)` for each distinct requested index in ascending order. An unopenable video raises `ValueError`; an index past the end raises `FramesOutOfRange`.

- [ ] **Step 1: Write the failing tests**

Create `backend/tests/test_extract_frames_at.py`:

```python
import tempfile

import cv2
import numpy as np
import pytest

from app.media.service import FramesOutOfRange, extract_frames_at


def make_video(frames: int = 20, fps: int = 10, size=(64, 48)) -> bytes:
    """Frame i is a flat gray of value i * 10, so a frame's content names its number."""
    with tempfile.NamedTemporaryFile(suffix=".avi") as tmp:
        writer = cv2.VideoWriter(tmp.name, cv2.VideoWriter_fourcc(*"MJPG"), fps, size)
        for i in range(frames):
            writer.write(np.full((size[1], size[0], 3), i * 10, dtype=np.uint8))
        writer.release()
        return open(tmp.name, "rb").read()


def gray_of(png: bytes) -> float:
    return float(cv2.imdecode(np.frombuffer(png, np.uint8), cv2.IMREAD_COLOR).mean())


def test_returns_the_exact_frames_in_ascending_order():
    result = extract_frames_at(make_video(), [7, 2, 5])
    assert [index for index, *_ in result] == [2, 5, 7]
    for index, png, width, height in result:
        assert gray_of(png) == pytest.approx(index * 10, abs=6)
        assert (width, height) == (64, 48)


def test_duplicate_indices_are_returned_once():
    result = extract_frames_at(make_video(), [4, 4, 4])
    assert [index for index, *_ in result] == [4]


def test_frame_zero_and_the_last_frame_are_reachable():
    result = extract_frames_at(make_video(frames=20), [0, 19])
    assert [index for index, *_ in result] == [0, 19]


def test_an_index_past_the_end_raises_and_lists_every_such_index():
    with pytest.raises(FramesOutOfRange) as caught:
        extract_frames_at(make_video(frames=20), [3, 20, 99])
    assert caught.value.indices == [20, 99]


def test_an_empty_request_returns_nothing():
    assert extract_frames_at(make_video(), []) == []


def test_bytes_that_are_not_a_video_raise_value_error():
    with pytest.raises(ValueError, match="video"):
        extract_frames_at(b"this is not a video", [0])
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd backend && uv run pytest tests/test_extract_frames_at.py -v`
Expected: FAIL with `ImportError: cannot import name 'extract_frames_at'`.

- [ ] **Step 3: Implement**

In `backend/app/media/service.py`, below `extract_frames`, add:

```python
class FramesOutOfRange(Exception):
    """Some requested frame numbers are past the end of the video."""

    def __init__(self, indices: list[int]) -> None:
        self.indices = indices
        super().__init__(f"Frames past the end of the video: {indices}")


def extract_frames_at(
    video_bytes: bytes, frame_indices: list[int]
) -> list[tuple[int, bytes, int, int]]:
    """Cut exact frames by number in ONE sequential pass over the video.

    Returns (frame_index, png_bytes, width, height) for each distinct
    requested index, ascending. The pass uses grab()/retrieve() the way the
    inference adapter does, so a frame number addresses the very frame the
    model saw. Seeking (CAP_PROP_POS_FRAMES) is not used: on some codecs it
    lands on the wrong frame, and these frames become training data.
    """
    wanted = sorted(set(frame_indices))
    if not wanted:
        return []

    results: list[tuple[int, bytes, int, int]] = []
    with tempfile.NamedTemporaryFile(suffix=".mp4") as tmp:
        tmp.write(video_bytes)
        tmp.flush()
        capture = cv2.VideoCapture(tmp.name)
        if not capture.isOpened():
            capture.release()
            raise ValueError("Could not open the video file")
        try:
            position = 0
            index = 0
            while position < len(wanted) and capture.grab():
                if index == wanted[position]:
                    success, frame = capture.retrieve()
                    if not success:
                        raise ValueError(f"Could not decode video frame {index}")
                    encoded, buffer = cv2.imencode(".png", frame)
                    if not encoded:
                        raise ValueError(f"Could not encode video frame {index}")
                    height, width = frame.shape[:2]
                    results.append((index, buffer.tobytes(), width, height))
                    position += 1
                index += 1
        finally:
            capture.release()

    if position < len(wanted):
        raise FramesOutOfRange(wanted[position:])
    return results
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd backend && uv run pytest tests/test_extract_frames_at.py tests/test_media_service.py -v`
Expected: PASS. If OpenCV in the backend venv cannot open the MJPG `.avi` bytes under the `.mp4` temp-file name, change only the test helper to write with `cv2.VideoWriter_fourcc(*"mp4v")` into a `.mp4` file and say so in your report; do not change the production suffix logic.

- [ ] **Step 5: Commit**

```bash
git add backend/app/media/service.py backend/tests/test_extract_frames_at.py
git commit -m "feat: cut exact video frames by number" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Flag endpoints and the run counters

**Files:**
- Modify: `backend/app/inference/schemas.py`, `service.py`, `router.py`
- Test: `backend/tests/test_qc_flags_api.py` (created here; Task 4 extends it)
- Regenerate: `openapi.json`

**Interfaces:**
- Consumes: `QcFlag`, `QcFlagKind` (Task 1).
- Produces (HTTP):
  - `PUT /inference/runs/{run_id}/flags` body `{frame_index: int >= 0, timestamp_ms: int >= 0, kind: "fp" | "fn", note?: str (max 500) | null}` -> 200 `QcFlagRead`
  - `GET /inference/runs/{run_id}/flags` -> `list[QcFlagRead]` ordered by `frame_index`
  - `DELETE /inference/runs/{run_id}/flags/{flag_id}` -> 204
  - `QcFlagRead`: `id, run_id, kind, frame_index, timestamp_ms, note, created_by_id, committed_at, frame_id, sequence_id` (`sequence_id` is `int | null`, the sequence of the committed frame)
  - `InferenceRunRead` gains `flags_pending: int` and `flags_committed: int` on every endpoint that returns a run.
- Produces (Python, `app.inference.service`): exceptions `RunNotSucceeded`, `NotAProcessedFrame`, `FlagNotFound`, `FlagAlreadyCommitted`; functions `put_flag(session, run_id, *, frame_index, timestamp_ms, kind, note, user) -> QcFlag`, `list_flags(session, run_id) -> list[tuple[QcFlag, int | None]]`, `delete_flag(session, run_id, flag_id) -> None`, `run_read(session, run) -> InferenceRunRead`, `runs_read(session, runs) -> list[InferenceRunRead]`.

- [ ] **Step 1: Write the failing tests**

Create `backend/tests/test_qc_flags_api.py`:

```python
import app.db as db_module
import app.main  # noqa: F401 -- registers every model on Base.metadata
from fastapi.testclient import TestClient

from app.inference.models import InferenceRun, InferenceRunStatus, QcFlag
from app.main import app
from app.storage import get_storage_service

client = TestClient(app)


def _register_and_login(email: str) -> dict[str, str]:
    client.post("/auth/register", json={"email": email, "password": "pass1234", "role": "admin"})
    response = client.post("/auth/login", json={"email": email, "password": "pass1234"})
    return {"Authorization": f"Bearer {response.json()['access_token']}"}


def _make_run(rows, *, status=InferenceRunStatus.SUCCEEDED, frame_stride=5, video_id=None) -> int:
    session = db_module.SessionLocal()
    try:
        run = InferenceRun(
            video_id=video_id or rows.video_id,
            model_version_id=rows.detect_version_id,
            model_name="seed-detection",
            frame_stride=frame_stride,
            status=status,
            created_by_id=rows.user_id,
        )
        session.add(run)
        session.commit()
        return run.id
    finally:
        session.close()


def _put(headers, run_id, frame_index=5, kind="fp", note=None, timestamp_ms=None):
    body = {
        "frame_index": frame_index,
        "timestamp_ms": frame_index * 100 if timestamp_ms is None else timestamp_ms,
        "kind": kind,
    }
    if note is not None:
        body["note"] = note
    return client.put(f"/inference/runs/{run_id}/flags", headers=headers, json=body)


def test_putting_a_flag_creates_it(committed_inference_rows):
    headers = _register_and_login("flag-create@example.com")
    run_id = _make_run(committed_inference_rows)

    response = _put(headers, run_id, frame_index=10, kind="fn", note="missed polyp")

    assert response.status_code == 200
    body = response.json()
    assert body["run_id"] == run_id
    assert body["kind"] == "fn"
    assert body["frame_index"] == 10
    assert body["timestamp_ms"] == 1000
    assert body["note"] == "missed polyp"
    assert body["committed_at"] is None
    assert body["frame_id"] is None
    assert body["sequence_id"] is None


def test_putting_the_same_frame_again_changes_the_kind_and_note(committed_inference_rows):
    headers = _register_and_login("flag-change@example.com")
    run_id = _make_run(committed_inference_rows)
    first = _put(headers, run_id, kind="fp").json()

    second = _put(headers, run_id, kind="fn", note="actually a miss").json()

    assert second["id"] == first["id"]
    assert second["kind"] == "fn"
    assert second["note"] == "actually a miss"
    assert len(client.get(f"/inference/runs/{run_id}/flags", headers=headers).json()) == 1


def test_a_frame_the_model_never_processed_is_refused(committed_inference_rows):
    headers = _register_and_login("flag-stride@example.com")
    run_id = _make_run(committed_inference_rows, frame_stride=5)

    response = _put(headers, run_id, frame_index=7)

    assert response.status_code == 422
    assert "processed" in response.json()["detail"].lower()
    assert client.get(f"/inference/runs/{run_id}/flags", headers=headers).json() == []


def test_stride_one_accepts_every_frame(committed_inference_rows):
    headers = _register_and_login("flag-stride1@example.com")
    run_id = _make_run(committed_inference_rows, frame_stride=1)
    assert _put(headers, run_id, frame_index=7).status_code == 200


def test_a_run_that_has_not_succeeded_cannot_be_flagged(committed_inference_rows):
    headers = _register_and_login("flag-notready@example.com")
    run_id = _make_run(committed_inference_rows, status=InferenceRunStatus.RUNNING)
    assert _put(headers, run_id).status_code == 409


def test_an_unknown_run_is_404(committed_inference_rows):
    headers = _register_and_login("flag-norun@example.com")
    assert _put(headers, 999999).status_code == 404
    assert client.get("/inference/runs/999999/flags", headers=headers).status_code == 404


def test_a_negative_frame_index_is_rejected(committed_inference_rows):
    headers = _register_and_login("flag-negative@example.com")
    run_id = _make_run(committed_inference_rows)
    assert _put(headers, run_id, frame_index=-5).status_code == 422


def test_a_note_longer_than_500_characters_is_rejected(committed_inference_rows):
    headers = _register_and_login("flag-longnote@example.com")
    run_id = _make_run(committed_inference_rows)
    assert _put(headers, run_id, note="x" * 501).status_code == 422
    assert _put(headers, run_id, note="x" * 500).status_code == 200


def test_listing_is_ordered_by_frame(committed_inference_rows):
    headers = _register_and_login("flag-list@example.com")
    run_id = _make_run(committed_inference_rows)
    for frame_index in (20, 0, 10):
        _put(headers, run_id, frame_index=frame_index)

    listed = client.get(f"/inference/runs/{run_id}/flags", headers=headers).json()

    assert [flag["frame_index"] for flag in listed] == [0, 10, 20]


def test_a_pending_flag_can_be_removed(committed_inference_rows):
    headers = _register_and_login("flag-remove@example.com")
    run_id = _make_run(committed_inference_rows)
    flag_id = _put(headers, run_id).json()["id"]

    assert client.delete(f"/inference/runs/{run_id}/flags/{flag_id}", headers=headers).status_code == 204
    assert client.get(f"/inference/runs/{run_id}/flags", headers=headers).json() == []


def test_removing_an_unknown_flag_or_one_of_another_run_is_404(committed_inference_rows):
    headers = _register_and_login("flag-remove404@example.com")
    run_a = _make_run(committed_inference_rows)
    run_b = _make_run(committed_inference_rows)
    flag_id = _put(headers, run_a).json()["id"]

    assert client.delete(f"/inference/runs/{run_a}/flags/999999", headers=headers).status_code == 404
    assert client.delete(f"/inference/runs/{run_b}/flags/{flag_id}", headers=headers).status_code == 404


def _commit_a_flag_directly(run_id: int, frame_index: int = 5) -> int:
    """Mark a flag as already sent, without going through the commit endpoint."""
    from datetime import datetime, timezone

    session = db_module.SessionLocal()
    try:
        flag = session.query(QcFlag).filter_by(run_id=run_id, frame_index=frame_index).one()
        flag.committed_at = datetime.now(timezone.utc)
        session.commit()
        return flag.id
    finally:
        session.close()


def test_a_sent_flag_can_neither_be_changed_nor_removed(committed_inference_rows):
    headers = _register_and_login("flag-sent@example.com")
    run_id = _make_run(committed_inference_rows)
    flag_id = _put(headers, run_id, frame_index=5).json()["id"]
    _commit_a_flag_directly(run_id, 5)

    again = _put(headers, run_id, frame_index=5, kind="fn")
    removed = client.delete(f"/inference/runs/{run_id}/flags/{flag_id}", headers=headers)

    assert again.status_code == 409
    assert "sent" in again.json()["detail"].lower()
    assert removed.status_code == 409


def test_the_run_reports_how_many_flags_are_pending_and_sent(committed_inference_rows):
    headers = _register_and_login("flag-counts@example.com")
    run_id = _make_run(committed_inference_rows)
    _put(headers, run_id, frame_index=0)
    _put(headers, run_id, frame_index=5)
    _put(headers, run_id, frame_index=10)
    _commit_a_flag_directly(run_id, 0)

    as_list = [r for r in client.get("/inference/runs", headers=headers).json() if r["id"] == run_id][0]
    as_one = client.get(f"/inference/runs/{run_id}", headers=headers).json()

    assert (as_list["flags_pending"], as_list["flags_committed"]) == (2, 1)
    assert (as_one["flags_pending"], as_one["flags_committed"]) == (2, 1)


def test_a_run_with_no_flags_reports_zero(committed_inference_rows):
    headers = _register_and_login("flag-zero@example.com")
    run_id = _make_run(committed_inference_rows)
    body = client.get(f"/inference/runs/{run_id}", headers=headers).json()
    assert (body["flags_pending"], body["flags_committed"]) == (0, 0)


def test_deleting_a_run_deletes_its_pending_flags(committed_inference_rows):
    headers = _register_and_login("flag-rundelete@example.com")
    run_id = _make_run(committed_inference_rows)
    _put(headers, run_id)

    class _NoStorage:
        def delete(self, key):  # a run with no predictions has nothing to delete
            raise AssertionError("nothing should be deleted from storage")

    app.dependency_overrides[get_storage_service] = lambda: _NoStorage()
    try:
        assert client.delete(f"/inference/runs/{run_id}", headers=headers).status_code == 204
    finally:
        app.dependency_overrides.pop(get_storage_service, None)

    session = db_module.SessionLocal()
    try:
        assert session.query(QcFlag).filter_by(run_id=run_id).count() == 0
    finally:
        session.close()
```

(Task 4 adds the commit tests, the helpers `FakeStorage`/`make_video` and the imports they need to this same file.)

- [ ] **Step 2: Run them to verify they fail**

Run: `cd backend && uv run pytest tests/test_qc_flags_api.py -v`
Expected: FAIL (404 for the new routes; `KeyError: 'flags_pending'`).

- [ ] **Step 3: Implement the schemas**

In `backend/app/inference/schemas.py` add (imports: `from app.inference.models import InferenceRunStatus, QcFlagKind`):

```python
class QcFlagPut(BaseModel):
    frame_index: int = Field(ge=0)
    timestamp_ms: int = Field(ge=0)
    kind: QcFlagKind
    note: str | None = Field(default=None, max_length=500)


class QcFlagRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    run_id: int
    kind: QcFlagKind
    frame_index: int
    timestamp_ms: int
    note: str | None
    created_by_id: int
    committed_at: datetime | None
    frame_id: int | None
    # The sequence of the committed frame; None while pending.
    sequence_id: int | None = None
```

and add to `InferenceRunRead` (after `finished_at`):

```python
    flags_pending: int = 0
    flags_committed: int = 0
```

- [ ] **Step 4: Implement the service**

In `backend/app/inference/service.py` add `QcFlag, QcFlagKind` to the model import, `from sqlalchemy import func, select` (extend the existing `select` import), `from sqlalchemy.exc import IntegrityError`, `from app.media.models import Frame, Video` (extend the existing `Video` import), `from app.inference.schemas import InferenceRunRead`, then add:

```python
class RunNotSucceeded(Exception):
    """Flags and commits need a finished run."""


class NotAProcessedFrame(Exception):
    """The frame number is not one the model processed (not a multiple of the stride)."""


class FlagNotFound(Exception):
    """No such flag on this run."""


class FlagAlreadyCommitted(Exception):
    """The flag was already sent to training and can no longer change."""


def _require_flaggable_run(session: Session, run_id: int) -> InferenceRun:
    run = get_run(session, run_id)
    if run.status != InferenceRunStatus.SUCCEEDED:
        raise RunNotSucceeded(f"Inference run {run_id} is {run.status.value}")
    return run


def put_flag(
    session: Session,
    run_id: int,
    *,
    frame_index: int,
    timestamp_ms: int,
    kind: QcFlagKind,
    note: str | None,
    user: User,
) -> QcFlag:
    """Create the flag for this frame, or change a pending one.

    The frame must be one the model processed: a "missed object" on a frame
    it never saw would be a false statistic. The check uses the stride, so
    the (large) predictions document is not downloaded per flag.
    """
    run = _require_flaggable_run(session, run_id)
    if frame_index % run.frame_stride != 0:
        raise NotAProcessedFrame(
            f"Frame {frame_index} was not processed by this run (stride {run.frame_stride})"
        )

    def _existing() -> QcFlag | None:
        return session.scalars(
            select(QcFlag).where(QcFlag.run_id == run_id, QcFlag.frame_index == frame_index)
        ).first()

    flag = _existing()
    if flag is not None and flag.committed_at is not None:
        raise FlagAlreadyCommitted(f"Frame {frame_index} was already sent to training")
    if flag is None:
        flag = QcFlag(
            run_id=run_id,
            frame_index=frame_index,
            timestamp_ms=timestamp_ms,
            kind=kind,
            note=note,
            created_by_id=user.id,
        )
        session.add(flag)
        try:
            session.commit()
        except IntegrityError:
            # A concurrent request created it first: fall through to a change.
            session.rollback()
            flag = _existing()
            if flag is None:
                raise
        else:
            session.refresh(flag)
            return flag
    if flag.committed_at is not None:
        raise FlagAlreadyCommitted(f"Frame {frame_index} was already sent to training")
    flag.kind = kind
    flag.note = note
    flag.timestamp_ms = timestamp_ms
    session.commit()
    session.refresh(flag)
    return flag


def list_flags(session: Session, run_id: int) -> list[tuple[QcFlag, int | None]]:
    """The run's flags by frame, each with the sequence of its committed frame."""
    get_run(session, run_id)
    rows = session.execute(
        select(QcFlag, Frame.sequence_id)
        .outerjoin(Frame, QcFlag.frame_id == Frame.id)
        .where(QcFlag.run_id == run_id)
        .order_by(QcFlag.frame_index)
    ).all()
    return [(flag, sequence_id) for flag, sequence_id in rows]


def delete_flag(session: Session, run_id: int, flag_id: int) -> None:
    get_run(session, run_id)
    flag = session.get(QcFlag, flag_id)
    if flag is None or flag.run_id != run_id:
        raise FlagNotFound(f"Flag {flag_id} not found on run {run_id}")
    if flag.committed_at is not None:
        raise FlagAlreadyCommitted("A flag already sent to training cannot be removed")
    session.delete(flag)
    session.commit()


def _flag_counts(session: Session, run_ids: list[int]) -> dict[int, tuple[int, int]]:
    if not run_ids:
        return {}
    rows = session.execute(
        select(
            QcFlag.run_id,
            func.count().filter(QcFlag.committed_at.is_(None)),
            func.count().filter(QcFlag.committed_at.is_not(None)),
        )
        .where(QcFlag.run_id.in_(run_ids))
        .group_by(QcFlag.run_id)
    ).all()
    return {run_id: (pending, committed) for run_id, pending, committed in rows}


def runs_read(session: Session, runs: list[InferenceRun]) -> list[InferenceRunRead]:
    counts = _flag_counts(session, [run.id for run in runs])
    result = []
    for run in runs:
        pending, committed = counts.get(run.id, (0, 0))
        read = InferenceRunRead.model_validate(run)
        read.flags_pending = pending
        read.flags_committed = committed
        result.append(read)
    return result


def run_read(session: Session, run: InferenceRun) -> InferenceRunRead:
    return runs_read(session, [run])[0]
```

- [ ] **Step 5: Implement the router**

In `backend/app/inference/router.py` add imports (`QcFlagPut, QcFlagRead` from schemas), then change the two read endpoints and add the three flag endpoints:

```python
@router.get("/runs", response_model=list[InferenceRunRead])
def list_runs(session: Session = Depends(get_session)):
    return service.runs_read(session, service.list_runs(session))


@router.get("/runs/{run_id}", response_model=InferenceRunRead)
def get_run(run_id: int, session: Session = Depends(get_session)):
    try:
        return service.run_read(session, service.get_run(session, run_id))
    except service.InferenceRunNotFound as exc:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(exc))


def _flag_read(flag, sequence_id: int | None) -> QcFlagRead:
    read = QcFlagRead.model_validate(flag)
    read.sequence_id = sequence_id
    return read


@router.put("/runs/{run_id}/flags", response_model=QcFlagRead)
def put_flag(
    run_id: int,
    body: QcFlagPut,
    current_user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    try:
        flag = service.put_flag(
            session,
            run_id,
            frame_index=body.frame_index,
            timestamp_ms=body.timestamp_ms,
            kind=body.kind,
            note=body.note,
            user=current_user,
        )
    except service.InferenceRunNotFound as exc:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(exc))
    except (service.RunNotSucceeded, service.FlagAlreadyCommitted) as exc:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=str(exc))
    except service.NotAProcessedFrame as exc:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail=str(exc))
    return _flag_read(flag, None)


@router.get("/runs/{run_id}/flags", response_model=list[QcFlagRead])
def list_flags(run_id: int, session: Session = Depends(get_session)):
    try:
        return [_flag_read(flag, seq) for flag, seq in service.list_flags(session, run_id)]
    except service.InferenceRunNotFound as exc:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(exc))


@router.delete("/runs/{run_id}/flags/{flag_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_flag(run_id: int, flag_id: int, session: Session = Depends(get_session)):
    try:
        service.delete_flag(session, run_id, flag_id)
    except (service.InferenceRunNotFound, service.FlagNotFound) as exc:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(exc))
    except service.FlagAlreadyCommitted as exc:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=str(exc))
```

Replace the existing `list_runs` and `get_run` route functions (do not leave duplicates). `create_run` keeps returning the ORM run (its counters are 0 by default).

- [ ] **Step 6: Run the tests to verify they pass**

Run: `cd backend && uv run pytest tests/test_qc_flags_api.py tests/test_inference_api.py tests/test_qc_flags_model.py -v`
Expected: all PASS (the existing inference suite must still pass with the changed read endpoints).

- [ ] **Step 7: Regenerate `openapi.json`**

Run: `cd backend && PYTHONPATH=. uv run python scripts/export_openapi.py && git diff --stat openapi.json`
Expected: `openapi.json` changed (new flag routes, `QcFlagRead`, `flags_pending`, `origin_qc_run_id`).

- [ ] **Step 8: Commit**

```bash
git add backend/app/inference/schemas.py backend/app/inference/service.py backend/app/inference/router.py backend/tests/test_qc_flags_api.py openapi.json
git commit -m "feat: add the QC flag endpoints and run counters" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Commit the flags to a sequence

**Files:**
- Modify: `backend/app/inference/schemas.py`, `service.py`, `router.py`, `backend/tests/test_qc_flags_api.py`
- Regenerate: `openapi.json`

**Interfaces:**
- Consumes: `extract_frames_at`, `FramesOutOfRange` (Task 2); `QcFlag` etc. (Tasks 1 and 3); `app.media.schemas.SequenceRead`.
- Produces (HTTP):
  - `POST /inference/runs/{run_id}/commit` body `{name?: str (max 255) | null}` -> 201 `SequenceRead` (409 run not succeeded or no pending flags; 422 frames past the end or an unreadable video)
  - `GET /inference/videos/{video_id}/sent` -> `{sequences: int, frames: int}` (404 unknown video)
- Produces (Python): `service.commit_flags(session, storage, run_id, *, name, user) -> Sequence`; exceptions `NoPendingFlags`, `FramesPastEnd(indices)`, `VideoUnreadable`; `service.video_sent(session, video_id) -> tuple[int, int]`; schema `VideoSentRead {sequences: int, frames: int}` and `QcCommitRequest {name: str | None}`.

- [ ] **Step 1: Write the failing tests**

Append to `backend/tests/test_qc_flags_api.py` (and add `import tempfile`, `import cv2`, `import numpy as np`, `import pytest` to the import block at the top of the file):

```python
from app.media.models import Frame, Sequence


def make_video(frames: int = 30, fps: int = 10, size=(64, 48)) -> bytes:
    """Frame i is a flat gray of value i * 8, so a frame's content names its number."""
    with tempfile.NamedTemporaryFile(suffix=".avi") as tmp:
        writer = cv2.VideoWriter(tmp.name, cv2.VideoWriter_fourcc(*"MJPG"), fps, size)
        for i in range(frames):
            writer.write(np.full((size[1], size[0], 3), i * 8, dtype=np.uint8))
        writer.release()
        return open(tmp.name, "rb").read()


class FakeStorage:
    def __init__(self, objects=None, fail_on_upload=None):
        self.objects = dict(objects or {})
        self.fail_on_upload = fail_on_upload
        self.uploads = 0

    def download(self, key):
        return self.objects[key]

    def upload(self, key, data, content_type):
        self.uploads += 1
        if self.fail_on_upload == self.uploads:
            raise RuntimeError("storage down")
        self.objects[key] = data

    def delete(self, key):
        self.objects.pop(key, None)

    def url_for(self, key):
        return f"http://example/{key}"


@pytest.fixture
def fake_storage(committed_inference_rows):
    storage = FakeStorage({"videos/inference-playable.mp4": make_video()})
    app.dependency_overrides[get_storage_service] = lambda: storage
    yield storage
    app.dependency_overrides.pop(get_storage_service, None)


def _commit(headers, run_id, **body):
    return client.post(f"/inference/runs/{run_id}/commit", headers=headers, json=body)


def _flag_three(headers, run_id):
    _put(headers, run_id, frame_index=0, kind="fp")
    _put(headers, run_id, frame_index=10, kind="fn")
    _put(headers, run_id, frame_index=25, kind="fp")


def _my_id(headers) -> int:
    return client.get("/auth/me", headers=headers).json()["id"]


def test_commit_creates_a_sequence_with_the_flagged_frames(committed_inference_rows, fake_storage):
    headers = _register_and_login("commit-happy@example.com")
    rows = committed_inference_rows
    run_id = _make_run(rows)
    _flag_three(headers, run_id)

    response = _commit(headers, run_id)

    assert response.status_code == 201
    sequence = response.json()
    assert sequence["video_id"] == rows.video_id
    assert sequence["origin_qc_run_id"] == run_id
    assert sequence["name"].startswith("QC · inference-playable · run #")
    assert sequence["annotation_count"] == 0

    session = db_module.SessionLocal()
    try:
        frames = (
            session.query(Frame).filter_by(sequence_id=sequence["id"]).order_by(Frame.frame_index).all()
        )
        assert [f.frame_index for f in frames] == [0, 1, 2]
        assert [f.no_findings_reviewed for f in frames] == [True, False, True]  # fp, fn, fp
        assert frames[0].no_findings_reviewed_by_id == _my_id(headers)
        assert frames[1].no_findings_reviewed_by_id is None
        assert (frames[0].width, frames[0].height) == (64, 48)
        # the frame is the one asked for: flat gray of value index * 8
        for frame, source_index in zip(frames, (0, 10, 25)):
            decoded = cv2.imdecode(
                np.frombuffer(fake_storage.objects[frame.storage_key], np.uint8), cv2.IMREAD_COLOR
            )
            assert float(decoded.mean()) == pytest.approx(source_index * 8, abs=6)
        stored = session.query(QcFlag).filter_by(run_id=run_id).order_by(QcFlag.frame_index).all()
        assert all(flag.committed_at is not None for flag in stored)
        assert [flag.frame_id for flag in stored] == [f.id for f in frames]
        seq_row = session.get(Sequence, sequence["id"])
        assert seq_row.start_time == 0
        assert seq_row.duration == 3  # 0 ms to 2500 ms, rounded up
    finally:
        session.close()


def test_the_flag_list_then_points_at_the_sequence(committed_inference_rows, fake_storage):
    headers = _register_and_login("commit-listing@example.com")
    run_id = _make_run(committed_inference_rows)
    _flag_three(headers, run_id)
    sequence_id = _commit(headers, run_id).json()["id"]

    listed = client.get(f"/inference/runs/{run_id}/flags", headers=headers).json()

    assert {flag["sequence_id"] for flag in listed} == {sequence_id}
    assert all(flag["committed_at"] is not None for flag in listed)
    run = client.get(f"/inference/runs/{run_id}", headers=headers).json()
    assert (run["flags_pending"], run["flags_committed"]) == (0, 3)


def test_a_second_commit_finds_nothing_pending(committed_inference_rows, fake_storage):
    headers = _register_and_login("commit-twice@example.com")
    run_id = _make_run(committed_inference_rows)
    _flag_three(headers, run_id)
    assert _commit(headers, run_id).status_code == 201
    uploads_after_first = fake_storage.uploads

    second = _commit(headers, run_id)

    assert second.status_code == 409
    assert "pending" in second.json()["detail"].lower()
    assert fake_storage.uploads == uploads_after_first


def test_commit_without_flags_is_409(committed_inference_rows, fake_storage):
    headers = _register_and_login("commit-empty@example.com")
    assert _commit(headers, _make_run(committed_inference_rows)).status_code == 409


def test_commit_on_a_run_that_has_not_succeeded_is_409(committed_inference_rows, fake_storage):
    headers = _register_and_login("commit-notready@example.com")
    run_id = _make_run(committed_inference_rows, status=InferenceRunStatus.FAILED)
    assert _commit(headers, run_id).status_code == 409


def test_commit_on_an_unknown_run_is_404(committed_inference_rows, fake_storage):
    headers = _register_and_login("commit-404@example.com")
    assert _commit(headers, 999999).status_code == 404


def test_a_custom_name_is_used(committed_inference_rows, fake_storage):
    headers = _register_and_login("commit-name@example.com")
    run_id = _make_run(committed_inference_rows)
    _put(headers, run_id, frame_index=5)

    response = _commit(headers, run_id, name="Hard negatives, May")

    assert response.json()["name"] == "Hard negatives, May"


def test_a_name_longer_than_255_characters_is_rejected(committed_inference_rows, fake_storage):
    headers = _register_and_login("commit-longname@example.com")
    run_id = _make_run(committed_inference_rows)
    _put(headers, run_id, frame_index=5)
    assert _commit(headers, run_id, name="x" * 256).status_code == 422


def test_a_frame_past_the_end_of_the_video_creates_nothing(committed_inference_rows, fake_storage):
    headers = _register_and_login("commit-pastend@example.com")
    rows = committed_inference_rows
    run_id = _make_run(rows)  # the video has 30 frames
    _put(headers, run_id, frame_index=5)
    _put(headers, run_id, frame_index=100)
    objects_before = dict(fake_storage.objects)

    response = _commit(headers, run_id)

    assert response.status_code == 422
    assert "100" in response.json()["detail"]
    session = db_module.SessionLocal()
    try:
        assert session.query(Sequence).filter_by(video_id=rows.video_id).count() == 0
        assert all(f.committed_at is None for f in session.query(QcFlag).filter_by(run_id=run_id))
    finally:
        session.close()
    assert fake_storage.objects == objects_before


def test_a_storage_failure_midway_rolls_everything_back(committed_inference_rows):
    headers = _register_and_login("commit-storagefail@example.com")
    rows = committed_inference_rows
    storage = FakeStorage({"videos/inference-playable.mp4": make_video()}, fail_on_upload=2)
    app.dependency_overrides[get_storage_service] = lambda: storage
    failing_client = TestClient(app, raise_server_exceptions=False)
    try:
        run_id = _make_run(rows)
        _flag_three(headers, run_id)
        objects_before = dict(storage.objects)

        response = failing_client.post(
            f"/inference/runs/{run_id}/commit", headers=headers, json={}
        )

        assert response.status_code == 500
        # the first upload succeeded before the second failed: it must be gone again
        assert storage.objects == objects_before
        session = db_module.SessionLocal()
        try:
            assert session.query(Sequence).filter_by(video_id=rows.video_id).count() == 0
            flags = session.query(QcFlag).filter_by(run_id=run_id).all()
            assert len(flags) == 3
            assert all(f.committed_at is None and f.frame_id is None for f in flags)
        finally:
            session.close()
    finally:
        app.dependency_overrides.pop(get_storage_service, None)


def test_a_commit_after_a_failed_one_succeeds(committed_inference_rows):
    headers = _register_and_login("commit-retry@example.com")
    rows = committed_inference_rows
    storage = FakeStorage({"videos/inference-playable.mp4": make_video()}, fail_on_upload=1)
    app.dependency_overrides[get_storage_service] = lambda: storage
    failing_client = TestClient(app, raise_server_exceptions=False)
    try:
        run_id = _make_run(rows)
        _flag_three(headers, run_id)
        assert (
            failing_client.post(f"/inference/runs/{run_id}/commit", headers=headers, json={}).status_code
            == 500
        )
        assert _commit(headers, run_id).status_code == 201  # later uploads no longer fail
    finally:
        app.dependency_overrides.pop(get_storage_service, None)


def test_the_video_reports_what_was_sent_to_training(committed_inference_rows, fake_storage):
    headers = _register_and_login("commit-sent@example.com")
    rows = committed_inference_rows
    run_id = _make_run(rows)
    before = client.get(f"/inference/videos/{rows.video_id}/sent", headers=headers).json()
    _flag_three(headers, run_id)
    _commit(headers, run_id)

    after = client.get(f"/inference/videos/{rows.video_id}/sent", headers=headers).json()

    assert before == {"sequences": 0, "frames": 0}
    assert after == {"sequences": 1, "frames": 3}
    assert client.get("/inference/videos/999999/sent", headers=headers).status_code == 404


def test_a_sequence_keeps_its_origin_when_its_run_is_deleted(committed_inference_rows, fake_storage):
    headers = _register_and_login("commit-rundelete@example.com")
    rows = committed_inference_rows
    run_id = _make_run(rows)
    _flag_three(headers, run_id)
    sequence_id = _commit(headers, run_id).json()["id"]
    _put(headers, run_id, frame_index=15)  # a pending flag too

    assert client.delete(f"/inference/runs/{run_id}", headers=headers).status_code == 204

    session = db_module.SessionLocal()
    try:
        assert session.get(Sequence, sequence_id).origin_qc_run_id == run_id
        assert session.query(QcFlag).filter_by(run_id=run_id).count() == 0
        assert session.query(Frame).filter_by(sequence_id=sequence_id).count() == 3
    finally:
        session.close()
    sent = client.get(f"/inference/videos/{rows.video_id}/sent", headers=headers).json()
    assert sent == {"sequences": 1, "frames": 3}  # the note survives the run


def test_a_second_run_of_the_same_video_can_flag_the_same_frame(committed_inference_rows, fake_storage):
    """Uniqueness is per run: another run is a different QC session."""
    headers = _register_and_login("commit-tworuns@example.com")
    rows = committed_inference_rows
    run_a, run_b = _make_run(rows), _make_run(rows)
    assert _put(headers, run_a, frame_index=5).status_code == 200
    assert _put(headers, run_b, frame_index=5).status_code == 200
```

The commit tests rely on `committed_inference_rows` (Task 1) and on the new `fake_storage` fixture above, which overrides the storage dependency for the test and removes the override afterwards.

- [ ] **Step 2: Run them to verify they fail**

Run: `cd backend && uv run pytest tests/test_qc_flags_api.py -v`
Expected: the Task 3 tests still PASS; the new commit/sent tests FAIL (404 for the new routes).

- [ ] **Step 3: Implement schemas**

In `backend/app/inference/schemas.py` add:

```python
class QcCommitRequest(BaseModel):
    name: str | None = Field(default=None, max_length=255)


class VideoSentRead(BaseModel):
    sequences: int
    frames: int
```

- [ ] **Step 4: Implement the service**

In `backend/app/inference/service.py` add imports (`math`, `from datetime import date`, `from app.media.models import Frame, Sequence, Video`, `from app.media.service import FramesOutOfRange, extract_frames_at`) and:

```python
class NoPendingFlags(Exception):
    """Nothing is waiting to be sent."""


class FramesPastEnd(Exception):
    def __init__(self, indices: list[int]) -> None:
        self.indices = indices
        super().__init__(f"Frames past the end of the video: {indices}")


class VideoUnreadable(Exception):
    """The stored video could not be opened or decoded."""


def _default_sequence_name(video: Video, run: InferenceRun) -> str:
    return f"QC · {video.title} · run #{run.id} · {date.today().isoformat()}"[:255]


def commit_flags(
    session: Session,
    storage: StorageService,
    run_id: int,
    *,
    name: str | None,
    user: User,
) -> Sequence:
    """Send the pending flags to training as one new Sequence (all or nothing).

    The pending flags are locked (FOR UPDATE) so two commits cannot send the
    same frame twice: the second finds nothing pending. Frames are cut in
    one pass by exact number; objects are uploaded and the rows written
    only after that succeeds, and a failure after uploading deletes what
    was uploaded and rolls the database back.
    """
    run = _require_flaggable_run(session, run_id)
    flags = list(
        session.scalars(
            select(QcFlag)
            .where(QcFlag.run_id == run_id, QcFlag.committed_at.is_(None))
            .order_by(QcFlag.frame_index)
            .with_for_update()
        )
    )
    if not flags:
        session.rollback()
        raise NoPendingFlags(f"Inference run {run_id} has no pending flags")

    video = session.get(Video, run.video_id)
    try:
        extracted = extract_frames_at(
            storage.download(video.storage_key), [flag.frame_index for flag in flags]
        )
    except FramesOutOfRange as exc:
        session.rollback()
        raise FramesPastEnd(exc.indices) from exc
    except ValueError as exc:
        session.rollback()
        raise VideoUnreadable(str(exc)) from exc

    now = datetime.now(timezone.utc)
    first_ms = min(flag.timestamp_ms for flag in flags)
    last_ms = max(flag.timestamp_ms for flag in flags)
    uploaded: list[str] = []
    try:
        sequence = Sequence(
            video_id=video.id,
            procedure_id=video.procedure_id,
            name=name or _default_sequence_name(video, run),
            start_time=first_ms // 1000,
            duration=math.ceil((last_ms - first_ms) / 1000),
            origin_qc_run_id=run.id,
        )
        session.add(sequence)
        session.flush()

        created: list[tuple[QcFlag, Frame]] = []
        for position, (flag, (_, png, width, height)) in enumerate(zip(flags, extracted)):
            key = f"frames/{sequence.id}/{position}.png"
            storage.upload(key, png, content_type="image/png")
            uploaded.append(key)
            frame = Frame(
                sequence_id=sequence.id,
                storage_key=key,
                frame_index=position,
                width=width,
                height=height,
                size_bytes=len(png),
            )
            if flag.kind == QcFlagKind.FP:
                frame.no_findings_reviewed = True
                frame.no_findings_reviewed_by_id = user.id
                frame.no_findings_reviewed_at = now
            session.add(frame)
            created.append((flag, frame))
        session.flush()
        for flag, frame in created:
            flag.committed_at = now
            flag.frame_id = frame.id
        session.commit()
    except Exception:
        session.rollback()
        for key in uploaded:
            try:
                storage.delete(key)
            except Exception:  # noqa: BLE001 -- best effort; the DB is already rolled back
                logger.warning("commit_flags: could not remove %s", key)
        raise
    session.refresh(sequence)
    return sequence


def video_sent(session: Session, video_id: int) -> tuple[int, int]:
    """How many sequences and frames of this video were already sent to training."""
    if session.get(Video, video_id) is None:
        raise VideoNotFound(f"Video {video_id} not found")
    sequence_ids = [
        row[0]
        for row in session.query(Sequence.id)
        .filter(Sequence.video_id == video_id, Sequence.origin_qc_run_id.is_not(None))
        .all()
    ]
    if not sequence_ids:
        return 0, 0
    frames = session.query(Frame).filter(Frame.sequence_id.in_(sequence_ids)).count()
    return len(sequence_ids), frames
```

(`zip(flags, extracted)` is correct because both are ascending by frame number and flags are unique per run.)

- [ ] **Step 5: Implement the router**

In `backend/app/inference/router.py` add imports (`QcCommitRequest`, `VideoSentRead` from schemas; `from app.media.schemas import SequenceRead`) and:

```python
@router.post("/runs/{run_id}/commit", response_model=SequenceRead, status_code=status.HTTP_201_CREATED)
def commit_flags(
    run_id: int,
    body: QcCommitRequest,
    current_user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
    storage: StorageService = Depends(get_storage_service),
):
    try:
        sequence = service.commit_flags(
            session, storage, run_id, name=body.name, user=current_user
        )
    except service.InferenceRunNotFound as exc:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(exc))
    except (service.RunNotSucceeded, service.NoPendingFlags) as exc:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=str(exc))
    except (service.FramesPastEnd, service.VideoUnreadable) as exc:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail=str(exc))
    return SequenceRead(
        id=sequence.id,
        name=sequence.name,
        video_id=sequence.video_id,
        procedure_id=sequence.procedure_id,
        start_time=sequence.start_time,
        duration=sequence.duration,
        annotation_count=0,
        crop_box=None,
        origin_qc_run_id=sequence.origin_qc_run_id,
    )


@router.get("/videos/{video_id}/sent", response_model=VideoSentRead)
def video_sent(video_id: int, session: Session = Depends(get_session)):
    try:
        sequences, frames = service.video_sent(session, video_id)
    except service.VideoNotFound as exc:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(exc))
    return VideoSentRead(sequences=sequences, frames=frames)
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `cd backend && uv run pytest tests/test_qc_flags_api.py tests/test_inference_api.py tests/test_qc_flags_model.py tests/test_extract_frames_at.py tests/test_media.py -v`
Expected: all PASS. If a test hangs at session teardown, an earlier test failed mid-fixture and left a session open: fix the failing test, do not skip it.

- [ ] **Step 7: Regenerate `openapi.json` and commit**

Run: `cd backend && PYTHONPATH=. uv run python scripts/export_openapi.py && git diff --stat openapi.json`

```bash
git add backend/app/inference backend/tests/test_qc_flags_api.py openapi.json
git commit -m "feat: send flagged QC frames to training as a sequence" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Client helpers and hooks

**Files:**
- Modify: `frontend/src/features/qc/eventKeys.ts`, `frontend/src/features/qc/eventKeys.test.ts`
- Create: `frontend/src/features/qc/processedFrame.ts` (+ test), `flagDecision.ts` (+ test), `frontend/src/entities/useQcFlags.ts` (+ test)

**Interfaces:**
- Consumes: the generated schema after `cd frontend && npm run generate-api` (types `QcFlagRead`, `SequenceRead`, `VideoSentRead`, body schema `QcFlagPut`); `PredictionsDocument` from `predictions.ts`.
- Produces:
  - `eventKeys.ts`: `flagKindFor(event: Pick<KeyboardEvent, "key" | "code" | "ctrlKey" | "metaKey" | "altKey">): "fp" | "fn" | null`.
  - `processedFrame.ts`: `interface ProcessedFrame { frameIndex: number; timestampMs: number }`, `buildProcessedFrames(doc: PredictionsDocument): ProcessedFrame[]` (sorted by time), `processedFrameAt(frames: ProcessedFrame[], timeMs: number): ProcessedFrame | null` (the frame at or before the time; null before the first or when empty).
  - `flagDecision.ts`: `type FlagKind = "fp" | "fn"`, `type FlagAction = "create" | "change" | "remove" | "blocked"`, `decideFlagAction(existing: { kind: FlagKind; committed: boolean } | undefined, pressed: FlagKind): FlagAction`.
  - `useQcFlags.ts`: `type QcFlag = components["schemas"]["QcFlagRead"]`, `useQcFlags(runId: number | null)`, `usePutQcFlag(runId: number | null)`, `useDeleteQcFlag(runId: number | null)`, `useCommitQcFlags(runId: number | null, videoId: number | null)`, `useVideoSent(videoId: number | null)`.

- [ ] **Step 1: Regenerate the API types**

Run: `cd frontend && npm run generate-api`
Expected: `src/shared/api/generated/schema.d.ts` now contains `QcFlagRead` and `flags_pending` (gitignored; nothing to commit).

- [ ] **Step 2: Write the failing tests**

Create `frontend/src/features/qc/processedFrame.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import { buildProcessedFrames, processedFrameAt } from "./processedFrame";
import type { PredictionsDocument } from "./predictions";

const doc = (frames: Record<string, { timestamp_ms: number }>): PredictionsDocument => ({
  task_type: "detection",
  model: { name: "m", version_id: 1 },
  fps: 10,
  frame_stride: 5,
  classes: ["polyp"],
  frames: Object.fromEntries(
    Object.entries(frames).map(([k, v]) => [k, { timestamp_ms: v.timestamp_ms, detections: [] }]),
  ),
});

describe("buildProcessedFrames", () => {
  it("returns the frames sorted by time with numeric frame indices", () => {
    const frames = buildProcessedFrames(
      doc({ "10": { timestamp_ms: 1000 }, "0": { timestamp_ms: 0 }, "5": { timestamp_ms: 500 } }),
    );
    expect(frames).toEqual([
      { frameIndex: 0, timestampMs: 0 },
      { frameIndex: 5, timestampMs: 500 },
      { frameIndex: 10, timestampMs: 1000 },
    ]);
  });

  it("is empty for a document with no frames", () => {
    expect(buildProcessedFrames(doc({}))).toEqual([]);
  });
});

describe("processedFrameAt", () => {
  const frames = buildProcessedFrames(
    doc({ "0": { timestamp_ms: 0 }, "5": { timestamp_ms: 500 }, "10": { timestamp_ms: 1000 } }),
  );

  it("returns the frame exactly at the time", () => {
    expect(processedFrameAt(frames, 500)).toEqual({ frameIndex: 5, timestampMs: 500 });
  });

  it("returns the frame at or before the time, never the next one", () => {
    expect(processedFrameAt(frames, 499)).toEqual({ frameIndex: 0, timestampMs: 0 });
    expect(processedFrameAt(frames, 999)).toEqual({ frameIndex: 5, timestampMs: 500 });
  });

  it("returns the last frame for a time past the end", () => {
    expect(processedFrameAt(frames, 99999)).toEqual({ frameIndex: 10, timestampMs: 1000 });
  });

  it("returns null before the first frame and for an empty list", () => {
    expect(processedFrameAt(frames, -1)).toBeNull();
    expect(processedFrameAt([], 100)).toBeNull();
  });

  it("works when the first frame is not at zero", () => {
    const late = buildProcessedFrames(doc({ "5": { timestamp_ms: 500 } }));
    expect(processedFrameAt(late, 100)).toBeNull();
    expect(processedFrameAt(late, 500)).toEqual({ frameIndex: 5, timestampMs: 500 });
  });
});
```

Create `frontend/src/features/qc/flagDecision.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import { decideFlagAction } from "./flagDecision";

describe("decideFlagAction", () => {
  it("creates a flag on an unflagged frame", () => {
    expect(decideFlagAction(undefined, "fp")).toBe("create");
    expect(decideFlagAction(undefined, "fn")).toBe("create");
  });

  it("removes the flag when the same kind is pressed again", () => {
    expect(decideFlagAction({ kind: "fp", committed: false }, "fp")).toBe("remove");
    expect(decideFlagAction({ kind: "fn", committed: false }, "fn")).toBe("remove");
  });

  it("changes the flag when the other kind is pressed", () => {
    expect(decideFlagAction({ kind: "fp", committed: false }, "fn")).toBe("change");
    expect(decideFlagAction({ kind: "fn", committed: false }, "fp")).toBe("change");
  });

  it("blocks any change to a flag already sent to training", () => {
    expect(decideFlagAction({ kind: "fp", committed: true }, "fp")).toBe("blocked");
    expect(decideFlagAction({ kind: "fp", committed: true }, "fn")).toBe("blocked");
  });
});
```

Append to `frontend/src/features/qc/eventKeys.test.ts` (keep the existing imports; add `flagKindFor` to the import from `./eventKeys`):

```ts
describe("flagKindFor", () => {
  const key = (init: Partial<KeyboardEvent>) =>
    ({ key: "", code: "", ctrlKey: false, metaKey: false, altKey: false, ...init }) as KeyboardEvent;

  it("maps F to a false positive and N to a missed object", () => {
    expect(flagKindFor(key({ key: "f", code: "KeyF" }))).toBe("fp");
    expect(flagKindFor(key({ key: "n", code: "KeyN" }))).toBe("fn");
  });

  it("accepts capital letters (Shift or Caps Lock)", () => {
    expect(flagKindFor(key({ key: "F", code: "KeyF" }))).toBe("fp");
    expect(flagKindFor(key({ key: "N", code: "KeyN" }))).toBe("fn");
  });

  it("works on a Russian layout, where the same physical keys give other letters", () => {
    expect(flagKindFor(key({ key: "а", code: "KeyF" }))).toBe("fp");
    expect(flagKindFor(key({ key: "т", code: "KeyN" }))).toBe("fn");
  });

  it("ignores the keys with Ctrl, Meta or Alt held", () => {
    expect(flagKindFor(key({ key: "f", code: "KeyF", ctrlKey: true }))).toBeNull();
    expect(flagKindFor(key({ key: "n", code: "KeyN", metaKey: true }))).toBeNull();
    expect(flagKindFor(key({ key: "f", code: "KeyF", altKey: true }))).toBeNull();
  });

  it("ignores every other key", () => {
    expect(flagKindFor(key({ key: "g", code: "KeyG" }))).toBeNull();
    expect(flagKindFor(key({ key: "[", code: "BracketLeft" }))).toBeNull();
  });
});
```

Create `frontend/src/entities/useQcFlags.test.tsx`:

```tsx
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { apiClient } from "../shared/api/client";
import {
  useCommitQcFlags,
  useDeleteQcFlag,
  usePutQcFlag,
  useQcFlags,
  useVideoSent,
} from "./useQcFlags";

vi.mock("../shared/api/client", () => ({
  apiClient: { GET: vi.fn(), PUT: vi.fn(), DELETE: vi.fn(), POST: vi.fn() },
}));

function setup() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const invalidate = vi.spyOn(queryClient, "invalidateQueries");
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  return { wrapper, invalidate };
}

afterEach(() => vi.clearAllMocks());

describe("useQcFlags", () => {
  it("lists the flags of the run", async () => {
    vi.mocked(apiClient.GET).mockResolvedValue({ data: [{ id: 1 }] } as never);
    const { wrapper } = setup();
    const { result } = renderHook(() => useQcFlags(7), { wrapper });
    await waitFor(() => expect(result.current.data).toEqual([{ id: 1 }]));
    expect(apiClient.GET).toHaveBeenCalledWith("/inference/runs/{run_id}/flags", {
      params: { path: { run_id: 7 } },
    });
  });

  it("does not fetch without a run id", () => {
    const { wrapper } = setup();
    renderHook(() => useQcFlags(null), { wrapper });
    expect(apiClient.GET).not.toHaveBeenCalled();
  });
});

describe("usePutQcFlag", () => {
  it("sends the flag and refreshes the flags and the run counters", async () => {
    vi.mocked(apiClient.PUT).mockResolvedValue({ data: { id: 1 } } as never);
    const { wrapper, invalidate } = setup();
    const { result } = renderHook(() => usePutQcFlag(7), { wrapper });

    await act(async () => {
      await result.current.mutateAsync({ frame_index: 10, timestamp_ms: 1000, kind: "fn", note: null });
    });

    expect(apiClient.PUT).toHaveBeenCalledWith("/inference/runs/{run_id}/flags", {
      params: { path: { run_id: 7 } },
      body: { frame_index: 10, timestamp_ms: 1000, kind: "fn", note: null },
    });
    const keys = invalidate.mock.calls.map((call) => JSON.stringify(call[0]?.queryKey));
    expect(keys).toContain(JSON.stringify(["qc-flags", 7]));
    expect(keys).toContain(JSON.stringify(["inference-run", 7]));
    expect(keys).toContain(JSON.stringify(["inference-runs"]));
  });

  it("surfaces the server's error body", async () => {
    vi.mocked(apiClient.PUT).mockResolvedValue({ error: { detail: "already sent" } } as never);
    const { wrapper } = setup();
    const { result } = renderHook(() => usePutQcFlag(7), { wrapper });
    await act(async () => {
      await expect(
        result.current.mutateAsync({ frame_index: 0, timestamp_ms: 0, kind: "fp", note: null }),
      ).rejects.toEqual({ detail: "already sent" });
    });
  });
});

describe("useDeleteQcFlag", () => {
  it("removes the flag and refreshes", async () => {
    vi.mocked(apiClient.DELETE).mockResolvedValue({} as never);
    const { wrapper, invalidate } = setup();
    const { result } = renderHook(() => useDeleteQcFlag(7), { wrapper });
    await act(async () => {
      await result.current.mutateAsync(3);
    });
    expect(apiClient.DELETE).toHaveBeenCalledWith("/inference/runs/{run_id}/flags/{flag_id}", {
      params: { path: { run_id: 7, flag_id: 3 } },
    });
    expect(invalidate.mock.calls.map((c) => JSON.stringify(c[0]?.queryKey))).toContain(
      JSON.stringify(["qc-flags", 7]),
    );
  });
});

describe("useCommitQcFlags", () => {
  it("commits with the name and refreshes flags, runs, the video count and its sequences", async () => {
    vi.mocked(apiClient.POST).mockResolvedValue({ data: { id: 12, name: "QC" } } as never);
    const { wrapper, invalidate } = setup();
    const { result } = renderHook(() => useCommitQcFlags(7, 99), { wrapper });

    await act(async () => {
      await result.current.mutateAsync({ name: "QC" });
    });

    expect(apiClient.POST).toHaveBeenCalledWith("/inference/runs/{run_id}/commit", {
      params: { path: { run_id: 7 } },
      body: { name: "QC" },
    });
    const keys = invalidate.mock.calls.map((c) => JSON.stringify(c[0]?.queryKey));
    expect(keys).toContain(JSON.stringify(["qc-flags", 7]));
    expect(keys).toContain(JSON.stringify(["inference-runs"]));
    expect(keys).toContain(JSON.stringify(["video-sent", 99]));
    expect(keys).toContain(JSON.stringify(["video-sequences", 99]));
  });
});

describe("useVideoSent", () => {
  it("reads how much of the video was sent", async () => {
    vi.mocked(apiClient.GET).mockResolvedValue({ data: { sequences: 1, frames: 3 } } as never);
    const { wrapper } = setup();
    const { result } = renderHook(() => useVideoSent(5), { wrapper });
    await waitFor(() => expect(result.current.data).toEqual({ sequences: 1, frames: 3 }));
    expect(apiClient.GET).toHaveBeenCalledWith("/inference/videos/{video_id}/sent", {
      params: { path: { video_id: 5 } },
    });
  });
});
```

- [ ] **Step 3: Run them to verify they fail**

Run: `cd frontend && npx vitest run src/features/qc/processedFrame.test.ts src/features/qc/flagDecision.test.ts src/features/qc/eventKeys.test.ts src/entities/useQcFlags.test.tsx`
Expected: FAIL with "Failed to resolve import" for the new modules and `flagKindFor` not exported.

- [ ] **Step 4: Implement**

Create `frontend/src/features/qc/processedFrame.ts`:

```ts
import type { PredictionsDocument } from "./predictions";

export interface ProcessedFrame {
  frameIndex: number;
  timestampMs: number;
}

/** The frames the model actually processed, sorted by time. Flags may only
 * point at these: with a stride above 1 the other frames were never seen. */
export function buildProcessedFrames(doc: PredictionsDocument): ProcessedFrame[] {
  return Object.entries(doc.frames)
    .map(([key, frame]) => ({ frameIndex: Number(key), timestampMs: frame.timestamp_ms }))
    .sort((a, b) => a.timestampMs - b.timestampMs);
}

/** The processed frame at or before `timeMs` (the one whose predictions the
 * overlay shows), or null before the first frame. */
export function processedFrameAt(frames: ProcessedFrame[], timeMs: number): ProcessedFrame | null {
  if (frames.length === 0 || timeMs < frames[0].timestampMs) return null;
  let low = 0;
  let high = frames.length - 1;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (frames[mid].timestampMs <= timeMs) low = mid;
    else high = mid - 1;
  }
  return frames[low];
}
```

Create `frontend/src/features/qc/flagDecision.ts`:

```ts
export type FlagKind = "fp" | "fn";
export type FlagAction = "create" | "change" | "remove" | "blocked";

/** What pressing a flag key means on a frame, given any flag already there:
 * the same kind toggles it off, the other kind changes it, and a flag
 * already sent to training is never touched. */
export function decideFlagAction(
  existing: { kind: FlagKind; committed: boolean } | undefined,
  pressed: FlagKind,
): FlagAction {
  if (!existing) return "create";
  if (existing.committed) return "blocked";
  return existing.kind === pressed ? "remove" : "change";
}
```

Append to `frontend/src/features/qc/eventKeys.ts`:

```ts
/** F (false positive) and N (missed object), by physical key so any layout
 * works (on a Russian layout the same keys give "а" and "т"). */
export function flagKindFor(
  event: Pick<KeyboardEvent, "key" | "code" | "ctrlKey" | "metaKey" | "altKey">,
): "fp" | "fn" | null {
  if (event.ctrlKey || event.metaKey || event.altKey) return null;
  if (event.code === "KeyF" || event.key === "f" || event.key === "F") return "fp";
  if (event.code === "KeyN" || event.key === "n" || event.key === "N") return "fn";
  return null;
}
```

Create `frontend/src/entities/useQcFlags.ts`:

```ts
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { apiClient } from "../shared/api/client";
import type { components } from "../shared/api/generated/schema";

export type QcFlag = components["schemas"]["QcFlagRead"];
export type QcFlagKind = QcFlag["kind"];

export function useQcFlags(runId: number | null) {
  return useQuery({
    queryKey: ["qc-flags", runId],
    queryFn: async () => {
      const result = await apiClient.GET("/inference/runs/{run_id}/flags", {
        params: { path: { run_id: runId as number } },
      });
      if (result.error) throw result.error;
      return result.data ?? [];
    },
    enabled: runId !== null,
  });
}

/** Flags change the run's pending/sent counters, so the run is refreshed too. */
function useRefreshAfterFlagChange(runId: number | null) {
  const queryClient = useQueryClient();
  return () => {
    void queryClient.invalidateQueries({ queryKey: ["qc-flags", runId] });
    void queryClient.invalidateQueries({ queryKey: ["inference-run", runId] });
    void queryClient.invalidateQueries({ queryKey: ["inference-runs"] });
  };
}

export function usePutQcFlag(runId: number | null) {
  const refresh = useRefreshAfterFlagChange(runId);
  return useMutation({
    mutationFn: async (body: {
      frame_index: number;
      timestamp_ms: number;
      kind: QcFlagKind;
      note?: string | null;
    }) => {
      const result = await apiClient.PUT("/inference/runs/{run_id}/flags", {
        params: { path: { run_id: runId as number } },
        body,
      });
      if (result.error) throw result.error;
      return result.data;
    },
    onSuccess: refresh,
  });
}

export function useDeleteQcFlag(runId: number | null) {
  const refresh = useRefreshAfterFlagChange(runId);
  return useMutation({
    mutationFn: async (flagId: number) => {
      const result = await apiClient.DELETE("/inference/runs/{run_id}/flags/{flag_id}", {
        params: { path: { run_id: runId as number, flag_id: flagId } },
      });
      if (result.error) throw result.error;
    },
    onSuccess: refresh,
  });
}

export function useCommitQcFlags(runId: number | null, videoId: number | null) {
  const queryClient = useQueryClient();
  const refresh = useRefreshAfterFlagChange(runId);
  return useMutation({
    mutationFn: async (body: { name?: string | null }) => {
      const result = await apiClient.POST("/inference/runs/{run_id}/commit", {
        params: { path: { run_id: runId as number } },
        body,
      });
      if (result.error) throw result.error;
      return result.data;
    },
    onSuccess: () => {
      refresh();
      void queryClient.invalidateQueries({ queryKey: ["video-sent", videoId] });
      void queryClient.invalidateQueries({ queryKey: ["video-sequences", videoId] });
    },
  });
}

export function useVideoSent(videoId: number | null) {
  return useQuery({
    queryKey: ["video-sent", videoId],
    queryFn: async () => {
      const result = await apiClient.GET("/inference/videos/{video_id}/sent", {
        params: { path: { video_id: videoId as number } },
      });
      if (result.error) throw result.error;
      return result.data;
    },
    enabled: videoId !== null,
  });
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd frontend && npx vitest run src/features/qc src/entities && npx tsc --noEmit`
Expected: PASS. `tsc` may now fail in EXISTING tests that build an `InferenceRun` or `SequenceRead` literal because the generated types gained fields (`flags_pending`, `flags_committed`, `origin_qc_run_id`): fix those fixtures by adding the new fields (`flags_pending: 0, flags_committed: 0`, `origin_qc_run_id: null`); do not loosen types.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/features/qc/processedFrame.ts frontend/src/features/qc/processedFrame.test.ts frontend/src/features/qc/flagDecision.ts frontend/src/features/qc/flagDecision.test.ts frontend/src/features/qc/eventKeys.ts frontend/src/features/qc/eventKeys.test.ts frontend/src/entities/useQcFlags.ts frontend/src/entities/useQcFlags.test.tsx frontend/src
git commit -m "feat: add the QC flag helpers and hooks" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

(`git add frontend/src` also picks up the fixture fixes from Step 5; check `git status` first so nothing unrelated is staged.)

---

### Task 6: Flag components and the history column

**Files:**
- Create: `frontend/src/features/qc/FlagButtons.tsx`, `FlagsPanel.tsx`, `CommitDialog.tsx` and `*.test.tsx` for each
- Modify: `frontend/src/features/qc/RunsTable.tsx`, `RunsTable.test.tsx`

**Interfaces:**
- Consumes: `QcFlag`, `QcFlagKind` (Task 5); `formatClock` from `analysis/strip.ts`; `InferenceRun` (now with `flags_pending`, `flags_committed`).
- Produces:
  - `FlagButtons` props `{ disabled: boolean; onFlag: (kind: QcFlagKind) => void; snapNote: string | null; error: string | null }`.
  - `FlagsPanel` props `{ flags: QcFlag[]; loadFailed: boolean; onRetry: () => void; onSeek: (ms: number) => void; onRemove: (flagId: number) => void; onNoteChange: (flag: QcFlag, note: string) => void; onSend: () => void; lastSequence: { id: number; name: string } | null }`.
  - `CommitDialog` props `{ fpCount: number; fnCount: number; defaultName: string; error: string | null; submitting: boolean; onConfirm: (name: string) => void; onCancel: () => void }`.

- [ ] **Step 1: Write the failing tests**

Create `frontend/src/features/qc/FlagButtons.test.tsx`:

```tsx
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { FlagButtons } from "./FlagButtons";

function setup(overrides = {}) {
  const props = { disabled: false, onFlag: vi.fn(), snapNote: null, error: null, ...overrides };
  render(<FlagButtons {...props} />);
  return props;
}

describe("FlagButtons", () => {
  it("flags a false positive and a missed object", async () => {
    const user = userEvent.setup();
    const props = setup();
    await user.click(screen.getByRole("button", { name: /false positive/i }));
    await user.click(screen.getByRole("button", { name: /missed object/i }));
    expect(props.onFlag).toHaveBeenNthCalledWith(1, "fp");
    expect(props.onFlag).toHaveBeenNthCalledWith(2, "fn");
  });

  it("announces the keys", () => {
    setup();
    expect(screen.getByRole("button", { name: /false positive/i })).toHaveAttribute("aria-keyshortcuts", "F");
    expect(screen.getByRole("button", { name: /missed object/i })).toHaveAttribute("aria-keyshortcuts", "N");
  });

  it("disables both buttons while the predictions are not ready", () => {
    setup({ disabled: true });
    expect(screen.getByRole("button", { name: /false positive/i })).toBeDisabled();
    expect(screen.getByRole("button", { name: /missed object/i })).toBeDisabled();
  });

  it("shows the snap note and an error", () => {
    setup({ snapNote: "Snapped to processed frame 3:22", error: "This frame was already sent to training" });
    expect(screen.getByText("Snapped to processed frame 3:22")).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("This frame was already sent to training");
  });
});
```

Create `frontend/src/features/qc/CommitDialog.test.tsx`:

```tsx
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { CommitDialog } from "./CommitDialog";

function setup(overrides = {}) {
  const props = {
    fpCount: 2,
    fnCount: 3,
    defaultName: "QC · Colonoscopy A · run #7 · 2026-10-07",
    error: null as string | null,
    submitting: false,
    onConfirm: vi.fn(),
    onCancel: vi.fn(),
    ...overrides,
  };
  render(<CommitDialog {...props} />);
  return props;
}

describe("CommitDialog", () => {
  it("is a modal dialog showing the default name and the summary", () => {
    setup();
    const dialog = screen.getByRole("dialog");
    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(screen.getByLabelText("Sequence name")).toHaveValue("QC · Colonoscopy A · run #7 · 2026-10-07");
    expect(dialog).toHaveTextContent("2 false positives will be saved as negatives");
    expect(dialog).toHaveTextContent("3 missed objects will wait for annotation");
  });

  it("warns that the video stops being an unbiased test", () => {
    setup();
    expect(screen.getByText(/no longer an unbiased test/i)).toBeInTheDocument();
  });

  it("confirms with the edited name", async () => {
    const user = userEvent.setup();
    const props = setup();
    const field = screen.getByLabelText("Sequence name");
    await user.clear(field);
    await user.type(field, "May negatives");
    await user.click(screen.getByRole("button", { name: "Confirm" }));
    expect(props.onConfirm).toHaveBeenCalledWith("May negatives");
  });

  it("cannot confirm an empty name", async () => {
    const user = userEvent.setup();
    setup();
    await user.clear(screen.getByLabelText("Sequence name"));
    expect(screen.getByRole("button", { name: "Confirm" })).toBeDisabled();
  });

  it("cancels with the button and with Escape", async () => {
    const user = userEvent.setup();
    const props = setup();
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    await user.keyboard("{Escape}");
    expect(props.onCancel).toHaveBeenCalledTimes(2);
  });

  it("shows an error and disables Confirm while submitting", () => {
    setup({ error: "Frames past the end of the video: [100]", submitting: true });
    expect(screen.getByRole("alert")).toHaveTextContent("Frames past the end of the video: [100]");
    expect(screen.getByRole("button", { name: /confirm|sending/i })).toBeDisabled();
  });

  it("omits a line whose count is zero", () => {
    setup({ fpCount: 0 });
    expect(screen.queryByText(/false positive/i)).not.toBeInTheDocument();
  });
});
```

Create `frontend/src/features/qc/FlagsPanel.test.tsx`:

```tsx
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";

import type { QcFlag } from "../../entities/useQcFlags";
import { FlagsPanel } from "./FlagsPanel";

const flag = (over: Partial<QcFlag>): QcFlag => ({
  id: 1,
  run_id: 7,
  kind: "fp",
  frame_index: 5,
  timestamp_ms: 202000,
  note: null,
  created_by_id: 1,
  committed_at: null,
  frame_id: null,
  sequence_id: null,
  ...over,
});

function setup(flags: QcFlag[], overrides = {}) {
  const props = {
    flags,
    loadFailed: false,
    onRetry: vi.fn(),
    onSeek: vi.fn(),
    onRemove: vi.fn(),
    onNoteChange: vi.fn(),
    onSend: vi.fn(),
    lastSequence: null as { id: number; name: string } | null,
    ...overrides,
  };
  render(
    <MemoryRouter>
      <FlagsPanel {...props} />
    </MemoryRouter>,
  );
  return props;
}

describe("FlagsPanel", () => {
  it("counts pending and sent flags", () => {
    setup([
      flag({ id: 1 }),
      flag({ id: 2, frame_index: 10 }),
      flag({ id: 3, frame_index: 15, committed_at: "2026-10-07T10:00:00Z", sequence_id: 4 }),
    ]);
    expect(screen.getByText("2 pending · 1 sent")).toBeInTheDocument();
  });

  it("lists pending flags with time and kind, and seeks when the time is clicked", async () => {
    const user = userEvent.setup();
    const props = setup([flag({ id: 1, kind: "fn", timestamp_ms: 202000 })]);
    const item = screen.getByRole("listitem");
    expect(within(item).getByText("FN")).toBeInTheDocument();
    await user.click(within(item).getByRole("button", { name: "3:22" }));
    expect(props.onSeek).toHaveBeenCalledWith(202000);
  });

  it("removes a flag", async () => {
    const user = userEvent.setup();
    const props = setup([flag({ id: 9 })]);
    await user.click(screen.getByRole("button", { name: "Remove flag at 3:22" }));
    expect(props.onRemove).toHaveBeenCalledWith(9);
  });

  it("saves a changed note when the field loses focus, and only then", async () => {
    const user = userEvent.setup();
    const original = flag({ id: 2, note: null });
    const props = setup([original]);
    const field = screen.getByLabelText("Note for flag at 3:22");
    await user.click(field);
    await user.tab();
    expect(props.onNoteChange).not.toHaveBeenCalled(); // unchanged
    await user.click(field);
    await user.type(field, "phantom fold");
    await user.tab();
    expect(props.onNoteChange).toHaveBeenCalledWith(original, "phantom fold");
  });

  it("keeps Send disabled with nothing pending and counts the frames otherwise", async () => {
    const { unmount } = render(
      <MemoryRouter>
        <FlagsPanel
          flags={[]}
          loadFailed={false}
          onRetry={vi.fn()}
          onSeek={vi.fn()}
          onRemove={vi.fn()}
          onNoteChange={vi.fn()}
          onSend={vi.fn()}
          lastSequence={null}
        />
      </MemoryRouter>,
    );
    expect(screen.getByRole("button", { name: /send/i })).toBeDisabled();
    unmount();

    const user = userEvent.setup();
    const props = setup([flag({ id: 1 }), flag({ id: 2, frame_index: 10 })]);
    const send = screen.getByRole("button", { name: "Send 2 frames to training" });
    await user.click(send);
    expect(props.onSend).toHaveBeenCalled();
  });

  it("says 'frame' for exactly one", () => {
    setup([flag({ id: 1 })]);
    expect(screen.getByRole("button", { name: "Send 1 frame to training" })).toBeInTheDocument();
  });

  it("links the sequences the sent frames went into", () => {
    setup([
      flag({ id: 1, committed_at: "2026-10-07T10:00:00Z", sequence_id: 12 }),
      flag({ id: 2, frame_index: 10, committed_at: "2026-10-07T10:00:00Z", sequence_id: 12 }),
      flag({ id: 3, frame_index: 15, committed_at: "2026-10-07T11:00:00Z", sequence_id: 13 }),
    ]);
    expect(screen.getByRole("link", { name: "#12" })).toHaveAttribute("href", "/sequences/12");
    expect(screen.getByRole("link", { name: "#13" })).toHaveAttribute("href", "/sequences/13");
    expect(screen.getAllByRole("link", { name: "#12" })).toHaveLength(1);
  });

  it("shows the sequence that was just created", () => {
    setup([], { lastSequence: { id: 5, name: "QC · A · run #7" } });
    expect(screen.getByText(/Created sequence/)).toHaveTextContent("QC · A · run #7");
    expect(screen.getByRole("link", { name: "Open in editor" })).toHaveAttribute("href", "/sequences/5");
  });

  it("shows a retry when the flags could not be loaded", async () => {
    const user = userEvent.setup();
    const props = setup([], { loadFailed: true });
    expect(screen.getByText(/could not load the flags/i)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Retry" }));
    expect(props.onRetry).toHaveBeenCalled();
  });
});
```

Append to `frontend/src/features/qc/RunsTable.test.tsx` (inside the file, using its existing `run()` helper and `renderTable`; the helper's default run must now include `flags_pending: 0, flags_committed: 0` — add them):

```tsx
describe("RunsTable flags column", () => {
  it("shows pending and sent counts per run", () => {
    renderTable([run({ id: 1, flags_pending: 2, flags_committed: 5 })]);
    expect(screen.getByRole("columnheader", { name: "Flags" })).toBeInTheDocument();
    expect(screen.getByText("2 pending · 5 sent")).toBeInTheDocument();
  });

  it("shows a dash for a run with no flags", () => {
    renderTable([run({ id: 1, flags_pending: 0, flags_committed: 0 })]);
    expect(screen.getByText("—")).toBeInTheDocument();
  });

  it("warns that pending flags are lost before a delete is confirmed", async () => {
    const user = userEvent.setup();
    renderTable([run({ id: 1, flags_pending: 3, flags_committed: 0 })]);
    await user.click(screen.getByRole("button", { name: "Delete" }));
    expect(screen.getByText("3 pending flags will be lost")).toBeInTheDocument();
  });

  it("does not warn when nothing is pending", async () => {
    const user = userEvent.setup();
    renderTable([run({ id: 1, flags_pending: 0, flags_committed: 4 })]);
    await user.click(screen.getByRole("button", { name: "Delete" }));
    expect(screen.queryByText(/will be lost/)).not.toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd frontend && npx vitest run src/features/qc/FlagButtons.test.tsx src/features/qc/CommitDialog.test.tsx src/features/qc/FlagsPanel.test.tsx src/features/qc/RunsTable.test.tsx`
Expected: FAIL (modules missing; no Flags column).

- [ ] **Step 3: Implement**

Create `frontend/src/features/qc/FlagButtons.tsx`:

```tsx
import type { QcFlagKind } from "../../entities/useQcFlags";

interface FlagButtonsProps {
  disabled: boolean;
  onFlag: (kind: QcFlagKind) => void;
  snapNote: string | null;
  error: string | null;
}

const BUTTON =
  "rounded border border-gray-700 px-2 py-1 text-xs text-gray-300 hover:text-gray-100 disabled:opacity-50";

export function FlagButtons({ disabled, onFlag, snapNote, error }: FlagButtonsProps) {
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center gap-2">
        <button
          type="button"
          className={BUTTON}
          disabled={disabled}
          aria-keyshortcuts="F"
          title="Mark this frame as a false positive (F)"
          onClick={() => onFlag("fp")}
        >
          False positive (F)
        </button>
        <button
          type="button"
          className={BUTTON}
          disabled={disabled}
          aria-keyshortcuts="N"
          title="Mark this frame as a missed object (N)"
          onClick={() => onFlag("fn")}
        >
          Missed object (N)
        </button>
        {snapNote && <span className="text-xs text-gray-400">{snapNote}</span>}
      </div>
      {error && (
        <p role="alert" className="text-xs text-red-400">
          {error}
        </p>
      )}
    </div>
  );
}
```

Create `frontend/src/features/qc/CommitDialog.tsx` (modelled on `features/datasets/DatasetMetricsDialog.tsx`: fixed overlay, `role="dialog"`, `aria-modal`, Escape closes):

```tsx
import { useEffect, useRef, useState } from "react";

interface CommitDialogProps {
  fpCount: number;
  fnCount: number;
  defaultName: string;
  error: string | null;
  submitting: boolean;
  onConfirm: (name: string) => void;
  onCancel: () => void;
}

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

export function CommitDialog({
  fpCount,
  fnCount,
  defaultName,
  error,
  submitting,
  onConfirm,
  onCancel,
}: CommitDialogProps) {
  const [name, setName] = useState(defaultName);
  const nameRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    nameRef.current?.focus();
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") onCancel();
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onCancel]);

  const canConfirm = name.trim().length > 0 && !submitting;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Send frames to training"
        className="w-full max-w-md rounded border border-gray-800 bg-gray-900 p-4 text-sm text-gray-200"
      >
        <h2 className="mb-3 text-base font-semibold text-gray-100">Send frames to training</h2>

        <label htmlFor="qc-sequence-name" className="mb-1 block text-gray-300">
          Sequence name
        </label>
        <input
          id="qc-sequence-name"
          ref={nameRef}
          type="text"
          maxLength={255}
          value={name}
          onChange={(e) => setName(e.target.value)}
          className="mb-3 w-full rounded border border-gray-700 bg-gray-900 px-2 py-1.5 text-gray-100"
        />

        <ul className="mb-3 list-disc pl-5 text-gray-300">
          {fpCount > 0 && (
            <li>{plural(fpCount, "false positive", "false positives")} will be saved as negatives</li>
          )}
          {fnCount > 0 && (
            <li>{plural(fnCount, "missed object", "missed objects")} will wait for annotation</li>
          )}
        </ul>

        <p className="mb-3 rounded border border-yellow-700 bg-yellow-950 px-2 py-1 text-xs text-yellow-200">
          After sending, this video is no longer an unbiased test for future runs.
        </p>

        {error && (
          <p role="alert" className="mb-3 text-xs text-red-400">
            {error}
          </p>
        )}

        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            className="rounded border border-gray-700 px-3 py-1 text-xs text-gray-300 hover:text-gray-100"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={!canConfirm}
            onClick={() => onConfirm(name.trim())}
            className="rounded bg-blue-600 px-3 py-1 text-xs text-white disabled:opacity-50"
          >
            {submitting ? "Sending…" : "Confirm"}
          </button>
        </div>
      </div>
    </div>
  );
}
```

Create `frontend/src/features/qc/FlagsPanel.tsx`:

```tsx
import { Link } from "react-router-dom";

import type { QcFlag } from "../../entities/useQcFlags";
import { formatClock } from "./analysis/strip";

interface FlagsPanelProps {
  flags: QcFlag[];
  loadFailed: boolean;
  onRetry: () => void;
  onSeek: (ms: number) => void;
  onRemove: (flagId: number) => void;
  onNoteChange: (flag: QcFlag, note: string) => void;
  onSend: () => void;
  lastSequence: { id: number; name: string } | null;
}

export function FlagsPanel({
  flags,
  loadFailed,
  onRetry,
  onSeek,
  onRemove,
  onNoteChange,
  onSend,
  lastSequence,
}: FlagsPanelProps) {
  const pending = flags.filter((f) => f.committed_at === null);
  const sent = flags.length - pending.length;
  const sequenceIds = [
    ...new Set(flags.map((f) => f.sequence_id).filter((id): id is number => id !== null)),
  ];

  return (
    <section aria-label="Flags" className="flex flex-col gap-2 text-sm text-gray-300">
      <h2 className="text-sm font-semibold text-gray-200">Flags</h2>

      {loadFailed ? (
        <div className="flex items-center gap-2 text-xs text-red-400">
          <span>Could not load the flags.</span>
          <button
            type="button"
            onClick={onRetry}
            className="rounded border border-gray-700 px-2 py-0.5 text-gray-300 hover:text-gray-100"
          >
            Retry
          </button>
        </div>
      ) : (
        <>
          <p className="text-xs text-gray-400">{`${pending.length} pending · ${sent} sent`}</p>

          {pending.length > 0 && (
            <ul className="flex flex-col gap-2">
              {pending.map((flag) => {
                const time = formatClock(flag.timestamp_ms);
                return (
                  <li key={flag.id} className="flex flex-col gap-1 rounded border border-gray-800 p-2">
                    <div className="flex items-center justify-between">
                      <span className="flex items-center gap-2">
                        <button
                          type="button"
                          onClick={() => onSeek(flag.timestamp_ms)}
                          className="text-blue-400 hover:underline"
                        >
                          {time}
                        </button>
                        <span
                          className={`rounded px-1.5 py-0.5 text-xs ${
                            flag.kind === "fp" ? "bg-red-900 text-red-100" : "bg-blue-900 text-blue-100"
                          }`}
                        >
                          {flag.kind.toUpperCase()}
                        </span>
                      </span>
                      <button
                        type="button"
                        aria-label={`Remove flag at ${time}`}
                        onClick={() => onRemove(flag.id)}
                        className="text-gray-500 hover:text-gray-200"
                      >
                        ×
                      </button>
                    </div>
                    <input
                      type="text"
                      aria-label={`Note for flag at ${time}`}
                      placeholder="Note (optional)"
                      maxLength={500}
                      defaultValue={flag.note ?? ""}
                      onBlur={(e) => {
                        if (e.target.value !== (flag.note ?? "")) onNoteChange(flag, e.target.value);
                      }}
                      className="rounded border border-gray-700 bg-gray-900 px-2 py-1 text-xs text-gray-100"
                    />
                  </li>
                );
              })}
            </ul>
          )}

          <button
            type="button"
            disabled={pending.length === 0}
            onClick={onSend}
            className="rounded bg-blue-600 px-3 py-1.5 text-xs text-white disabled:opacity-50"
          >
            {pending.length === 0
              ? "Send to training"
              : `Send ${pending.length} ${pending.length === 1 ? "frame" : "frames"} to training`}
          </button>

          {lastSequence && (
            <p className="text-xs text-green-400">
              Created sequence “{lastSequence.name}” ·{" "}
              <Link to={`/sequences/${lastSequence.id}`} className="underline">
                Open in editor
              </Link>
            </p>
          )}

          {sequenceIds.length > 0 && (
            <p className="text-xs text-gray-400">
              Sent into sequences:{" "}
              {sequenceIds.map((id) => (
                <Link key={id} to={`/sequences/${id}`} className="mr-1 text-blue-400 hover:underline">
                  {`#${id}`}
                </Link>
              ))}
            </p>
          )}
        </>
      )}
    </section>
  );
}
```

In `frontend/src/features/qc/RunsTable.tsx`: add `<th className="px-4 py-2 font-normal">Flags</th>` after the Status header; add a cell after the status cell:

```tsx
              <td className="px-4 py-2 text-gray-400">
                {run.flags_pending + run.flags_committed === 0
                  ? "—"
                  : `${run.flags_pending} pending · ${run.flags_committed} sent`}
              </td>
```

and, in the armed-delete branch, render before the Confirm button:

```tsx
                  <>
                    {run.flags_pending > 0 && (
                      <span className="mr-2 text-xs text-red-400">
                        {`${run.flags_pending} pending ${run.flags_pending === 1 ? "flag" : "flags"} will be lost`}
                      </span>
                    )}
                    <button ...the existing Confirm button...>Confirm</button>
                  </>
```

(wrap the existing Confirm button in that fragment; keep its props).

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd frontend && npx vitest run src/features/qc && npx tsc --noEmit`
Expected: PASS, no type errors in the touched files.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/features/qc
git commit -m "feat: add the QC flag buttons, panel, commit dialog and history column" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 7: Wire flagging into the run view

**Files:**
- Modify: `frontend/src/features/qc/TimelineStrip.tsx`, `frontend/src/features/qc/RunViewPage.tsx`

**Interfaces:**
- Consumes: everything from Tasks 5 and 6; `errorMessage` from `features/qc/errorMessage.ts`; `formatClock` from `analysis/strip.ts`.
- Produces: `TimelineStrip` gains the props `flags: QcFlag[]` (marks) and uses the existing `onSeek` for clicks on marks.

These two files are browser glue (video element, canvas, key handlers, dialog state). jsdom has no video clock, so a unit test would only assert mocks; the pure parts are tested in Tasks 5 and 6 and the whole is verified in a real browser in Task 8. Do not add vacuous mock-only tests.

- [ ] **Step 1: Add the flag marks to the strip**

In `frontend/src/features/qc/TimelineStrip.tsx`: import `type { QcFlag } from "../../entities/useQcFlags"`; add `flags: QcFlag[];` to `TimelineStripProps` and to the function's destructuring; add this memoised component beside `FlickerMarks`:

```tsx
// Red marks for flagged frames: a square for FP, a diamond for FN (shape, not
// only colour). Pending marks are filled, sent ones outlined. A click seeks to
// the flag's frame instead of to the click position.
const FlagMarks = memo(function FlagMarks({
  flags,
  durationMs,
  onSeek,
}: {
  flags: QcFlag[];
  durationMs: number;
  onSeek: (ms: number) => void;
}) {
  return (
    <>
      {flags.map((flag) => {
        const sent = flag.committed_at !== null;
        return (
          <span
            key={flag.id}
            aria-hidden="true"
            data-testid={`flag-mark-${flag.id}`}
            className={`absolute bottom-0 h-2.5 w-2.5 -translate-x-1/2 cursor-pointer border-2 border-red-500 ${
              flag.kind === "fn" ? "rotate-45" : ""
            } ${sent ? "bg-transparent" : "bg-red-500"}`}
            style={{ left: `${Math.min(Math.max(flag.timestamp_ms / durationMs, 0), 1) * 100}%` }}
            onClick={(e) => {
              e.stopPropagation();
              onSeek(flag.timestamp_ms);
            }}
          />
        );
      })}
    </>
  );
});
```

and render `<FlagMarks flags={flags} durationMs={durationMs} onSeek={onSeek} />` right after `<FlickerMarks ... />` inside the strip container. Update the `aria-label` text of the strip to mention "red marks are flagged frames". Add to the legend list two entries after the dropout one:

```tsx
        <li className="flex items-center gap-1">
          <span className="inline-block h-2 w-2 bg-red-500" /> false positive
        </li>
        <li className="flex items-center gap-1">
          <span className="inline-block h-2 w-2 rotate-45 bg-red-500" /> missed object
        </li>
```

- [ ] **Step 2: Wire the page**

In `frontend/src/features/qc/RunViewPage.tsx` make these changes (keep everything else as is):

Imports: add `useState` to the React import; add `import { useCommitQcFlags, useDeleteQcFlag, usePutQcFlag, useQcFlags, useVideoSent, type QcFlag, type QcFlagKind } from "../../entities/useQcFlags";`, `import { errorMessage } from "./errorMessage";`, `import { formatClock } from "./analysis/strip";`, `import { CommitDialog } from "./CommitDialog";`, `import { FlagButtons } from "./FlagButtons";`, `import { FlagsPanel } from "./FlagsPanel";`, `import { decideFlagAction } from "./flagDecision";`, `import { buildProcessedFrames, processedFrameAt } from "./processedFrame";`, and extend the eventKeys import with `flagKindFor`.

Module level, next to `NO_EVENTS`: `const NO_FLAGS: QcFlag[] = [];`

Inside the component, after the `counts` memo, add:

```tsx
  const succeeded = run?.status === "succeeded";
  const flagsQuery = useQcFlags(succeeded ? runId : null);
  const flags = flagsQuery.data ?? NO_FLAGS;
  const putFlag = usePutQcFlag(runId);
  const deleteFlag = useDeleteQcFlag(runId);
  const commit = useCommitQcFlags(runId, run?.video_id ?? null);
  const sentQuery = useVideoSent(succeeded ? (run?.video_id ?? null) : null);
  const processedFrames = useMemo(
    () => (document ? buildProcessedFrames(document) : []),
    [document],
  );
  const [snapNote, setSnapNote] = useState<string | null>(null);
  const [flagError, setFlagError] = useState<string | null>(null);
  const [commitOpen, setCommitOpen] = useState(false);
  const [lastSequence, setLastSequence] = useState<{ id: number; name: string } | null>(null);
```

After the `jump` callback add the flag handler:

```tsx
  const { mutate: putFlagMutate } = putFlag;
  const { mutate: deleteFlagMutate } = deleteFlag;
  const flagFrame = useCallback(
    (kind: QcFlagKind) => {
      const el = videoRef.current;
      if (!el || processedFrames.length === 0) return;
      const frame = processedFrameAt(processedFrames, el.currentTime * 1000);
      if (!frame) {
        setSnapNote("No processed frame at this time");
        return;
      }
      // Pause and snap to the frame the overlay shows, so what is flagged is
      // exactly what the model saw.
      el.pause();
      el.currentTime = frame.timestampMs / 1000;
      setSnapNote(`Snapped to processed frame ${formatClock(frame.timestampMs)}`);
      setFlagError(null);

      const existing = flags.find((f) => f.frame_index === frame.frameIndex);
      const action = decideFlagAction(
        existing ? { kind: existing.kind, committed: existing.committed_at !== null } : undefined,
        kind,
      );
      const onError = (error: unknown) =>
        setFlagError(errorMessage(error, "Could not save the flag"));
      if (action === "blocked") {
        setFlagError("This frame was already sent to training");
      } else if (action === "remove" && existing) {
        deleteFlagMutate(existing.id, { onError });
      } else {
        putFlagMutate(
          {
            frame_index: frame.frameIndex,
            timestamp_ms: frame.timestampMs,
            kind,
            note: existing?.note ?? null,
          },
          { onError },
        );
      }
    },
    [processedFrames, flags, putFlagMutate, deleteFlagMutate],
  );
```

Change the key effect to:

```tsx
  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (commitOpen || isTypingTarget(event.target)) return;
      const direction = eventDirectionFor(event);
      if (direction) {
        jump(direction);
        return;
      }
      const kind = flagKindFor(event);
      if (kind) flagFrame(kind);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [jump, flagFrame, commitOpen]);
```

Add the derived values and handlers before the `return`:

```tsx
  const pendingFlags = flags.filter((f) => f.committed_at === null);
  const fpCount = pendingFlags.filter((f) => f.kind === "fp").length;
  const fnCount = pendingFlags.length - fpCount;
  const defaultSequenceName = `QC · ${video?.title ?? "video"} · run #${runId} · ${new Date()
    .toISOString()
    .slice(0, 10)}`;
  const sent = sentQuery.data;

  const handleNoteChange = (flag: QcFlag, note: string) =>
    putFlagMutate(
      { frame_index: flag.frame_index, timestamp_ms: flag.timestamp_ms, kind: flag.kind, note: note || null },
      { onError: (error) => setFlagError(errorMessage(error, "Could not save the note")) },
    );
  const openCommit = () => {
    commit.reset();
    setCommitOpen(true);
  };
  const handleConfirm = (name: string) =>
    commit.mutate(
      { name },
      {
        onSuccess: (sequence) => {
          setCommitOpen(false);
          if (sequence) setLastSequence({ id: sequence.id, name: sequence.name });
        },
      },
    );
```

JSX: under the page title row add

```tsx
      {sent && sent.frames > 0 && (
        <p className="rounded border border-yellow-700 bg-yellow-950 px-2 py-1 text-xs text-yellow-200">
          {`${sent.frames} ${sent.frames === 1 ? "frame" : "frames"} of this video ${
            sent.frames === 1 ? "was" : "were"
          } sent to training, so it is no longer an unbiased test.`}
        </p>
      )}
```

pass `flags={flags}` to `<TimelineStrip ... />`; after `<EventNav ... />` (inside the same fragment) add

```tsx
                <FlagButtons
                  disabled={processedFrames.length === 0}
                  onFlag={flagFrame}
                  snapNote={snapNote}
                  error={flagError}
                />
```

in the aside, right after the Display panel block add

```tsx
            {document && (
              <FlagsPanel
                flags={flags}
                loadFailed={flagsQuery.isError}
                onRetry={() => void flagsQuery.refetch()}
                onSeek={seekTo}
                onRemove={(id) =>
                  deleteFlagMutate(id, {
                    onError: (error) => setFlagError(errorMessage(error, "Could not remove the flag")),
                  })
                }
                onNoteChange={handleNoteChange}
                onSend={openCommit}
                lastSequence={lastSequence}
              />
            )}
```

and at the end of the page `<div>`, before its closing tag:

```tsx
      {commitOpen && (
        <CommitDialog
          fpCount={fpCount}
          fnCount={fnCount}
          defaultName={defaultSequenceName}
          error={commit.error ? errorMessage(commit.error, "Could not create the sequence") : null}
          submitting={commit.isPending}
          onConfirm={handleConfirm}
          onCancel={() => setCommitOpen(false)}
        />
      )}
```

- [ ] **Step 3: Type-check and run the whole frontend suite**

Run: `cd frontend && npx tsc --noEmit && npx vitest run`
Expected: no type errors in the touched files; every test PASSES (compare any failure outside these files with the known pre-existing set before treating it as yours).

- [ ] **Step 4: Commit**

```bash
git add frontend/src/features/qc/TimelineStrip.tsx frontend/src/features/qc/RunViewPage.tsx
git commit -m "feat: flag frames and send them to training from the QC run view" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 8: Real-stack verification, spec and roadmap

This task is manual on purpose: the page composition, the keys, the snapping and the commit time cannot be exercised by a unit test, and CLAUDE.md records bugs only a real browser against the real stack caught. The stack is running; if the backend does not show the new routes, check that `uvicorn --reload` picked up the code (`curl -s localhost:8000/openapi.json | grep -c "/commit"`). Use run data of your OWN: create a run on a real video with the detect model `yolo11n-run268` (stride 5 on `stek_polyps` is quick); never flag or delete run #82.

**Files:**
- Modify: `docs/specs/2026-10-07-qc-flagging-design.md`, `ROADMAP.md`

- [ ] **Step 1: Bring the stack to the new code**

Confirm the migration is applied (`docker compose exec -T postgres psql -U endoscopy -d endoscopy -c "\d qc_flags"`), the backend serves the new routes, and the frontend hot-reloaded. Note `select count(*) from sequences`, `select count(*) from frames`, `select count(*) from inference_runs` BEFORE you start, for the cleanup check.

- [ ] **Step 2: Drive the flow in the browser and record what you observe**

Log in as `manualcheck@example.com` (password in the project memory note `reference_manual_check_login_and_taxonomy_reimport.md`), create your own run and open it. For each item report PASS or FAIL with what you saw:

1. `F` and `N` (and the two buttons) pause the video and snap the time to the processed frame shown; the note "Snapped to processed frame m:ss" appears; at stride 5 the time lands on a multiple of the frame step.
2. A flag appears in the Flags panel at once (time, FP/FN badge) and as a red mark on the strip (square FP, diamond FN, filled while pending); clicking the mark seeks to its frame; the counts read "N pending · 0 sent".
3. Pressing the same key on a flagged frame removes the flag; the other key changes the kind.
4. The keys do nothing while typing in a note or number field, with Ctrl held, while the commit dialog is open, and still work with a slider focused; simulate a Russian layout with events carrying `code: "KeyF"`/`"KeyN"` and key "а"/"т".
5. A note typed in a flag and blurred is saved (reload the page: it persists).
6. Reload the page: the flags and the marks are still there.
7. Flag two FP and two FN frames, press "Send 4 frames to training": the dialog shows the default name, "2 false positives will be saved as negatives", "2 missed objects will wait for annotation" and the unbiased-test warning; Escape and Cancel close it.
8. Confirm: the success line "Created sequence … · Open in editor" appears; the marks become outlined; the counts read "0 pending · 4 sent"; the history table shows the same counts; the header shows the "frames of this video were sent to training" note. **Measure the Commit request time** (browser network tab or `curl -w`) and record it.
9. On the Sequences screen (`/sequences`) the new sequence exists with the QC name; open it in the editor: the two FP frames show as "no findings" (reviewed), the two FN frames have no annotations; check that the frame images are the frames the model saw (compare a frame's content with the video at the flagged time).
10. Flag one more frame and commit again: a second sequence is created with only that frame. Try to flag a frame that was already sent: the page shows "This frame was already sent to training".
11. Deleting a run that has pending flags: the Delete confirmation says "N pending flags will be lost"; deleting it keeps the sequences it created and their origin (check `select origin_qc_run_id from sequences`).
12. Console: no errors or warnings from the app.
13. Commit time on a long video: create a run with stride 300 on the longest video available (5088 s, `my_set_some_polyps#03`, if it is processed in reasonable time; otherwise a stride that makes it quick), flag two frames near the END of the video and commit; record how long the request takes. This sets the time budget the spec left open.

A failure is fixed in the owning task's files with a new failing test where one can exist, and noted in the roadmap.

- [ ] **Step 3: Sweep what the verification created**

Delete only what you created: the sequences, their frames and the MinIO objects under `frames/<sequence_id>/` (delete the sequences through the platform's own Delete in the Sequences screen or the `DELETE /media/sequences/{id}` endpoint, which removes frames and objects), then your runs through the QC Delete. Confirm with psql that `sequences`, `frames`, `inference_runs` and `qc_flags` are back to the counts from Step 1 (run #82 and its job remain) and that listing the `frames/` prefix in MinIO shows no key of a deleted sequence.

- [ ] **Step 4: Update the spec and the roadmap**

In `docs/specs/2026-10-07-qc-flagging-design.md`: change the status line to "implemented; verified in a real browser", replace the first open item with the measured Commit time and the budget it implies, record under a new `## Deviations from the first draft` list whatever the implementation changed, and add a `## Verification` section summarising Step 2 (what passed, the measured times, what was not verified: touch, hiDPI, the Russian layout on a physical keyboard, a segmentation run). In `ROADMAP.md` change the heading of "Phase 3: QC screen, sub-project 3 (flagging to training)" to `DONE (<date>)`, link this plan, replace "Implementation plan: not written yet.", and add the verification results and any new open items.

- [ ] **Step 5: Commit**

```bash
git add docs/specs/2026-10-07-qc-flagging-design.md ROADMAP.md
git commit -m "docs: record the QC flagging verification in the roadmap" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```
