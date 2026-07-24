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
from app.models import Frame, Job, JobStatus, JobType, Label, LabelType
from app.sam3_adapter import MaskResult
from app.storage import get_storage_service
from app.tasks import run_sam3_predict


def _make_label(session) -> tuple[int, int]:
    """Returns (label_id, taxonomy_version) for a freshly created Label
    row, using a taxonomy_version distinct from the column default (1) so
    a test that accidentally hardcodes/re-derives 1 instead of copying the
    real value would be caught."""
    label = Label(name="test-polyp-label", label_type=LabelType.MORPHOLOGICAL, taxonomy_version=7)
    session.add(label)
    session.commit()
    session.refresh(label)
    return label.id, label.taxonomy_version


def _existing_row_id(session, table: str) -> int:
    """ml-worker has no duplicate Video/Sequence/User ORM models (out of
    this task's scope — it only ever reads rows the backend already
    created), but frames.sequence_id and jobs.created_by_id carry real FK
    constraints, so test rows must reference ids that actually exist
    rather than hardcoded ones."""
    from sqlalchemy import text

    row = session.execute(text(f"SELECT id FROM {table} ORDER BY id LIMIT 1")).first()  # noqa: S608
    if row is None:
        raise RuntimeError(
            f"No rows exist in '{table}' in the dev database — run the "
            "backend test suite first (it creates users/videos/sequences "
            "via its own endpoints), or seed one manually."
        )
    return row[0]


def _make_pending_job_with_frame(session, label_id: int) -> tuple[int, int]:
    from app.models import Base
    from app.db import engine

    storage = get_storage_service()
    storage.upload("test/task-frame.png", b"fake png bytes", content_type="image/png")

    sequence_id = _existing_row_id(session, "sequences")
    user_id = _existing_row_id(session, "users")
    frame = Frame(sequence_id=sequence_id, storage_key="test/task-frame.png", frame_index=0, width=64, height=48)
    session.add(frame)
    session.commit()
    session.refresh(frame)

    job = Job(
        job_type=JobType.SAM3_PREDICT,
        status=JobStatus.PENDING,
        progress=0,
        payload={
            "frame_id": frame.id,
            "label_id": label_id,
            "prompts": [{"type": "point", "coords": [0.5, 0.5], "label": True}],
        },
        created_by_id=user_id,
    )
    session.add(job)
    session.commit()
    session.refresh(job)
    return job.id, frame.id


def test_run_sam3_predict_marks_job_succeeded_and_creates_mask_annotation():
    session = SessionLocal()
    label_id, label_taxonomy_version = _make_label(session)
    job_id, frame_id = _make_pending_job_with_frame(session, label_id)
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
    assert annotation.label_id == label_id
    assert annotation.taxonomy_version == label_taxonomy_version
    session.close()


def test_run_sam3_predict_sets_job_id_on_created_annotation():
    session = SessionLocal()
    label_id, _ = _make_label(session)
    job_id, frame_id = _make_pending_job_with_frame(session, label_id)
    session.close()

    fake_adapter = MagicMock()
    fake_adapter.predict.return_value = MaskResult(mask_png=b"fake mask png bytes", score=0.91)

    run_sam3_predict(job_id, adapter=fake_adapter)

    session = SessionLocal()
    from app.models import Annotation

    annotation = session.query(Annotation).filter(Annotation.frame_id == frame_id).first()
    assert annotation is not None
    assert annotation.job_id == job_id
    session.close()


def test_run_sam3_predict_marks_job_failed_on_adapter_error():
    session = SessionLocal()
    label_id, _ = _make_label(session)
    job_id, _ = _make_pending_job_with_frame(session, label_id)
    session.close()

    fake_adapter = MagicMock()
    fake_adapter.predict.side_effect = ValueError("no masks above threshold")

    run_sam3_predict(job_id, adapter=fake_adapter)

    session = SessionLocal()
    job = session.get(Job, job_id)
    assert job.status == JobStatus.FAILED
    assert "no masks above threshold" in job.error
    session.close()
