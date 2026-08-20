import threading
from pathlib import Path

from app.models import JobStatus, ModelVersion, TrainingRun, TrainingRunStatus
from app.training_adapter import TrainingResult


class StubAdapter:
    def __init__(self, *, stop_after=None):
        self.stop_after = stop_after
        self.saw_stop = False

    def train(self, request, on_log, on_epoch, should_stop):
        total = int(request.config["epochs"])
        completed = 0
        for epoch in range(1, total + 1):
            on_log(f"epoch {epoch}/{total}")
            on_epoch(epoch, total)
            completed = epoch
            if should_stop():
                self.saw_stop = True
                break
        weights = request.output_dir / "weights.pt"
        weights.parent.mkdir(parents=True, exist_ok=True)
        weights.write_bytes(b"fake-weights")
        return TrainingResult(weights_path=weights, metrics={"mAP50": 0.5})


def test_successful_run_creates_a_model_version(training_job, db_session, monkeypatch, fake_storage):
    from app import tasks

    adapter = StubAdapter()
    tasks.model_train(training_job.id, adapter=adapter)

    run = db_session.get(TrainingRun, training_job.payload["training_run_id"])
    assert run.status == TrainingRunStatus.SUCCEEDED
    assert run.current_epoch == run.total_epochs
    assert "epoch 1/2" in run.log_text
    assert run.metrics["mAP50"] == 0.5

    version = db_session.query(ModelVersion).filter_by(training_run_id=run.id).one()
    assert version.storage_key.endswith(".pt")

    job = db_session.get(tasks.Job, training_job.id)
    assert job.status == JobStatus.SUCCEEDED


def test_stop_requested_ends_as_stopped_and_still_keeps_weights(
    training_job, db_session, monkeypatch, fake_storage
):
    from app import tasks

    run = db_session.get(TrainingRun, training_job.payload["training_run_id"])
    run.stop_requested = True
    db_session.commit()

    tasks.model_train(training_job.id, adapter=StubAdapter())

    db_session.refresh(run)
    assert run.status == TrainingRunStatus.STOPPED
    assert run.current_epoch == 1
    # A stopped run is not a failed one: Ultralytics has already written
    # weights by the epoch boundary, so the version is real.
    assert db_session.query(ModelVersion).filter_by(training_run_id=run.id).count() == 1


def test_adapter_failure_marks_the_run_failed(training_job, db_session, fake_storage):
    from app import tasks

    class ExplodingAdapter:
        def train(self, request, on_log, on_epoch, should_stop):
            on_log("starting")
            raise RuntimeError("CUDA out of memory")

    tasks.model_train(training_job.id, adapter=ExplodingAdapter())

    run = db_session.get(TrainingRun, training_job.payload["training_run_id"])
    assert run.status == TrainingRunStatus.FAILED
    assert "CUDA out of memory" in run.error
    # The log written before the crash survives -- it is the only diagnostic.
    assert "starting" in run.log_text
    assert db_session.query(ModelVersion).filter_by(training_run_id=run.id).count() == 0


def test_log_buffer_is_thread_safe_under_concurrent_calls(db_session, training_job):
    """Regression test for the hazard surfaced in Task 4's review:
    UltralyticsYoloAdapter's _ForwardingLogHandler.emit() calls on_log
    directly from whatever thread stdlib logging happens to run on (a
    DataLoader/callback thread, not necessarily the training thread), and
    on_log here both mutates a list and commits a non-thread-safe
    SQLAlchemy Session. Without _LogBuffer's own lock serializing add()
    and flush(), two threads racing to flush concurrently risk lost lines
    or a corrupted/exception-raising session.commit()."""
    from app import tasks

    run = db_session.get(TrainingRun, training_job.payload["training_run_id"])
    # Flush every single line so both threads are forced to contend for
    # the lock on nearly every call, maximizing the chance of exposing a
    # race if the lock were missing.
    buffer = tasks._LogBuffer(db_session, run, flush_seconds=0, flush_lines=1)

    lines_per_thread = 50
    errors: list[BaseException] = []

    def _emit(prefix: str) -> None:
        try:
            for i in range(lines_per_thread):
                buffer.add(f"{prefix}-{i}")
        except BaseException as exc:  # noqa: BLE001 -- captured for the assertion below
            errors.append(exc)

    threads = [
        threading.Thread(target=_emit, args=("a",)),
        threading.Thread(target=_emit, args=("b",)),
    ]
    for t in threads:
        t.start()
    for t in threads:
        t.join()

    buffer.flush()

    assert errors == []
    db_session.refresh(run)
    logged = run.log_text
    for prefix in ("a", "b"):
        for i in range(lines_per_thread):
            assert f"{prefix}-{i}" in logged
