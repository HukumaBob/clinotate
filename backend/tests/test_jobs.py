from pathlib import Path

from fastapi.testclient import TestClient

from app.main import app

client = TestClient(app)


def _register_and_login(email: str) -> str:
    client.post("/auth/register", json={"email": email, "password": "pass1234", "role": "annotator"})
    response = client.post("/auth/login", json={"email": email, "password": "pass1234"})
    return response.json()["access_token"]


def _auth_headers(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


def test_get_job_requires_auth():
    response = client.get("/jobs/1")
    assert response.status_code == 401


def test_get_nonexistent_job_returns_404():
    token = _auth_headers(_register_and_login("jobs1@example.com"))
    response = client.get("/jobs/999999", headers=token)
    assert response.status_code == 404


def test_get_job_returns_current_state():
    from app.db import SessionLocal
    from app.jobs.models import Job, JobStatus, JobType

    token_str = _register_and_login("jobs2@example.com")
    token = _auth_headers(token_str)

    me_response = client.get("/auth/me", headers=token)
    user_id = me_response.json()["id"]

    session = SessionLocal()
    job = Job(
        job_type=JobType.SAM3_PREDICT,
        status=JobStatus.RUNNING,
        progress=42,
        payload={"frame_id": 1},
        created_by_id=user_id,
    )
    session.add(job)
    session.commit()
    session.refresh(job)
    job_id = job.id
    session.close()

    response = client.get(f"/jobs/{job_id}", headers=token)

    assert response.status_code == 200
    body = response.json()
    assert body["status"] == "running"
    assert body["progress"] == 42
    assert body["job_type"] == "sam3_predict"


def _create_frame(token: str) -> int:
    headers = _auth_headers(token)
    fixture = Path(__file__).parent / "fixtures" / "tiny.mp4"
    with open(fixture, "rb") as f:
        upload = client.post(
            "/media/videos", files={"file": ("tiny.mp4", f, "video/mp4")},
            data={"title": "jobs test source"}, headers=headers,
        )
    video_id = upload.json()["id"]
    sequence = client.post(
        f"/media/videos/{video_id}/sequences", json={"start_time": 0, "duration": 2}, headers=headers
    ).json()
    frames = client.get(f"/media/sequences/{sequence['id']}/frames", headers=headers).json()
    return frames[0]["id"], sequence["id"]


def test_enqueue_sam3_predict_creates_pending_job():
    token = _register_and_login("jobs3@example.com")
    frame_id, _ = _create_frame(token)

    response = client.post(
        "/jobs/sam3/predict",
        json={"frame_id": frame_id, "prompts": [{"type": "point", "coords": [0.5, 0.5], "label": True}]},
        headers=_auth_headers(token),
    )

    assert response.status_code == 201
    body = response.json()
    assert body["job_type"] == "sam3_predict"
    assert body["status"] == "pending"


def test_enqueue_sam3_track_creates_pending_job():
    token = _register_and_login("jobs4@example.com")
    _, sequence_id = _create_frame(token)

    response = client.post(
        "/jobs/sam3/track",
        json={"sequence_id": sequence_id, "prompts": [{"type": "box", "coords": [0.1, 0.1, 0.3, 0.3], "label": True}]},
        headers=_auth_headers(token),
    )

    assert response.status_code == 201
    body = response.json()
    assert body["job_type"] == "sam3_track"
    assert body["status"] == "pending"


def test_enqueue_requires_auth():
    response = client.post("/jobs/sam3/predict", json={"frame_id": 1, "prompts": []})
    assert response.status_code == 401
