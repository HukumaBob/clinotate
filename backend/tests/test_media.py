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


def test_upload_video_stores_filename_and_size():
    headers = _auth_headers()
    with open(FIXTURE_VIDEO, "rb") as f:
        data = f.read()
    response = client.post(
        "/media/videos",
        files={"file": ("tiny.mp4", data, "video/mp4")},
        data={"title": "Filename test"},
        headers=headers,
    )
    assert response.status_code == 201
    body = response.json()
    assert body["filename"] == "tiny.mp4"


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
        json={"name": "test sequence", "start_time": 0, "duration": 2},
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
        sequence = Sequence(video_id=None, procedure_id=procedure_id, name="", start_time=0, duration=0)
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
        json={"name": "test sequence", "start_time": 0, "duration": 2},
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
        "/media/sequences",
        json={"procedure_id": procedure_id, "name": "test sequence"},
        headers=headers,
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
        "/media/sequences",
        json={"procedure_id": procedure_id, "name": "test sequence"},
        headers=headers,
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
        "/media/sequences",
        json={"procedure_id": procedure_id, "name": "test sequence"},
        headers=headers,
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
        json={"name": "test sequence", "start_time": 0, "duration": 2},
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
        "/media/sequences",
        json={"procedure_id": procedure_id, "name": "test sequence"},
        headers=headers,
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
        "/media/sequences",
        json={"procedure_id": procedure_id, "name": "test sequence"},
        headers=headers,
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


def test_suggest_sequence_name_first_of_the_day():
    headers = _auth_headers()
    procedure_id = client.post(
        "/taxonomy/procedures", json={"name": "Suggest name EGD 1"}, headers=headers
    ).json()["id"]

    response = client.get(
        "/media/sequences/suggest-name", params={"procedure_id": procedure_id}, headers=headers
    )

    assert response.status_code == 200
    body = response.json()
    assert body["name"].startswith("Suggest name EGD 1 ")
    assert body["name"].endswith("#1")


def test_suggest_sequence_name_increments_same_day_ordinal():
    headers = _auth_headers()
    procedure_id = client.post(
        "/taxonomy/procedures", json={"name": "Suggest name EGD 2"}, headers=headers
    ).json()["id"]

    first_name = client.get(
        "/media/sequences/suggest-name", params={"procedure_id": procedure_id}, headers=headers
    ).json()["name"]
    client.post(
        "/media/sequences",
        json={"procedure_id": procedure_id, "name": first_name, "start_time": 0, "duration": 0},
        headers=headers,
    )

    second_response = client.get(
        "/media/sequences/suggest-name", params={"procedure_id": procedure_id}, headers=headers
    )

    assert second_response.json()["name"].endswith("#2")


def test_extract_frames_applies_crop_box_as_percentage_insets():
    from app.media.schemas import CropBox
    from app.media.service import extract_frames

    with open(FIXTURE_VIDEO, "rb") as f:
        video_bytes = f.read()

    uncropped = extract_frames(video_bytes, sample_fps=1.0)
    original_width, original_height = uncropped[0][2], uncropped[0][3]

    crop = CropBox(left=10, right=10, top=20, bottom=20)
    cropped = extract_frames(video_bytes, sample_fps=1.0, crop=crop)

    expected_width = original_width - int(original_width * 0.10) - int(original_width * 0.10)
    expected_height = original_height - int(original_height * 0.20) - int(original_height * 0.20)
    assert cropped[0][2] == expected_width
    assert cropped[0][3] == expected_height


def test_extract_frames_all_zero_crop_is_a_no_op():
    from app.media.schemas import CropBox
    from app.media.service import extract_frames

    with open(FIXTURE_VIDEO, "rb") as f:
        video_bytes = f.read()

    uncropped = extract_frames(video_bytes, sample_fps=1.0)
    zero_cropped = extract_frames(video_bytes, sample_fps=1.0, crop=CropBox())

    assert zero_cropped[0][2] == uncropped[0][2]
    assert zero_cropped[0][3] == uncropped[0][3]


def test_upload_photo_batch_creates_one_sequence_and_all_frames():
    headers = _auth_headers()
    procedure_id = client.post(
        "/taxonomy/procedures", json={"name": "Photo batch procedure"}, headers=headers
    ).json()["id"]

    fixture = Path(__file__).parent / "fixtures" / "tiny_frame.png"
    with open(fixture, "rb") as f:
        image_bytes = f.read()

    response = client.post(
        "/media/sequences/photos",
        data={"name": "Photo batch seq", "procedure_id": str(procedure_id)},
        files=[
            ("files", ("a.png", image_bytes, "image/png")),
            ("files", ("b.png", image_bytes, "image/png")),
            ("files", ("c.png", image_bytes, "image/png")),
        ],
        headers=headers,
    )

    assert response.status_code == 201
    body = response.json()
    assert body["name"] == "Photo batch seq"
    assert body["video_id"] is None
    sequence_id = body["id"]

    frames = client.get(f"/media/sequences/{sequence_id}/frames", headers=headers).json()
    assert len(frames) == 3
    assert [f["frame_index"] for f in frames] == [0, 1, 2]


def test_upload_photo_batch_rejects_non_image_file():
    headers = _auth_headers()
    procedure_id = client.post(
        "/taxonomy/procedures", json={"name": "Photo batch bad file"}, headers=headers
    ).json()["id"]

    fixture = Path(__file__).parent / "fixtures" / "tiny_frame.png"
    with open(fixture, "rb") as f:
        image_bytes = f.read()

    response = client.post(
        "/media/sequences/photos",
        data={"name": "Photo batch bad", "procedure_id": str(procedure_id)},
        files=[
            ("files", ("a.png", image_bytes, "image/png")),
            ("files", ("bad.png", b"not a real image", "image/png")),
        ],
        headers=headers,
    )

    assert response.status_code == 422


def test_create_standalone_sequence_requires_name():
    headers = _auth_headers()
    procedure_id = client.post(
        "/taxonomy/procedures", json={"name": "Requires name test"}, headers=headers
    ).json()["id"]

    response = client.post(
        "/media/sequences", json={"procedure_id": procedure_id}, headers=headers
    )

    assert response.status_code == 422


def test_media_library_lists_videos_and_photo_sequences():
    headers = _auth_headers()
    procedure_id = client.post(
        "/taxonomy/procedures", json={"name": "Library listing procedure"}, headers=headers
    ).json()["id"]

    with open(FIXTURE_VIDEO, "rb") as f:
        video_id = client.post(
            "/media/videos",
            files={"file": ("library_video.mp4", f, "video/mp4")},
            data={"title": "Library video", "procedure_id": str(procedure_id)},
            headers=headers,
        ).json()["id"]

    client.post(
        f"/media/videos/{video_id}/sequences",
        json={"name": "Library video seq", "start_time": 0, "duration": 2},
        headers=headers,
    )

    fixture = Path(__file__).parent / "fixtures" / "tiny_frame.png"
    with open(fixture, "rb") as f:
        image_bytes = f.read()
    photo_sequence_id = client.post(
        "/media/sequences/photos",
        data={"name": "Library photo seq", "procedure_id": str(procedure_id)},
        files=[("files", ("p.png", image_bytes, "image/png"))],
        headers=headers,
    ).json()["id"]

    response = client.get("/media/library", headers=headers)

    assert response.status_code == 200
    items = response.json()
    video_item = next(i for i in items if i["kind"] == "video" and i["filename"] == "library_video.mp4")
    assert video_item["linked_sequence_count"] == 1

    photo_item = next(i for i in items if i["kind"] == "photo" and i["id"] == photo_sequence_id)
    assert photo_item["linked_sequence_count"] == 1
    assert photo_item["filename"] == "Library photo seq"


def test_delete_video_without_sequences_succeeds():
    headers = _auth_headers()
    with open(FIXTURE_VIDEO, "rb") as f:
        video_id = client.post(
            "/media/videos",
            files={"file": ("deletable.mp4", f, "video/mp4")},
            data={"title": "Deletable video"},
            headers=headers,
        ).json()["id"]

    response = client.delete(f"/media/videos/{video_id}", headers=headers)

    assert response.status_code == 204
    assert client.get("/media/videos", headers=headers).json()
    assert video_id not in [v["id"] for v in client.get("/media/videos", headers=headers).json()]


def test_delete_video_with_linked_sequence_returns_409():
    headers = _auth_headers()
    with open(FIXTURE_VIDEO, "rb") as f:
        video_id = client.post(
            "/media/videos",
            files={"file": ("linked.mp4", f, "video/mp4")},
            data={"title": "Linked video"},
            headers=headers,
        ).json()["id"]
    client.post(
        f"/media/videos/{video_id}/sequences",
        json={"name": "Linked seq", "start_time": 0, "duration": 2},
        headers=headers,
    )

    response = client.delete(f"/media/videos/{video_id}", headers=headers)

    assert response.status_code == 409


def test_delete_photo_sequence_without_annotations_succeeds():
    headers = _auth_headers()
    procedure_id = client.post(
        "/taxonomy/procedures", json={"name": "Delete photo seq procedure"}, headers=headers
    ).json()["id"]
    sequence_id = client.post(
        "/media/sequences",
        json={"procedure_id": procedure_id, "name": "Deletable photo seq"},
        headers=headers,
    ).json()["id"]

    response = client.delete(f"/media/sequences/{sequence_id}", headers=headers)

    assert response.status_code == 204


def test_delete_video_derived_sequence_via_media_endpoint_returns_404():
    headers = _auth_headers()
    with open(FIXTURE_VIDEO, "rb") as f:
        video_id = client.post(
            "/media/videos",
            files={"file": ("not_deletable_here.mp4", f, "video/mp4")},
            data={"title": "Not deletable here"},
            headers=headers,
        ).json()["id"]
    sequence_id = client.post(
        f"/media/videos/{video_id}/sequences",
        json={"name": "Video-derived seq", "start_time": 0, "duration": 2},
        headers=headers,
    ).json()["id"]

    response = client.delete(f"/media/sequences/{sequence_id}", headers=headers)

    assert response.status_code == 404
