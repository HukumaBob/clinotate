"""Four host resets happened on a SAM2 track that started 0.3-2.9 s after the previous
job (the Track button used to fire before the point's segment was drawn, so the
track queued right behind the predict). Interactive GPU jobs now keep a minimum gap
between the end of one and the start of the next."""
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


class _Clock:
    def __init__(self):
        self.now = 1000.0
        self.slept = []

    def monotonic(self):
        return self.now

    def sleep(self, seconds):
        self.slept.append(seconds)
        self.now += seconds


@pytest.fixture
def clock(monkeypatch):
    fake = _Clock()
    monkeypatch.setattr(tasks_module.time, "monotonic", fake.monotonic)
    monkeypatch.setattr(tasks_module.time, "sleep", fake.sleep)
    monkeypatch.setattr(tasks_module, "_last_gpu_job_finished", None)
    return fake


def test_the_minimum_gap_is_five_seconds():
    assert tasks_module.MIN_GPU_JOB_GAP_SECONDS == 5.0


def test_the_first_job_does_not_wait(clock):
    tasks_module._pace_gpu_jobs(sender=tasks_module.run_sam2_track)

    assert clock.slept == []


def test_a_job_right_after_another_waits_for_the_rest_of_the_gap(clock):
    tasks_module._stamp_gpu_job_finished(sender=tasks_module.run_sam2_predict)
    clock.now += 1.2

    tasks_module._pace_gpu_jobs(sender=tasks_module.run_sam2_track)

    assert clock.slept == [pytest.approx(3.8)]


def test_a_job_after_a_long_pause_does_not_wait(clock):
    tasks_module._stamp_gpu_job_finished(sender=tasks_module.run_sam2_predict)
    clock.now += 30

    tasks_module._pace_gpu_jobs(sender=tasks_module.run_sam2_track)

    assert clock.slept == []


@pytest.mark.parametrize(
    "task", ["run_sam2_predict", "run_sam2_track", "run_sam3_predict", "run_sam3_track"]
)
def test_all_interactive_sam_tasks_are_paced(clock, task):
    tasks_module._stamp_gpu_job_finished(sender=getattr(tasks_module, task))

    tasks_module._pace_gpu_jobs(sender=getattr(tasks_module, task))

    assert clock.slept == [pytest.approx(5.0)]


@pytest.mark.parametrize("task", ["model_train", "inference_run", "run_rank_quality", "run_find_similar"])
def test_other_tasks_are_not_paced_and_do_not_move_the_clock(clock, task):
    sender = getattr(tasks_module, task)
    tasks_module._stamp_gpu_job_finished(sender=sender)
    assert tasks_module._last_gpu_job_finished is None

    tasks_module._stamp_gpu_job_finished(sender=tasks_module.run_sam2_predict)
    clock.now += 1
    tasks_module._pace_gpu_jobs(sender=sender)

    assert clock.slept == []


def test_the_handlers_are_connected_to_the_celery_signals(clock):
    from celery.signals import task_postrun, task_prerun

    task_postrun.send(sender=tasks_module.run_sam2_predict, task_id="t")
    clock.now += 2

    task_prerun.send(sender=tasks_module.run_sam2_track, task_id="u")

    assert clock.slept == [pytest.approx(3.0)]
