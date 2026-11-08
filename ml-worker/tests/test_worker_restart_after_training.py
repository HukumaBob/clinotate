"""After a training task the worker process must exit so the container's
restart policy hands the next task a fresh process: a finished training run
leaves ~5 GB (CUDA context, PyTorch, Ultralytics) resident that nothing in
the process releases."""
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

import app.tasks as tasks_module


@pytest.fixture
def exits(monkeypatch):
    calls = []
    monkeypatch.setattr(tasks_module, "_exit_worker_process", lambda: calls.append(1))
    return calls


def test_worker_exits_after_a_training_task(exits):
    tasks_module._restart_worker_after_training(sender=tasks_module.model_train)
    assert exits == [1]


def test_worker_keeps_running_after_other_tasks(exits):
    tasks_module._restart_worker_after_training(sender=tasks_module.run_sam2_predict)
    assert exits == []


def test_signal_for_a_training_task_triggers_the_exit(exits):
    from celery.signals import task_postrun

    task_postrun.send(sender=tasks_module.model_train, task_id="t")
    assert exits == [1]


# -- the exit itself: warm shutdown, never a bare hard exit ---------------------
#
# A hard `os._exit` right after the task leaves the task's message unacked in
# Redis (Celery acks only once the task has completed), so it is delivered again
# after the next restart: training run 660 was re-executed three times that way.


class _FakeTimer:
    created = []

    def __init__(self, interval, function, args=()):
        self.interval, self.function, self.args = interval, function, args
        self.daemon = False
        self.started = False
        _FakeTimer.created.append(self)

    def start(self):
        self.started = True


def _patch_exit_machinery(monkeypatch):
    import os
    import signal

    kills = []
    monkeypatch.setattr(tasks_module.os, "kill", lambda pid, sig: kills.append((pid, sig)))

    def _hard_exit(code):
        raise AssertionError("os._exit must not be called directly")

    monkeypatch.setattr(tasks_module.os, "_exit", _hard_exit)
    _FakeTimer.created = []
    monkeypatch.setattr(tasks_module.threading, "Timer", _FakeTimer)
    return kills, os, signal


def test_exit_asks_for_a_warm_shutdown_with_sigterm(monkeypatch):
    kills, os, signal = _patch_exit_machinery(monkeypatch)

    tasks_module._exit_worker_process()

    assert kills == [(os.getpid(), signal.SIGTERM)]


def test_exit_keeps_a_hard_exit_watchdog_for_a_hung_shutdown(monkeypatch):
    _patch_exit_machinery(monkeypatch)

    tasks_module._exit_worker_process()

    (watchdog,) = _FakeTimer.created
    assert watchdog.started and watchdog.daemon
    assert watchdog.interval == 30.0
    assert watchdog.function is tasks_module.os._exit and watchdog.args == (0,)


def test_track_failure_restart_uses_the_same_graceful_exit(exits):
    tasks_module._restart_worker_process_after_track_failure()

    assert exits == [1]
