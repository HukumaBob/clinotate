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
    assert all(f["image_url"].startswith("http") for f in frames)


def test_sequence_can_be_created_without_a_video():
    headers = _auth_headers()
    procedure_response = client.post(
        "/taxonomy/procedures", json={"name": "Standalone import"}, headers=headers
    )
    procedure_id = procedure_response.json()["id"]

    from app.db import SessionLocal
    from app.media.models import Sequence

    session = SessionLocal()
    try:
        sequence = Sequence(video_id=None, procedure_id=procedure_id, start_time=0, duration=0)
        session.add(sequence)
        session.commit()
        session.refresh(sequence)
        assert sequence.id > 0
        assert sequence.video_id is None
        assert sequence.procedure_id == procedure_id
    finally:
        session.close()


def test_get_frame_returns_browser_loadable_image_url():
    headers = _auth_headers()
    with open(FIXTURE_VIDEO, "rb") as f:
        upload_response = client.post(
            "/media/videos",
            files={"file": ("tiny.mp4", f, "video/mp4")},
            data={"title": "Single frame source"},
            headers=headers,
        )
    video_id = upload_response.json()["id"]

    sequence_response = client.post(
        f"/media/videos/{video_id}/sequences",
        json={"start_time": 0, "duration": 2},
        headers=headers,
    )
    sequence_id = sequence_response.json()["id"]

    frames = client.get(f"/media/sequences/{sequence_id}/frames", headers=headers).json()
    frame_id = frames[0]["id"]

    response = client.get(f"/media/frames/{frame_id}", headers=headers)
    assert response.status_code == 200
    body = response.json()
    assert body["id"] == frame_id
    assert body["image_url"].startswith("http")


def test_get_frame_404_for_missing_frame():
    headers = _auth_headers()
    response = client.get("/media/frames/999999999", headers=headers)
    assert response.status_code == 404


def test_create_standalone_sequence_without_video():
    headers = _auth_headers()
    procedure_id = client.post(
        "/taxonomy/procedures", json={"name": "Downloaded polyp set"}, headers=headers
    ).json()["id"]

    response = client.post(
        "/media/sequences", json={"procedure_id": procedure_id}, headers=headers
    )

    assert response.status_code == 201
    body = response.json()
    assert body["video_id"] is None
    assert body["procedure_id"] == procedure_id


def test_upload_frame_to_standalone_sequence():
    headers = _auth_headers()
    procedure_id = client.post(
        "/taxonomy/procedures", json={"name": "Downloaded polyp set 2"}, headers=headers
    ).json()["id"]
    sequence_id = client.post(
        "/media/sequences", json={"procedure_id": procedure_id}, headers=headers
    ).json()["id"]

    fixture = Path(__file__).parent / "fixtures" / "tiny_frame.png"
    with open(fixture, "rb") as f:
        response = client.post(
            f"/media/sequences/{sequence_id}/frames/upload",
            files={"file": ("frame_0.png", f, "image/png")},
            headers=headers,
        )

    assert response.status_code == 201
    body = response.json()
    assert body["sequence_id"] == sequence_id
    assert body["image_url"].startswith("http")


def test_upload_invalid_image_to_standalone_sequence_returns_4xx():
    headers = _auth_headers()
    procedure_id = client.post(
        "/taxonomy/procedures", json={"name": "Downloaded polyp set 3"}, headers=headers
    ).json()["id"]
    sequence_id = client.post(
        "/media/sequences", json={"procedure_id": procedure_id}, headers=headers
    ).json()["id"]

    response = client.post(
        f"/media/sequences/{sequence_id}/frames/upload",
        files={"file": ("not_an_image.png", b"not a real image", "image/png")},
        headers=headers,
    )

    assert response.status_code == 422

    frames = client.get(f"/media/sequences/{sequence_id}/frames", headers=headers).json()
    assert frames == []


def test_create_standalone_sequence_requires_procedure_id():
    headers = _auth_headers()
    response = client.post("/media/sequences", json={}, headers=headers)
    assert response.status_code == 422


def test_list_sequences_for_video():
    headers = _auth_headers()
    with open(FIXTURE_VIDEO, "rb") as f:
        video_id = client.post(
            "/media/videos",
            files={"file": ("tiny.mp4", f, "video/mp4")},
            data={"title": "Sequence listing source"},
            headers=headers,
        ).json()["id"]

    sequence_id = client.post(
        f"/media/videos/{video_id}/sequences",
        json={"start_time": 0, "duration": 2},
        headers=headers,
    ).json()["id"]

    response = client.get(f"/media/videos/{video_id}/sequences", headers=headers)

    assert response.status_code == 200
    ids = [s["id"] for s in response.json()]
    assert sequence_id in ids


def test_list_sequences_for_procedure():
    headers = _auth_headers()
    procedure_id = client.post(
        "/taxonomy/procedures", json={"name": "Listing procedure"}, headers=headers
    ).json()["id"]
    sequence_id = client.post(
        "/media/sequences", json={"procedure_id": procedure_id}, headers=headers
    ).json()["id"]

    response = client.get(f"/media/procedures/{procedure_id}/sequences", headers=headers)

    assert response.status_code == 200
    ids = [s["id"] for s in response.json()]
    assert sequence_id in ids


def test_get_sequence_by_id():
    import time
    headers = _auth_headers()
    procedure_response = client.post("/taxonomy/procedures", json={"name": f"media-seq-test-{int(time.time()*1000)}"}, headers=headers)
    procedure_id = procedure_response.json()["id"]

    create_response = client.post(
        "/media/sequences", json={"procedure_id": procedure_id}, headers=headers
    )
    sequence_id = create_response.json()["id"]

    response = client.get(f"/media/sequences/{sequence_id}", headers=headers)

    assert response.status_code == 200
    body = response.json()
    assert body["id"] == sequence_id
    assert body["procedure_id"] == procedure_id


def test_get_sequence_404_for_missing_sequence():
    headers = _auth_headers()
    response = client.get("/media/sequences/999999999", headers=headers)
    assert response.status_code == 404
