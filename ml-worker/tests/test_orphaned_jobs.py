"""A host reset or a hard exit leaves jobs in RUNNING that no worker is running any
more, and the UI shows them as running forever. The ml-worker is a single solo
process, so when it starts any RUNNING job of the types it executes is an orphan:
it is closed as FAILED, together with the training run that belonged to it."""
import os

os.environ.setdefault("POSTGRES_USER", "endoscopy")
os.environ.setdefault("POSTGRES_PASSWORD", "endoscopy_dev_password")
os.environ.setdefault("POSTGRES_DB", "endoscopy")
os.environ.setdefault("POSTGRES_HOST", "localhost")
os.environ.setdefault("MINIO_ENDPOINT", "localhost:9000")
os.environ.setdefault("MINIO_ACCESS_KEY", "endoscopy_dev")
os.environ.setdefault("MINIO_SECRET_KEY", "endoscopy_dev_secret")
os.environ.setdefault("MINIO_BUCKET", "endoscopy-media")
os.environ.setdefault("HF_TOKEN", "unused-in-this-test")

import pytest
from sqlalchemy import text

import app.tasks as tasks_module
from app.models import Job, JobStatus, TrainingRun, TrainingRunStatus


def _set(session, job, run, job_status, run_status=None):
    job.status = job_status
    if run is not None and run_status is not None:
        run.status = run_status
    session.commit()


def test_a_running_job_and_its_training_run_are_failed_with_a_reason(db_session, make_job_and_run):
    job, run = make_job_and_run()
    _set(db_session, job, run, JobStatus.RUNNING, TrainingRunStatus.RUNNING)

    ids = tasks_module.fail_orphaned_jobs(db_session)

    assert job.id in ids
    job = db_session.get(Job, job.id)
    run = db_session.get(TrainingRun, run.id)
    assert job.status is JobStatus.FAILED and run.status is TrainingRunStatus.FAILED
    assert "worker" in job.error.lower() and "stopped" in job.error.lower()
    assert run.error == job.error
    assert job.finished_at is not None and run.finished_at is not None
    db_session.rollback()


def test_pending_and_finished_jobs_are_left_alone(db_session, make_job_and_run):
    pending, _ = make_job_and_run()
    done, done_run = make_job_and_run()
    _set(db_session, done, done_run, JobStatus.SUCCEEDED, TrainingRunStatus.SUCCEEDED)

    tasks_module.fail_orphaned_jobs(db_session)

    assert db_session.get(Job, pending.id).status is JobStatus.PENDING
    assert db_session.get(Job, done.id).status is JobStatus.SUCCEEDED
    assert db_session.get(TrainingRun, done_run.id).status is TrainingRunStatus.SUCCEEDED
    db_session.rollback()


def test_a_training_run_that_is_not_running_keeps_its_status(db_session, make_job_and_run):
    job, run = make_job_and_run()
    _set(db_session, job, run, JobStatus.RUNNING, TrainingRunStatus.STOPPED)

    tasks_module.fail_orphaned_jobs(db_session)

    assert db_session.get(TrainingRun, run.id).status is TrainingRunStatus.STOPPED
    db_session.rollback()


def test_jobs_of_other_workers_are_left_alone_and_do_not_break_the_query(db_session):
    # DATASET_EXPORT is in the database enum but not in this worker's JobType:
    # loading such a row through the ORM would raise, and it is not ours to close.
    user_id = db_session.execute(text("SELECT id FROM users ORDER BY id LIMIT 1")).scalar_one()
    foreign_id = db_session.execute(
        text(
            "INSERT INTO jobs (job_type, status, progress, payload, created_by_id, created_at) "
            "VALUES ('DATASET_EXPORT', 'RUNNING', 0, '{}', :uid, now()) RETURNING id"
        ),
        {"uid": user_id},
    ).scalar_one()
    try:
        tasks_module.fail_orphaned_jobs(db_session)

        status = db_session.execute(
            text("SELECT status FROM jobs WHERE id = :id"), {"id": foreign_id}
        ).scalar_one()
        assert status == "RUNNING"
    finally:
        db_session.rollback()


def test_the_function_does_not_commit(db_session, make_job_and_run):
    job, run = make_job_and_run()
    _set(db_session, job, run, JobStatus.RUNNING, TrainingRunStatus.RUNNING)

    tasks_module.fail_orphaned_jobs(db_session)
    db_session.rollback()

    assert db_session.get(Job, job.id).status is JobStatus.RUNNING
    db_session.rollback()


def test_nothing_to_close_returns_no_ids(db_session):
    live = db_session.execute(
        text("SELECT count(*) FROM jobs WHERE status = 'RUNNING' AND job_type::text IN "
             "('SAM3_PREDICT','SAM3_TRACK','SAM2_PREDICT','SAM2_TRACK','RANK_QUALITY',"
             "'FIND_SIMILAR','MODEL_TRAIN','INFERENCE_RUN')")
    ).scalar_one()
    if live:
        pytest.skip("a real job is running right now; this check needs none")

    assert tasks_module.fail_orphaned_jobs(db_session) == []
    db_session.rollback()


# -- the worker_ready hook ------------------------------------------------------


class _FakeSession:
    def __init__(self):
        self.calls = []

    def commit(self):
        self.calls.append("commit")

    def rollback(self):
        self.calls.append("rollback")

    def close(self):
        self.calls.append("close")


def test_worker_start_closes_orphans_and_commits(monkeypatch):
    session = _FakeSession()
    monkeypatch.setattr(tasks_module, "SessionLocal", lambda: session)
    monkeypatch.setattr(tasks_module, "fail_orphaned_jobs", lambda s: [7, 8])

    tasks_module._fail_orphaned_jobs_on_worker_ready()

    assert session.calls == ["commit", "close"]


def test_worker_start_never_fails_because_of_the_cleanup(monkeypatch):
    session = _FakeSession()
    monkeypatch.setattr(tasks_module, "SessionLocal", lambda: session)

    def _boom(_session):
        raise RuntimeError("database not reachable yet")

    monkeypatch.setattr(tasks_module, "fail_orphaned_jobs", _boom)

    tasks_module._fail_orphaned_jobs_on_worker_ready()  # must not raise

    assert session.calls == ["rollback", "close"]


def test_the_hook_is_connected_to_the_worker_ready_signal(monkeypatch):
    from celery.signals import worker_ready

    called = []
    monkeypatch.setattr(tasks_module, "SessionLocal", lambda: _FakeSession())
    monkeypatch.setattr(tasks_module, "fail_orphaned_jobs", lambda s: called.append(1) or [])

    worker_ready.send(sender=None)

    assert called == [1]
