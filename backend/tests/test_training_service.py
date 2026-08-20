import app.main  # noqa: F401 -- registers every model on Base.metadata for create_all
import sqlalchemy as sa
import pytest

from app.datasets.models import Dataset, TaskType
from app.db import SessionLocal
from app.jobs.models import Job, JobStatus, JobType
from app.training.models import TrainingRun, TrainingRunStatus
from app.training.service import (
    DatasetNotExported,
    RunAlreadyActive,
    RunNotStoppable,
    create_training_run,
    read_log,
    request_stop,
)


class _User:
    """Minimal stand-in exposing the .id attribute create_training_run needs."""

    def __init__(self, id: int):
        self.id = id


def _make_dataset(session, user_id: int) -> Dataset:
    dataset = Dataset(
        name="ds-training-service-test",
        task_type=TaskType.DETECTION,
        taxonomy_version=1,
        split_config={"train": 80, "val": 20},
        grouping_overrides={},
        excluded_label_ids=[],
        balance_metrics={},
        created_by_id=user_id,
    )
    session.add(dataset)
    session.commit()
    session.refresh(dataset)
    return dataset


def _succeeded_export(session, dataset_id, user_id):
    job = Job(
        job_type=JobType.DATASET_EXPORT,
        status=JobStatus.SUCCEEDED,
        payload={"dataset_id": dataset_id},
        result_ref=f"exports/{dataset_id}/dataset.zip",
        created_by_id=user_id,
    )
    session.add(job)
    session.commit()
    return job


def _cleanup(session, dataset_id: int) -> None:
    """create_training_run commits internally, so a bare session.rollback()
    in the caller's finally block does not undo the rows it wrote (unlike
    every other test in this suite, which never calls a function that
    commits). Without this, a run left PENDING/RUNNING by one test run
    would make ACTIVE_STATUSES's global "only one active run" check trip
    on the next test run against the same shared dev database.
    """
    session.rollback()
    session.query(TrainingRun).filter(TrainingRun.dataset_id == dataset_id).delete()
    session.query(Job).filter(Job.payload["dataset_id"].as_integer() == dataset_id).delete(
        synchronize_session=False
    )
    session.query(Dataset).filter(Dataset.id == dataset_id).delete()
    session.commit()


def test_create_run_requires_an_exported_dataset():
    session = SessionLocal()
    try:
        user_id = session.execute(sa.text("SELECT id FROM users ORDER BY id LIMIT 1")).scalar()
        dataset = _make_dataset(session, user_id)

        with pytest.raises(DatasetNotExported):
            create_training_run(
                session,
                dataset_id=dataset.id,
                base_model="yolo11n.pt",
                config={"epochs": 10, "batch": 8},
                created_by=_User(user_id),
            )
    finally:
        _cleanup(session, dataset.id)
        session.close()


def test_create_run_succeeds_when_export_exists(monkeypatch):
    session = SessionLocal()
    try:
        sent = []
        monkeypatch.setattr(
            "app.training.service.celery_app.send_task",
            lambda name, args=None, **kw: sent.append((name, args)),
        )

        user_id = session.execute(sa.text("SELECT id FROM users ORDER BY id LIMIT 1")).scalar()
        dataset = _make_dataset(session, user_id)
        _succeeded_export(session, dataset.id, user_id)

        run = create_training_run(
            session,
            dataset_id=dataset.id,
            base_model="yolo11n.pt",
            config={"epochs": 10, "batch": 8},
            created_by=_User(user_id),
        )

        assert run.status == TrainingRunStatus.PENDING
        assert run.total_epochs == 10
        assert run.adapter == "ultralytics_yolo"
        assert run.job_id is not None
        assert sent == [("model_train", [run.job_id])]
    finally:
        _cleanup(session, dataset.id)
        session.close()


def test_create_run_refuses_a_second_active_run(monkeypatch):
    # Uses two DIFFERENT datasets for the two create_training_run calls,
    # not the same one twice: the guard in app.training.service is a
    # global "only one active run at all" check (ml-worker's solo pool
    # handles exactly one training run at a time), not a per-dataset
    # check. Reusing one dataset for both calls would still pass even if
    # the guard were accidentally narrowed to per-dataset scope, so it
    # can't actually catch that regression.
    session = SessionLocal()
    dataset_b = None
    try:
        monkeypatch.setattr("app.training.service.celery_app.send_task", lambda *a, **kw: None)

        user_id = session.execute(sa.text("SELECT id FROM users ORDER BY id LIMIT 1")).scalar()
        dataset = _make_dataset(session, user_id)
        _succeeded_export(session, dataset.id, user_id)

        dataset_b = _make_dataset(session, user_id)
        _succeeded_export(session, dataset_b.id, user_id)

        create_training_run(
            session,
            dataset_id=dataset.id,
            base_model="yolo11n.pt",
            config={"epochs": 1, "batch": 8},
            created_by=_User(user_id),
        )

        with pytest.raises(RunAlreadyActive):
            create_training_run(
                session,
                dataset_id=dataset_b.id,
                base_model="yolo11n.pt",
                config={"epochs": 1, "batch": 8},
                created_by=_User(user_id),
            )
    finally:
        _cleanup(session, dataset.id)
        if dataset_b is not None:
            _cleanup(session, dataset_b.id)
        session.close()


def test_request_stop_sets_the_flag():
    session = SessionLocal()
    try:
        user_id = session.execute(sa.text("SELECT id FROM users ORDER BY id LIMIT 1")).scalar()
        dataset = _make_dataset(session, user_id)

        run = TrainingRun(
            dataset_id=dataset.id,
            adapter="ultralytics_yolo",
            base_model="yolo11n.pt",
            task_type=dataset.task_type,
            config={},
            status=TrainingRunStatus.RUNNING,
            total_epochs=5,
            created_by_id=user_id,
        )
        session.add(run)
        session.commit()

        stopped = request_stop(session, run.id)

        assert stopped.stop_requested is True
        # Still RUNNING -- the worker decides when it actually ends.
        assert stopped.status == TrainingRunStatus.RUNNING
    finally:
        _cleanup(session, dataset.id)
        session.close()


def test_request_stop_rejects_a_finished_run():
    session = SessionLocal()
    try:
        user_id = session.execute(sa.text("SELECT id FROM users ORDER BY id LIMIT 1")).scalar()
        dataset = _make_dataset(session, user_id)

        run = TrainingRun(
            dataset_id=dataset.id,
            adapter="ultralytics_yolo",
            base_model="yolo11n.pt",
            task_type=dataset.task_type,
            config={},
            status=TrainingRunStatus.SUCCEEDED,
            total_epochs=5,
            created_by_id=user_id,
        )
        session.add(run)
        session.commit()

        with pytest.raises(RunNotStoppable):
            request_stop(session, run.id)
    finally:
        _cleanup(session, dataset.id)
        session.close()


def test_read_log_boundaries():
    # Per the implementation, an out-of-range offset (negative, or past
    # the end of the text) resets to 0 rather than raising or clamping to
    # the end -- this pins that actual behavior so a future change to it
    # is a deliberate decision, not a silent regression.
    session = SessionLocal()
    try:
        user_id = session.execute(sa.text("SELECT id FROM users ORDER BY id LIMIT 1")).scalar()
        dataset = _make_dataset(session, user_id)

        text = "line one\nline two\n"
        run = TrainingRun(
            dataset_id=dataset.id,
            adapter="ultralytics_yolo",
            base_model="yolo11n.pt",
            task_type=dataset.task_type,
            config={},
            status=TrainingRunStatus.RUNNING,
            log_text=text,
            total_epochs=3,
            created_by_id=user_id,
        )
        session.add(run)
        session.commit()

        # offset 0: full text back, new offset is len(text).
        tail, new_offset, status = read_log(session, run.id, 0)
        assert tail == text
        assert new_offset == len(text)
        assert status == TrainingRunStatus.RUNNING

        # offset == len(text): nothing new since caller is caught up.
        tail, new_offset, status = read_log(session, run.id, len(text))
        assert tail == ""
        assert new_offset == len(text)

        # offset > len(text): out of range, resets to 0 -- full text again.
        tail, new_offset, status = read_log(session, run.id, len(text) + 100)
        assert tail == text
        assert new_offset == len(text)

        # negative offset: also out of range, resets to 0.
        tail, new_offset, status = read_log(session, run.id, -5)
        assert tail == text
        assert new_offset == len(text)
    finally:
        _cleanup(session, dataset.id)
        session.close()
