import app.db as db_module
import app.main  # noqa: F401 -- registers every model on Base.metadata
from fastapi.testclient import TestClient

from app.inference.models import InferenceRun, InferenceRunStatus
from app.main import app

client = TestClient(app)

REFUSED = "Not available for classification runs"


def _headers(email: str) -> dict[str, str]:
    client.post("/auth/register", json={"email": email, "password": "pass1234", "role": "admin"})
    response = client.post("/auth/login", json={"email": email, "password": "pass1234"})
    return {"Authorization": f"Bearer {response.json()['access_token']}"}


def _run(rows, *, axes) -> int:
    session = db_module.SessionLocal()
    try:
        run = InferenceRun(
            video_id=rows.video_id,
            model_version_id=None if axes else rows.detect_version_id,
            model_name="qcg-run",
            frame_stride=5,
            axes=axes,
            status=InferenceRunStatus.SUCCEEDED,
            predictions_key="inference/qcg/predictions.json",
            created_by_id=rows.user_id,
        )
        session.add(run)
        session.commit()
        return run.id
    finally:
        session.close()


AXES = [{"model_version_id": None, "model_name": "m", "name": "Q", "category_id": None,
         "classes": ["a", "b"]}]


def test_flag_commit_and_compare_are_refused_for_classification_runs(committed_inference_rows):
    headers = _headers("qcg-guard@example.com")
    cls_run = _run(committed_inference_rows, axes=AXES)
    det_run = _run(committed_inference_rows, axes=None)

    put = client.put(
        f"/inference/runs/{cls_run}/flags",
        headers=headers,
        json={"frame_index": 5, "timestamp_ms": 500, "kind": "fp"},
    )
    commit = client.post(f"/inference/runs/{cls_run}/commit", headers=headers, json={})
    compare = client.get(f"/inference/compare?run_a={cls_run}&run_b={det_run}", headers=headers)
    compare_rev = client.get(f"/inference/compare?run_a={det_run}&run_b={cls_run}", headers=headers)
    delete = client.delete(f"/inference/runs/{cls_run}/flags/1", headers=headers)

    for response in (put, commit, compare, compare_rev, delete):
        assert response.status_code == 409, response.text
        assert response.json()["detail"] == REFUSED


def test_listing_flags_of_a_classification_run_is_an_empty_list(committed_inference_rows):
    headers = _headers("qcg-list@example.com")
    run_id = _run(committed_inference_rows, axes=AXES)
    response = client.get(f"/inference/runs/{run_id}/flags", headers=headers)
    assert response.status_code == 200
    assert response.json() == []
