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
