from pathlib import Path

from fastapi.testclient import TestClient

from app.main import app

client = TestClient(app)
FIXTURE_VIDEO = Path(__file__).parent / "fixtures" / "tiny.mp4"


def _auth_headers() -> dict[str, str]:
    client.post("/auth/register", json={"email": "media1@example.com", "password": "pass1234", "role": "admin"})
    login = client.post("/auth/login", json={"email": "media1@example.com", "password": "pass1234"})
    token = login.json()["access_token"]
    return {"Authorization": f"Bearer {token}"}


def test_upload_video_creates_record():
    headers = _auth_headers()
    with open(FIXTURE_VIDEO, "rb") as f:
        response = client.post(
            "/media/videos",
            files={"file": ("tiny.mp4", f, "video/mp4")},
            data={"title": "Test procedure"},
            headers=headers,
        )
    assert response.status_code == 201
    body = response.json()
    assert body["title"] == "Test procedure"
    assert body["id"] > 0


def test_list_videos_includes_uploaded():
    headers = _auth_headers()
    with open(FIXTURE_VIDEO, "rb") as f:
        client.post(
            "/media/videos",
            files={"file": ("tiny.mp4", f, "video/mp4")},
            data={"title": "Listed procedure"},
            headers=headers,
        )
    response = client.get("/media/videos", headers=headers)
    assert response.status_code == 200
    titles = [v["title"] for v in response.json()]
    assert "Listed procedure" in titles


def test_create_sequence_extracts_frames():
    headers = _auth_headers()
    with open(FIXTURE_VIDEO, "rb") as f:
        upload_response = client.post(
            "/media/videos",
            files={"file": ("tiny.mp4", f, "video/mp4")},
            data={"title": "Sequence source"},
            headers=headers,
        )
    video_id = upload_response.json()["id"]

    sequence_response = client.post(
        f"/media/videos/{video_id}/sequences",
        json={"start_time": 0, "duration": 2},
        headers=headers,
    )
    assert sequence_response.status_code == 201
    sequence_id = sequence_response.json()["id"]

    frames_response = client.get(f"/media/sequences/{sequence_id}/frames", headers=headers)
    assert frames_response.status_code == 200
    frames = frames_response.json()
    assert len(frames) >= 1
    assert all("storage_key" in f for f in frames)
