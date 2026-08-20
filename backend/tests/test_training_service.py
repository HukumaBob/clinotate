import uuid

import app.db as db_module
import app.main  # noqa: F401 -- registers every model on Base.metadata for create_all
import sqlalchemy as sa
import pytest

from app.auth.models import User, UserRole
from app.datasets.models import Dataset, TaskType
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


def _session():
    """`app.db.SessionLocal()` via the module, not a name captured by
    `from app.db import SessionLocal` -- conftest.py's autouse fixture
    repoints `db_module.SessionLocal` at the test database by patching the
    module attribute, which only a call through the module object observes.
    An imported name binds once at collection time, before that patch runs,
    and would silently hit the real dev database's engine instead."""
    return db_module.SessionLocal()


class _User:
    """Minimal stand-in exposing the .id attribute create_training_run needs."""

    def __init__(self, id: int):
        self.id = id


def _make_user(session) -> User:
    """The isolated test database starts empty -- unlike the real `endoscopy`
    database this file used to hit by accident, there is no pre-existing
    user row to `SELECT ... LIMIT 1`. Each test creates (and _cleanup
    deletes) its own.
    """
    user = User(
        email=f"training-service-test-{uuid.uuid4()}@example.com",
        hashed_password="not-a-real-hash",
        role=UserRole.ADMIN,
    )
    session.add(user)
    session.commit()
    session.refresh(user)
    return user


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


def _cleanup(session, dataset_id: int, user_id: int | None = None) -> None:
    """create_training_run commits internally, so a bare session.rollback()
    in the caller's finally block does not undo the rows it wrote (unlike
    every other test in this suite, which never calls a function that
    commits). Without this, a run left PENDING/RUNNING by one test run
    would make ACTIVE_STATUSES's global "only one active run" check trip
    on the next test run against the same shared dev database.

    create_training_run writes MODEL_TRAIN jobs with payload
    {"training_run_id": ..., "export_key": ...} -- no "dataset_id" key at
    all -- so the export-job cleanup filter below (which matches on
    payload["dataset_id"]) can never catch them. The run_ids to match on
    must be captured before the TrainingRun rows are deleted, but the
    actual Job delete must happen *after* -- TrainingRun.job_id is a FK to
    Job.id, so deleting the job first (while a TrainingRun still points at
    it) violates that FK.
    """
    session.rollback()
    run_ids = [
        row[0]
        for row in session.query(TrainingRun.id).filter(TrainingRun.dataset_id == dataset_id).all()
    ]
    session.query(TrainingRun).filter(TrainingRun.dataset_id == dataset_id).delete()
    if run_ids:
        session.query(Job).filter(
            Job.job_type == JobType.MODEL_TRAIN,
            Job.payload["training_run_id"].as_integer().in_(run_ids),
        ).delete(synchronize_session=False)
    session.query(Job).filter(Job.payload["dataset_id"].as_integer() == dataset_id).delete(
        synchronize_session=False
    )
    session.query(Dataset).filter(Dataset.id == dataset_id).delete()
    if user_id is not None:
        session.query(User).filter(User.id == user_id).delete()
    session.commit()


def test_create_run_requires_an_exported_dataset():
    session = _session()
    try:
        user_id = _make_user(session).id
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
        _cleanup(session, dataset.id, user_id)
        session.close()


def test_create_run_succeeds_when_export_exists(monkeypatch):
    session = _session()
    try:
        sent = []
        monkeypatch.setattr(
            "app.training.service.celery_app.send_task",
            lambda name, args=None, **kw: sent.append((name, args)),
        )

        user_id = _make_user(session).id
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
        _cleanup(session, dataset.id, user_id)
        session.close()


def test_create_run_refuses_a_second_active_run(monkeypatch):
    # Uses two DIFFERENT datasets for the two create_training_run calls,
    # not the same one twice: the guard in app.training.service is a
    # global "only one active run at all" check (ml-worker's solo pool
    # handles exactly one training run at a time), not a per-dataset
    # check. Reusing one dataset for both calls would still pass even if
    # the guard were accidentally narrowed to per-dataset scope, so it
    # can't actually catch that regression.
    session = _session()
    dataset_b = None
    try:
        monkeypatch.setattr("app.training.service.celery_app.send_task", lambda *a, **kw: None)

        user_id = _make_user(session).id
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
            _cleanup(session, dataset_b.id, user_id)
        session.close()


def test_request_stop_sets_the_flag():
    session = _session()
    try:
        user_id = _make_user(session).id
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
        _cleanup(session, dataset.id, user_id)
        session.close()


def test_request_stop_rejects_a_finished_run():
    session = _session()
    try:
        user_id = _make_user(session).id
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
        _cleanup(session, dataset.id, user_id)
        session.close()


def test_read_log_boundaries():
    # Per the implementation, an out-of-range offset (negative, or past
    # the end of the text) resets to 0 rather than raising or clamping to
    # the end -- this pins that actual behavior so a future change to it
    # is a deliberate decision, not a silent regression.
    session = _session()
    try:
        user_id = _make_user(session).id
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
        _cleanup(session, dataset.id, user_id)
        session.close()


def test_request_stop_first_press_on_running_run_only_sets_the_flag():
    # Regression pin for existing behaviour: a first Stop is cooperative,
    # the worker is expected to notice stop_requested and end the run
    # itself at the next epoch boundary. The service must not jump ahead
    # of it.
    session = _session()
    try:
        user_id = _make_user(session).id
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
        assert stopped.status == TrainingRunStatus.RUNNING
        assert stopped.finished_at is None
    finally:
        _cleanup(session, dataset.id, user_id)
        session.close()


def test_request_stop_second_press_force_stops_a_running_run_and_fails_its_job():
    # A second Stop means the worker never acknowledged the first one --
    # it's dead (e.g. the host rebooted mid-training, a known open issue
    # on this box). The only way out is treating the repeated press as
    # confirmation to force-terminate the run from here.
    session = _session()
    try:
        user_id = _make_user(session).id
        dataset = _make_dataset(session, user_id)

        job = Job(
            job_type=JobType.MODEL_TRAIN,
            status=JobStatus.RUNNING,
            payload={"training_run_id": None, "export_key": "exports/x/dataset.zip"},
            created_by_id=user_id,
        )
        session.add(job)
        session.commit()

        run = TrainingRun(
            dataset_id=dataset.id,
            job_id=job.id,
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
        job.payload = {"training_run_id": run.id, "export_key": "exports/x/dataset.zip"}
        session.commit()

        request_stop(session, run.id)  # first press: cooperative
        stopped = request_stop(session, run.id)  # second press: force

        assert stopped.status == TrainingRunStatus.STOPPED
        assert stopped.finished_at is not None
        assert stopped.error

        session.refresh(job)
        assert job.status == JobStatus.FAILED
    finally:
        _cleanup(session, dataset.id, user_id)
        session.close()


def test_request_stop_on_a_pending_run_force_stops_immediately():
    # A PENDING run has no worker polling stop_requested yet -- there is no
    # cooperative shutdown to wait for, so the first press force-stops it
    # right away instead of requiring a second press.
    session = _session()
    try:
        user_id = _make_user(session).id
        dataset = _make_dataset(session, user_id)

        run = TrainingRun(
            dataset_id=dataset.id,
            adapter="ultralytics_yolo",
            base_model="yolo11n.pt",
            task_type=dataset.task_type,
            config={},
            status=TrainingRunStatus.PENDING,
            total_epochs=5,
            created_by_id=user_id,
        )
        session.add(run)
        session.commit()

        stopped = request_stop(session, run.id)

        assert stopped.status == TrainingRunStatus.STOPPED
        assert stopped.finished_at is not None
    finally:
        _cleanup(session, dataset.id, user_id)
        session.close()


def test_force_stop_unblocks_create_training_run(monkeypatch):
    # The whole point of the escape hatch: after a force-stop, the global
    # "only one active run" guard must no longer see this run as active,
    # so a real user's next training attempt is not permanently blocked by
    # one dead worker.
    session = _session()
    dataset_b = None
    try:
        monkeypatch.setattr("app.training.service.celery_app.send_task", lambda *a, **kw: None)

        user_id = _make_user(session).id
        dataset = _make_dataset(session, user_id)

        stuck = TrainingRun(
            dataset_id=dataset.id,
            adapter="ultralytics_yolo",
            base_model="yolo11n.pt",
            task_type=dataset.task_type,
            config={},
            status=TrainingRunStatus.RUNNING,
            total_epochs=5,
            created_by_id=user_id,
        )
        session.add(stuck)
        session.commit()

        request_stop(session, stuck.id)
        request_stop(session, stuck.id)

        dataset_b = _make_dataset(session, user_id)
        _succeeded_export(session, dataset_b.id, user_id)

        new_run = create_training_run(
            session,
            dataset_id=dataset_b.id,
            base_model="yolo11n.pt",
            config={"epochs": 1, "batch": 8},
            created_by=_User(user_id),
        )

        assert new_run.status == TrainingRunStatus.PENDING
    finally:
        _cleanup(session, dataset.id)
        if dataset_b is not None:
            _cleanup(session, dataset_b.id, user_id)
        session.close()
