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
def make_job_and_run(db_session):
    """Factory version of `training_job` below: same Job/TrainingRun
    construction and the same teardown, but returns a `(job, run)` pair
    per call instead of a single fixed `training_job`, so a test can build
    more than one pairing (or customize nothing and just call it once).
    Kept as a separate fixture rather than refactoring `training_job` to
    use it, to avoid touching the already-passing tests below.
    """
    from app.models import Job, JobStatus, JobType, TaskType, TrainingRun, TrainingRunStatus

    created: list[tuple] = []

    def _make():
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
        # See training_job's comment below: commit(), not refresh(), so
        # this fixture's identity-map entries are expired and later
        # db_session.get(...) calls in the test observe model_train's
        # writes from its own separate SessionLocal() instance.
        db_session.commit()

        created.append((job, run))
        return job, run

    yield _make

    from app.models import ModelVersion

    for job, run in created:
        db_session.query(ModelVersion).filter_by(training_run_id=run.id).delete()
        db_session.query(TrainingRun).filter_by(id=run.id).delete()
        db_session.query(Job).filter_by(id=job.id).delete()
    db_session.commit()


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


@pytest.fixture(scope="session", autouse=True)
def _sweep_test_rows_from_the_dev_database():
    """Removes the rows and objects this suite leaves in the real database.

    ml-worker's tests deliberately run against the real dev database -- there
    is no test-database patching here the way there is in `backend/tests`,
    because these tests exercise the worker's own SessionLocal against real
    Postgres. That is a legitimate choice, but it made every run leak:
    `test-polyp-label` labels, `test/`-keyed frames,
    `rank-quality-test-sequence` rows and their SAM3/RANK_QUALITY/
    FIND_SIMILAR jobs accumulated in the user's own data, invisible until
    someone counted rows by date. 62 rows and 6 MinIO objects were swept by
    hand on 2026-08-21 before this fixture existed.

    Swept by the exact literals this suite itself writes -- never by date,
    never by TRUNCATE: a predicate that could match a real row is worse than
    the leak it fixes. Deletion follows foreign keys inward so nothing is
    orphaned, and a failure here is swallowed rather than failing a green
    suite.
    """
    yield

    try:
        from sqlalchemy import text

        import app.db as db_module

        session = db_module.SessionLocal()
    except Exception:  # noqa: BLE001 -- no database here means nothing was written
        return

    # The masks these jobs produced are keyed by the frame they annotated, so
    # they have to be collected before those rows are deleted -- afterwards
    # nothing names them and they become the same kind of orphan the export
    # archives were in 857760d.
    # payload is a plain `json` column, not `jsonb`, so it carries no `?`
    # operator -- and `?` would be read as a bind parameter by SQLAlchemy
    # anyway. Cast explicitly and test the extracted value for NULL instead.
    doomed_keys: list[str] = []
    doomed_job_ids: list[int] = []
    try:
        doomed_keys = [
            row[0]
            for row in session.execute(
                text(
                    "SELECT result_ref FROM jobs WHERE result_ref LIKE 'masks/%' "
                    "AND (payload::jsonb->>'frame_id') IS NOT NULL "
                    "AND (payload::jsonb->>'frame_id')::int IN "
                    "(SELECT id FROM frames WHERE storage_key LIKE 'test/%')"
                )
            )
            if row[0]
        ]
        doomed_job_ids = [
            row[0]
            for row in session.execute(
                text(
                    # SAM3_PREDICT payloads name a frame_id; RANK_QUALITY and
                    # FIND_SIMILAR name a sequence_id instead. Both shapes have
                    # to be matched, or the second pair survives every sweep.
                    "SELECT id FROM jobs WHERE job_type IN "
                    "('SAM3_PREDICT', 'RANK_QUALITY', 'FIND_SIMILAR') AND ("
                    "  (payload::jsonb->>'frame_id')::int IN "
                    "    (SELECT id FROM frames WHERE storage_key LIKE 'test/%')"
                    "  OR (payload::jsonb->>'sequence_id')::int IN "
                    "    (SELECT id FROM sequences WHERE name = 'rank-quality-test-sequence')"
                    ")"
                )
            )
        ]
        session.execute(
            text(
                "DELETE FROM annotations WHERE frame_id IN "
                "(SELECT id FROM frames WHERE storage_key LIKE 'test/%')"
            )
        )
        session.execute(text("DELETE FROM frames WHERE storage_key LIKE 'test/%'"))
        session.execute(
            text("DELETE FROM sequences WHERE name = 'rank-quality-test-sequence'")
        )
        session.execute(text("DELETE FROM labels WHERE name = 'test-polyp-label'"))
        # The jobs these tests enqueue point at the frames just deleted, so
        # they can no longer refer to anything real. Matched by the payload's
        # dangling frame_id rather than by job_type or date -- a real
        # SAM3_PREDICT job of the user's must never match this.
        if doomed_job_ids:
            # Deleted by the ids collected BEFORE the frames went: the
            # predicate that found them joins against frames, so it matches
            # nothing once those rows are gone.
            session.execute(
                text("DELETE FROM jobs WHERE id = ANY(:ids)"), {"ids": doomed_job_ids}
            )
        # make_inference_job's throwaway videos, in FK order: the runs name
        # the videos and the jobs, so runs go first, then their jobs, then
        # the videos. Job ids are collected before the runs vanish.
        inference_video_ids = (
            "SELECT id FROM videos WHERE title = 'inference test' "
            "AND storage_key = 'videos/inference-test.mp4'"
        )
        inference_job_ids = [
            row[0]
            for row in session.execute(
                text(
                    "SELECT job_id FROM inference_runs WHERE job_id IS NOT NULL "
                    f"AND video_id IN ({inference_video_ids})"
                )
            )
        ]
        session.execute(
            text(f"DELETE FROM inference_runs WHERE video_id IN ({inference_video_ids})")
        )
        if inference_job_ids:
            session.execute(
                text("DELETE FROM jobs WHERE job_type = 'INFERENCE_RUN' AND id = ANY(:ids)"),
                {"ids": inference_job_ids},
            )
        session.execute(
            text(
                "DELETE FROM videos WHERE title = 'inference test' "
                "AND storage_key = 'videos/inference-test.mp4'"
            )
        )
        session.commit()
    except Exception:  # noqa: BLE001 -- a failed sweep must never fail the suite
        session.rollback()
    finally:
        session.close()

    # The frames above named objects under the storage service's `test/`
    # prefix; the rows are gone, so the bytes must go too.
    try:
        from app.storage import get_storage_service

        storage = get_storage_service()
        # The worker's StorageService intentionally exposes no delete() --
        # deletion is the backend's job -- so this reaches the boto3 client
        # directly rather than widening that façade for test cleanup.
        client = storage._client  # noqa: SLF001
        bucket = storage._bucket  # noqa: SLF001
        for key in doomed_keys:
            client.delete_object(Bucket=bucket, Key=key)
        listing = client.list_objects_v2(Bucket=bucket, Prefix="test/")
        for obj in listing.get("Contents", []):
            client.delete_object(Bucket=bucket, Key=obj["Key"])
    except Exception:  # noqa: BLE001 -- object cleanup is best-effort
        pass


@pytest.fixture
def make_inference_job(db_session):
    """A Job(INFERENCE_RUN) paired with an InferenceRun and a throwaway
    videos row, linked via the payload exactly as
    backend/app/inference/service.py builds it. Committed through
    db_session (a different SessionLocal() than the task's own), and
    deleted afterwards, children before parents."""
    from sqlalchemy import text

    from app.models import InferenceRun, InferenceRunStatus, Job, JobStatus, JobType

    created: list[tuple[int, int, int]] = []

    def _make(frame_stride: int = 2):
        user_id = _existing_row_id(db_session, "users")
        video_id = db_session.execute(
            text(
                "INSERT INTO videos (storage_key, filename, title, fps, duration_seconds, "
                "size_bytes, checksum, created_at) VALUES "
                "('videos/inference-test.mp4', 'inference-test.mp4', 'inference test', "
                "10, 1, 1, 'inference-test', now()) RETURNING id"
            )
        ).scalar_one()
        run = InferenceRun(
            video_id=video_id,
            model_version_id=None,
            model_name="yolo11n-run1",
            frame_stride=frame_stride,
            status=InferenceRunStatus.PENDING,
            created_by_id=user_id,
        )
        db_session.add(run)
        db_session.commit()
        db_session.refresh(run)

        job = Job(
            job_type=JobType.INFERENCE_RUN,
            status=JobStatus.PENDING,
            progress=0,
            payload={
                "inference_run_id": run.id,
                "video_id": video_id,
                "model_version_id": None,
                "model_name": "yolo11n-run1",
                "weights_key": "models/1/best.pt",
                "task_type": "detection",
                "frame_stride": frame_stride,
            },
            created_by_id=user_id,
        )
        db_session.add(job)
        db_session.commit()
        db_session.refresh(job)

        run.job_id = job.id
        db_session.commit()
        created.append((run.id, job.id, video_id))
        return job, run

    yield _make

    from sqlalchemy import text as _text

    for run_id, job_id, video_id in created:
        db_session.query(InferenceRun).filter_by(id=run_id).delete()
        db_session.query(Job).filter_by(id=job_id).delete()
        db_session.execute(_text("DELETE FROM videos WHERE id = :id"), {"id": video_id})
    db_session.commit()
