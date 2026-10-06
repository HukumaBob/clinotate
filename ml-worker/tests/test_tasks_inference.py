import json

from app.inference_adapter import InferenceResult
from app.models import InferenceRunStatus, JobStatus


class _StubAdapter:
    def __init__(self, on_infer=None):
        self.on_infer = on_infer
        self.requests = []

    def infer(self, request, on_progress):
        self.requests.append(request)
        if self.on_infer:
            self.on_infer(on_progress)
        return InferenceResult(
            task_type=request.task_type,
            fps=10.0,
            classes=["polyp"],
            frames={
                "0": {"timestamp_ms": 0, "detections": []},
                "2": {
                    "timestamp_ms": 200,
                    "detections": [
                        {"class_id": 0, "confidence": 0.9, "bbox": [0.1, 0.1, 0.2, 0.2]}
                    ],
                },
            },
        )


def test_a_successful_run_stores_the_document_and_marks_everything_done(
    db_session, make_inference_job, fake_storage
):
    from app.tasks import inference_run

    job, run = make_inference_job(frame_stride=2)
    adapter = _StubAdapter()

    inference_run(job.id, adapter=adapter)
    db_session.refresh(run)
    db_session.refresh(job)

    key = f"inference/{run.id}/predictions.json"
    assert run.status == InferenceRunStatus.SUCCEEDED
    assert run.predictions_key == key
    assert run.frames_total == run.frames_processed == 2
    assert job.status == JobStatus.SUCCEEDED
    assert job.progress == 100
    assert job.result_ref == key

    document = json.loads(fake_storage.uploaded[key])
    assert document["task_type"] == "detection"
    assert document["model"] == {"name": "yolo11n-run1", "version_id": None}
    assert document["frame_stride"] == 2
    assert document["classes"] == ["polyp"]
    assert document["frames"]["2"]["detections"][0]["confidence"] == 0.9
    assert adapter.requests[0].frame_stride == 2
    assert adapter.requests[0].task_type == "detection"


def test_an_adapter_failure_marks_the_run_failed_with_the_message(
    db_session, make_inference_job, fake_storage
):
    from app.tasks import inference_run

    class _Failing:
        def infer(self, request, on_progress):
            raise ValueError("Could not open the video file")

    job, run = make_inference_job()

    inference_run(job.id, adapter=_Failing())
    db_session.refresh(run)
    db_session.refresh(job)

    assert run.status == InferenceRunStatus.FAILED
    assert run.error == "Could not open the video file"
    assert job.status == JobStatus.FAILED
    assert job.error == "Could not open the video file"
    assert run.predictions_key is None
    assert fake_storage.uploaded == {}


def test_a_missing_video_row_fails_the_run_instead_of_crashing(
    db_session, make_inference_job, fake_storage
):
    from app.tasks import inference_run

    job, run = make_inference_job()
    # Break only the lookup: point the job at a video id that does not exist.
    job.payload = {**job.payload, "video_id": 0}
    db_session.commit()

    inference_run(job.id, adapter=_StubAdapter())
    db_session.refresh(run)

    assert run.status == InferenceRunStatus.FAILED
    assert "Video 0 not found" in run.error
    db_session.refresh(job)
    assert job.status == JobStatus.FAILED


def test_progress_is_flushed_on_a_cadence_and_the_final_tick_is_exact(
    db_session, make_inference_job, fake_storage
):
    from app.models import InferenceRun, Job
    from app.tasks import inference_run

    job, run = make_inference_job()
    seen = {}

    def _observe(on_progress):
        def read():
            r = db_session.get(InferenceRun, run.id, populate_existing=True)
            j = db_session.get(Job, job.id, populate_existing=True)
            db_session.commit()
            return r.frames_processed, r.frames_total, j.progress

        on_progress(1, 3)
        seen["first"] = read()
        on_progress(2, 3)
        seen["throttled"] = read()
        on_progress(3, 3)
        seen["final"] = read()

    adapter = _StubAdapter(on_infer=_observe)
    inference_run(job.id, adapter=adapter)
    db_session.refresh(run)

    assert seen["first"] == (1, 3, 33)
    assert seen["throttled"][0] == 1
    assert seen["final"] == (3, 3, 100)
    assert run.frames_processed == run.frames_total == 2


def test_a_failing_default_adapter_constructor_fails_the_run(
    db_session, make_inference_job, fake_storage, monkeypatch
):
    import app.ultralytics_inference_adapter as mod
    from app.tasks import inference_run

    class _Boom:
        def __init__(self):
            raise RuntimeError("no gpu")

    monkeypatch.setattr(mod, "UltralyticsInferenceAdapter", _Boom)
    job, run = make_inference_job()

    inference_run(job.id)
    db_session.refresh(run)
    db_session.refresh(job)

    assert run.status == InferenceRunStatus.FAILED
    assert run.error == "no gpu"
    assert job.status == JobStatus.FAILED


def test_other_model_families_are_evicted_before_the_model_loads(
    db_session, make_inference_job, fake_storage, monkeypatch
):
    import app.tasks as tasks_module

    calls: list[str] = []
    for name in ("sam3", "sam2", "quality", "similarity"):
        monkeypatch.setattr(
            tasks_module, f"_evict_{name}_models", lambda name=name: calls.append(name)
        )

    class _OrderRecorder:
        def infer(self, request, on_progress):
            calls.append("infer")
            return InferenceResult(
                task_type="detection", fps=1.0, classes=[], frames={"0": {"timestamp_ms": 0, "detections": []}}
            )

    job, _ = make_inference_job()
    tasks_module.inference_run(job.id, adapter=_OrderRecorder())

    assert calls[-1] == "infer"
    assert sorted(calls[:-1]) == ["quality", "sam2", "sam3", "similarity"]


def test_a_run_deleted_mid_flight_ends_without_raising_or_a_running_job(
    db_session, make_inference_job, fake_storage
):
    """A force delete removes the run row while the worker is inferring."""
    import app.db as db_module
    from app.models import InferenceRun, Job
    from app.tasks import inference_run

    job, run = make_inference_job()
    job_id, run_id = job.id, run.id

    def _delete_the_run(on_progress):
        other = db_module.SessionLocal()
        try:
            other.query(InferenceRun).filter_by(id=run_id).delete()
            other.commit()
        finally:
            other.close()

    inference_run(job_id, adapter=_StubAdapter(on_infer=_delete_the_run))

    db_session.expire_all()
    assert db_session.get(InferenceRun, run_id) is None
    assert db_session.get(Job, job_id).status == JobStatus.FAILED


def test_a_job_deleted_mid_flight_ends_without_raising(
    db_session, make_inference_job, fake_storage
):
    import app.db as db_module
    from app.models import InferenceRun, Job
    from app.tasks import inference_run

    job, run = make_inference_job()
    job_id, run_id = job.id, run.id

    def _delete_both(on_progress):
        other = db_module.SessionLocal()
        try:
            other.query(InferenceRun).filter_by(id=run_id).update({"job_id": None})
            other.query(InferenceRun).filter_by(id=run_id).delete()
            other.query(Job).filter_by(id=job_id).delete()
            other.commit()
        finally:
            other.close()

    inference_run(job_id, adapter=_StubAdapter(on_infer=_delete_both))

    db_session.expire_all()
    assert db_session.get(Job, job_id) is None


def test_timing_is_written_into_the_document_when_the_adapter_measured_it(
    db_session, make_inference_job, fake_storage
):
    from app.tasks import inference_run

    timing = {
        "frames_measured": 2,
        "preprocess_ms": {"mean": 1.0, "p50": 1.0, "p95": 1.0, "max": 1.0},
        "inference_ms": {"mean": 9.0, "p50": 9.0, "p95": 9.0, "max": 9.0},
        "postprocess_ms": {"mean": 1.0, "p50": 1.0, "p95": 1.0, "max": 1.0},
        "total_ms": {"mean": 11.0, "p50": 11.0, "p95": 11.0, "max": 11.0},
        "model_fps": 90.9,
    }

    class _TimedStub(_StubAdapter):
        def infer(self, request, on_progress):
            result = super().infer(request, on_progress)
            result.timing = timing
            return result

    job, run = make_inference_job(frame_stride=2)
    inference_run(job.id, adapter=_TimedStub())
    db_session.refresh(run)

    document = json.loads(fake_storage.uploaded[f"inference/{run.id}/predictions.json"])
    assert document["timing"] == timing


def test_the_document_has_no_timing_key_when_nothing_was_measured(
    db_session, make_inference_job, fake_storage
):
    from app.tasks import inference_run

    job, run = make_inference_job(frame_stride=2)
    inference_run(job.id, adapter=_StubAdapter())
    db_session.refresh(run)

    document = json.loads(fake_storage.uploaded[f"inference/{run.id}/predictions.json"])
    assert "timing" not in document
