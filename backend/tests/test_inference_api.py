import pytest
import app.db as db_module
import app.main  # noqa: F401 -- registers every model on Base.metadata
from fastapi.testclient import TestClient

from app.inference.models import InferenceRun, InferenceRunStatus
from app.main import app
from app.training.models import ModelVersion

client = TestClient(app)


def _register_and_login(email: str) -> dict[str, str]:
    client.post("/auth/register", json={"email": email, "password": "pass1234", "role": "admin"})
    response = client.post("/auth/login", json={"email": email, "password": "pass1234"})
    return {"Authorization": f"Bearer {response.json()['access_token']}"}


def test_a_run_survives_deletion_of_its_model_version(committed_inference_rows):
    """The overlay never needs the live ModelVersion: the run keeps its own
    model_name, and the FK is SET NULL rather than blocking or cascading."""
    rows = committed_inference_rows
    session = db_module.SessionLocal()
    try:
        run = InferenceRun(
            video_id=rows.video_id,
            model_version_id=rows.detect_version_id,
            model_name="seed-detection",
            frame_stride=1,
            status=InferenceRunStatus.SUCCEEDED,
            created_by_id=rows.user_id,
        )
        session.add(run)
        session.commit()
        run_id = run.id

        session.query(ModelVersion).filter(ModelVersion.id == rows.detect_version_id).delete()
        session.commit()
        session.expire_all()

        survivor = session.get(InferenceRun, run_id)
        assert survivor is not None
        assert survivor.model_version_id is None
        assert survivor.model_name == "seed-detection"
    finally:
        session.close()




from app.jobs.models import Job
from app.storage import get_storage_service


@pytest.fixture(autouse=True)
def _no_celery(monkeypatch):
    sent: list[tuple] = []
    monkeypatch.setattr(
        "app.inference.service.celery_app.send_task",
        lambda name, args=None, **kwargs: sent.append((name, args)),
    )
    return sent


def _create(headers, rows, **overrides):
    body = {
        "video_id": rows.video_id,
        "model_version_id": rows.detect_version_id,
        "frame_stride": 5,
        **overrides,
    }
    return client.post("/inference/runs", headers=headers, json=body)


def test_create_run_returns_202_and_enqueues_the_job(committed_inference_rows, _no_celery):
    headers = _register_and_login("infer-create@example.com")
    rows = committed_inference_rows

    response = _create(headers, rows)

    assert response.status_code == 202
    body = response.json()
    assert body["status"] == "pending"
    assert body["frame_stride"] == 5
    assert body["model_name"] == "seed-detection"
    session = db_module.SessionLocal()
    try:
        job = session.get(Job, body["job_id"])
        assert job.payload["inference_run_id"] == body["id"]
        assert job.payload["video_id"] == rows.video_id
        assert job.payload["task_type"] == "detection"
        assert job.payload["frame_stride"] == 5
        assert job.payload["weights_key"].endswith("/best.pt")
    finally:
        session.close()
    assert _no_celery == [("inference_run", [body["job_id"]])]


def test_create_run_accepts_a_segmentation_model(committed_inference_rows):
    headers = _register_and_login("infer-seg@example.com")
    response = _create(
        headers, committed_inference_rows,
        model_version_id=committed_inference_rows.segment_version_id,
    )
    assert response.status_code == 202


@pytest.mark.parametrize(
    "overrides,expected",
    [
        ({"video_id": 999999}, 404),
        ({"model_version_id": 999999}, 404),
        ({"frame_stride": 0}, 422),
    ],
)
def test_create_run_rejects_bad_input(committed_inference_rows, overrides, expected):
    headers = _register_and_login("infer-bad@example.com")
    assert _create(headers, committed_inference_rows, **overrides).status_code == expected


def test_create_run_rejects_a_classification_model(committed_inference_rows):
    headers = _register_and_login("infer-classify@example.com")
    response = _create(
        headers, committed_inference_rows,
        model_version_id=committed_inference_rows.classify_version_id,
    )
    assert response.status_code == 422
    assert "classification" in response.json()["detail"].lower()


def test_create_run_rejects_a_video_that_is_not_browser_playable(committed_inference_rows):
    headers = _register_and_login("infer-unplayable@example.com")
    response = _create(
        headers, committed_inference_rows,
        video_id=committed_inference_rows.unplayable_video_id,
    )
    assert response.status_code == 409
    assert "playable" in response.json()["detail"].lower()


def test_list_runs_is_newest_first(committed_inference_rows):
    headers = _register_and_login("infer-list@example.com")
    first = _create(headers, committed_inference_rows).json()["id"]
    second = _create(headers, committed_inference_rows).json()["id"]

    ids = [run["id"] for run in client.get("/inference/runs", headers=headers).json()]

    assert ids.index(second) < ids.index(first)


def test_predictions_are_refused_until_the_run_has_succeeded(committed_inference_rows):
    headers = _register_and_login("infer-notready@example.com")
    run_id = _create(headers, committed_inference_rows).json()["id"]

    response = client.get(f"/inference/runs/{run_id}/predictions", headers=headers)

    assert response.status_code == 409


def _mark_succeeded(run_id: int, key: str) -> None:
    session = db_module.SessionLocal()
    try:
        run = session.get(InferenceRun, run_id)
        run.status = InferenceRunStatus.SUCCEEDED
        run.predictions_key = key
        session.commit()
    finally:
        session.close()


class _RecordingStorage:
    def __init__(self):
        self.deleted: list[str] = []

    def delete(self, key: str) -> None:
        self.deleted.append(key)

    def url_for(self, key: str) -> str:
        return f"http://example/{key}"


def test_predictions_return_a_presigned_link_once_succeeded(committed_inference_rows):
    headers = _register_and_login("infer-ready@example.com")
    run_id = _create(headers, committed_inference_rows).json()["id"]
    _mark_succeeded(run_id, f"inference/{run_id}/predictions.json")

    app.dependency_overrides[get_storage_service] = lambda: _RecordingStorage()
    try:
        response = client.get(f"/inference/runs/{run_id}/predictions", headers=headers)
    finally:
        app.dependency_overrides.pop(get_storage_service, None)

    assert response.status_code == 200
    assert response.json()["download_url"] == f"http://example/inference/{run_id}/predictions.json"


def test_delete_removes_the_row_and_the_predictions_object(committed_inference_rows):
    headers = _register_and_login("infer-delete@example.com")
    run_id = _create(headers, committed_inference_rows).json()["id"]
    key = f"inference/{run_id}/predictions.json"
    _mark_succeeded(run_id, key)
    storage = _RecordingStorage()

    app.dependency_overrides[get_storage_service] = lambda: storage
    try:
        response = client.delete(f"/inference/runs/{run_id}", headers=headers)
    finally:
        app.dependency_overrides.pop(get_storage_service, None)

    assert response.status_code == 204
    assert storage.deleted == [key]
    assert client.get(f"/inference/runs/{run_id}", headers=headers).status_code == 404


def test_delete_is_refused_while_the_run_is_active(committed_inference_rows):
    headers = _register_and_login("infer-delete-active@example.com")
    run_id = _create(headers, committed_inference_rows).json()["id"]

    response = client.delete(f"/inference/runs/{run_id}", headers=headers)

    assert response.status_code == 409
    assert client.get(f"/inference/runs/{run_id}", headers=headers).status_code == 200


def test_deleting_a_video_that_has_qc_runs_is_refused(committed_inference_rows):
    headers = _register_and_login("infer-video-delete@example.com")
    rows = committed_inference_rows
    _create(headers, rows)

    response = client.delete(f"/media/videos/{rows.video_id}", headers=headers)

    assert response.status_code == 409
    assert "QC runs" in response.json()["detail"]
    session = db_module.SessionLocal()
    try:
        from app.media.models import Video

        assert session.get(Video, rows.video_id) is not None
    finally:
        session.close()


def test_enqueue_failure_marks_the_run_failed_and_returns_503(committed_inference_rows, monkeypatch):
    headers = _register_and_login("infer-enqueue-fail@example.com")

    def _boom(name, args=None, **kwargs):
        raise RuntimeError("broker down")

    monkeypatch.setattr("app.inference.service.celery_app.send_task", _boom)

    response = _create(headers, committed_inference_rows)

    assert response.status_code == 503
    runs = client.get("/inference/runs", headers=headers).json()
    run = runs[0]
    assert run["status"] == "failed"
    assert "Could not enqueue the job: broker down" in run["error"]
    session = db_module.SessionLocal()
    try:
        job = session.get(Job, run["job_id"])
        assert job.status.value == "failed"
        assert "broker down" in job.error
    finally:
        session.close()


def test_force_delete_removes_an_active_run_and_fails_its_job(committed_inference_rows):
    headers = _register_and_login("infer-force@example.com")
    run = _create(headers, committed_inference_rows).json()

    response = client.delete(f"/inference/runs/{run['id']}?force=true", headers=headers)

    assert response.status_code == 204
    assert client.get(f"/inference/runs/{run['id']}", headers=headers).status_code == 404


def test_force_delete_still_removes_the_run_when_storage_fails(committed_inference_rows):
    headers = _register_and_login("infer-force-storage@example.com")
    run_id = _create(headers, committed_inference_rows).json()["id"]
    _mark_succeeded(run_id, f"inference/{run_id}/predictions.json")

    class _Broken(_RecordingStorage):
        def delete(self, key):
            raise RuntimeError("minio down")

    app.dependency_overrides[get_storage_service] = lambda: _Broken()
    try:
        response = client.delete(f"/inference/runs/{run_id}", headers=headers)
    finally:
        app.dependency_overrides.pop(get_storage_service, None)

    assert response.status_code == 204


def test_delete_also_removes_the_job_row(committed_inference_rows):
    headers = _register_and_login("infer-delete-job@example.com")
    run = _create(headers, committed_inference_rows).json()
    _mark_succeeded(run["id"], f"inference/{run['id']}/predictions.json")
    app.dependency_overrides[get_storage_service] = lambda: _RecordingStorage()
    try:
        assert client.delete(f"/inference/runs/{run['id']}", headers=headers).status_code == 204
    finally:
        app.dependency_overrides.pop(get_storage_service, None)

    session = db_module.SessionLocal()
    try:
        assert session.get(Job, run["job_id"]) is None
    finally:
        session.close()
