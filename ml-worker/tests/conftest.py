import io
import os
import zipfile

import pytest


def pytest_collection_modifyitems(config, items):
    sam3_available = os.environ.get("SAM3_WEIGHTS_AVAILABLE") == "1"
    sam2_available = os.environ.get("SAM2_WEIGHTS_AVAILABLE") == "1"
    skip_sam3 = pytest.mark.skip(
        reason="SAM3_WEIGHTS_AVAILABLE=1 not set — skipping tests that need real SAM-3 weights/GPU"
    )
    skip_sam2 = pytest.mark.skip(
        reason="SAM2_WEIGHTS_AVAILABLE=1 not set — skipping tests that need real SAM 2.1 weights/GPU"
    )
    for item in items:
        if "requires_sam3_weights" in item.keywords and not sam3_available:
            item.add_marker(skip_sam3)
        if "requires_sam2_weights" in item.keywords and not sam2_available:
            item.add_marker(skip_sam2)


@pytest.fixture(autouse=True)
def _release_cuda_memory_after_test():
    """Frees CUDA memory after every test so GPU tests that each build their
    own `Sam3Adapter()` don't cascade-OOM against a previous test's still-resident
    model. `torch` is only installed inside the ml-worker Docker image, so the
    import is done lazily and skipped entirely when unavailable (e.g. host env
    running the two non-GPU conversion tests without the full ML dependencies)."""
    yield
    try:
        import gc

        import torch
    except ImportError:
        return
    gc.collect()
    if torch.cuda.is_available():
        torch.cuda.empty_cache()


def _existing_row_id(session, table: str) -> int:
    """Same helper as test_tasks.py's -- the training fixtures below need
    real dataset_id/created_by_id values because training_runs carries
    hard FK constraints to datasets(id) and users(id), and ml-worker has
    no duplicate Dataset/User ORM model to insert through."""
    from sqlalchemy import text

    row = session.execute(text(f"SELECT id FROM {table} ORDER BY id LIMIT 1")).first()  # noqa: S608
    if row is None:
        raise RuntimeError(
            f"No rows exist in '{table}' in the dev database — run the "
            "backend test suite first (it creates users/datasets via its "
            "own endpoints), or seed one manually."
        )
    return row[0]


@pytest.fixture
def db_session():
    """A live SQLAlchemy session against the same dev database the worker
    process itself uses -- test_tasks_training.py asserts on rows that
    app.tasks.model_train() commits through its own, separate
    SessionLocal() instance, so this fixture's session is only ever used
    to read those rows back (and to seed fixtures), never to hold open a
    transaction the task's own session would be isolated from.

    .get() is wrapped to default populate_existing=True: Session.get()
    only re-queries an identity-mapped object when it is marked expired,
    but any attribute access on this fixture's own rows *before* the task
    runs (e.g. the test reading training_job.id to pass to model_train())
    silently clears that expired flag on refresh -- confirmed by direct
    reproduction against this SessionLocal/Postgres pairing. Without this
    wrapper, a post-task .get() call in a test can return a stale
    pre-training-run snapshot instead of the row model_train()'s separate
    session actually committed, even though Postgres itself (read
    committed) has no trouble seeing the write.
    """
    from app.db import SessionLocal

    session = SessionLocal()
    _original_get = session.get

    def _get_populate_existing(entity, ident, **kwargs):
        kwargs.setdefault("populate_existing", True)
        return _original_get(entity, ident, **kwargs)

    session.get = _get_populate_existing
    yield session
    session.close()


@pytest.fixture
def fake_storage(monkeypatch):
    """Stands in for get_storage_service() everywhere app.tasks imports
    it (model_train calls get_storage_service() itself, not an injected
    parameter), so tests never touch real MinIO. download() always
    returns a minimal zip containing just data.yaml -- enough for
    model_train to extract into dataset_dir before handing it to a stub
    adapter that never actually reads the dataset. upload() records calls
    in-memory so a test could assert on the storage_key/content_type used,
    though none of the current tests need to."""

    class FakeStorage:
        def __init__(self):
            self.uploaded: dict[str, bytes] = {}

        def download(self, key: str) -> bytes:
            buffer = io.BytesIO()
            with zipfile.ZipFile(buffer, "w") as archive:
                archive.writestr("data.yaml", "train: images/train\nval: images/val\n")
            return buffer.getvalue()

        def upload(self, key: str, data: bytes, content_type: str) -> None:
            self.uploaded[key] = data

    fake = FakeStorage()
    import app.tasks as tasks_module

    monkeypatch.setattr(tasks_module, "get_storage_service", lambda: fake)
    return fake


@pytest.fixture
def training_job(db_session):
    """A Job(job_type=MODEL_TRAIN) paired with a TrainingRun(total_epochs=2),
    linked via payload={"training_run_id", "export_key"} exactly as
    backend/app/training/service.py's enqueue path constructs it (Task 2).
    Both rows are committed through db_session, a different SessionLocal()
    instance than the one app.tasks.model_train() opens internally --
    real, committed Postgres rows, not something only visible inside this
    fixture's transaction.
    """
    from app.models import Job, JobStatus, JobType, TaskType, TrainingRun, TrainingRunStatus

    dataset_id = _existing_row_id(db_session, "datasets")
    user_id = _existing_row_id(db_session, "users")

    run = TrainingRun(
        dataset_id=dataset_id,
        adapter="ultralytics_yolo",
        base_model="yolo11n.pt",
        task_type=TaskType.DETECTION,
        config={"epochs": 2, "batch": 8, "imgsz": 640},
        status=TrainingRunStatus.PENDING,
        total_epochs=2,
        created_by_id=user_id,
    )
    db_session.add(run)
    db_session.commit()
    db_session.refresh(run)

    job = Job(
        job_type=JobType.MODEL_TRAIN,
        status=JobStatus.PENDING,
        progress=0,
        payload={"training_run_id": run.id, "export_key": "exports/1/dataset.zip"},
        created_by_id=user_id,
    )
    db_session.add(job)
    db_session.commit()
    db_session.refresh(job)

    run.job_id = job.id
    # Deliberately end setup on commit(), not refresh(): app.tasks.model_train
    # runs in a *different* SessionLocal() instance and updates this same
    # job/run row via its own commits. commit() marks every object in this
    # session's identity map expired, so the test's later db_session.get(...)
    # calls issue a fresh SELECT and observe model_train's writes -- whereas
    # refresh() re-fetches immediately but leaves the object *not* expired,
    # so a subsequent .get() on the same still-cached, non-expired identity
    # map entry would silently return the stale pre-training-run snapshot
    # instead of re-querying (confirmed by direct reproduction against this
    # SessionLocal/Postgres pairing before writing this comment).
    db_session.commit()

    yield job

    # Tests only ever create these two rows off this fixture; delete only
    # what was created here, never TRUNCATE the shared dev database (see
    # CLAUDE.md's binding rule and the "never truncate without asking"
    # lesson in project memory).
    from app.models import ModelVersion

    db_session.query(ModelVersion).filter_by(training_run_id=run.id).delete()
    # TrainingRun.job_id -> jobs.id carries a real FK constraint (unlike
    # dataset_id/created_by_id, which point at tables ml-worker has no
    # model for) -- the referencing row must go first or Postgres rejects
    # the Job delete.
    db_session.query(TrainingRun).filter_by(id=run.id).delete()
    db_session.query(Job).filter_by(id=job.id).delete()
    db_session.commit()
