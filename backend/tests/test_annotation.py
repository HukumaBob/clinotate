from fastapi.testclient import TestClient

from app.main import app

client = TestClient(app)


def _register_and_login(email: str, role: str = "annotator") -> str:
    client.post("/auth/register", json={"email": email, "password": "pass1234", "role": role})
    response = client.post("/auth/login", json={"email": email, "password": "pass1234"})
    return response.json()["access_token"]


def _headers(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


def _create_frame(token: str) -> int:
    headers = _headers(token)
    from pathlib import Path
    fixture = Path(__file__).parent / "fixtures" / "tiny.mp4"
    with open(fixture, "rb") as f:
        upload = client.post(
            "/media/videos", files={"file": ("tiny.mp4", f, "video/mp4")},
            data={"title": "annotation source"}, headers=headers,
        )
    video_id = upload.json()["id"]
    sequence = client.post(
        f"/media/videos/{video_id}/sequences", json={"start_time": 0, "duration": 2}, headers=headers
    ).json()
    frames = client.get(f"/media/sequences/{sequence['id']}/frames", headers=headers).json()
    return frames[0]["id"]


def _create_label(token: str) -> int:
    return client.post(
        "/taxonomy/labels", json={"name": "Landmark", "label_type": "geometric"}, headers=_headers(token)
    ).json()["id"]


def test_create_classification_annotation():
    token = _register_and_login("annot1@example.com")
    frame_id = _create_frame(token)
    label_id = _create_label(token)

    response = client.post(
        f"/annotation/frames/{frame_id}/annotations",
        json={"label_id": label_id},
        headers=_headers(token),
    )

    assert response.status_code == 201
    body = response.json()
    assert body["annotation_type"] == "classification"
    assert body["status"] == "draft"
    assert body["taxonomy_version"] == 1


def test_list_annotations_for_frame():
    token = _register_and_login("annot2@example.com")
    frame_id = _create_frame(token)
    label_id = _create_label(token)
    client.post(f"/annotation/frames/{frame_id}/annotations", json={"label_id": label_id}, headers=_headers(token))

    response = client.get(f"/annotation/frames/{frame_id}/annotations", headers=_headers(token))

    assert response.status_code == 200
    assert len(response.json()) == 1


def test_annotator_cannot_change_status():
    token = _register_and_login("annot3@example.com", role="annotator")
    frame_id = _create_frame(token)
    label_id = _create_label(token)
    annotation = client.post(
        f"/annotation/frames/{frame_id}/annotations", json={"label_id": label_id}, headers=_headers(token)
    ).json()

    response = client.patch(
        f"/annotation/annotations/{annotation['id']}/status",
        json={"status": "reviewed"},
        headers=_headers(token),
    )

    assert response.status_code == 403


def test_reviewer_can_change_status():
    annotator_token = _register_and_login("annot4@example.com", role="annotator")
    frame_id = _create_frame(annotator_token)
    label_id = _create_label(annotator_token)
    annotation = client.post(
        f"/annotation/frames/{frame_id}/annotations",
        json={"label_id": label_id},
        headers=_headers(annotator_token),
    ).json()

    reviewer_token = _register_and_login("reviewer1@example.com", role="reviewer")
    response = client.patch(
        f"/annotation/annotations/{annotation['id']}/status",
        json={"status": "reviewed"},
        headers=_headers(reviewer_token),
    )

    assert response.status_code == 200
    assert response.json()["status"] == "reviewed"
