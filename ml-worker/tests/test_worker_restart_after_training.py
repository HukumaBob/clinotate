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
