from pathlib import Path

from fastapi.testclient import TestClient

from app.main import app
from app.media.service import probe_codec_compatibility

client = TestClient(app)
FIXTURE_VIDEO = Path(__file__).parent / "fixtures" / "tiny.mp4"
FIXTURE_VIDEO_H264 = Path(__file__).parent / "fixtures" / "tiny_h264.mp4"
FIXTURE_VIDEO_VP8_WEBM = Path(__file__).parent / "fixtures" / "tiny_vp8.webm"


def test_sequence_update_rejects_partial_temporal_fields():
    from pydantic import ValidationError

    from app.media.schemas import SequenceUpdate

    # start_time without duration/fps must fail validation -- a partial
    # re-cut would leave timing/frame_index inconsistent.
    try:
        SequenceUpdate(start_time=5)
        assert False, "expected a validation error"
    except ValidationError as exc:
        assert "start_time" in str(exc) or "duration" in str(exc) or "fps" in str(exc)


def test_sequence_update_allows_name_only():
    from app.media.schemas import SequenceUpdate

    update = SequenceUpdate(name="Renamed")
    assert update.name == "Renamed"
    assert update.start_time is None


def test_sequence_update_allows_all_three_temporal_fields_together():
    from app.media.schemas import SequenceUpdate

    update = SequenceUpdate(start_time=0, duration=10, fps=2.0)
    assert update.start_time == 0
    assert update.duration == 10
    assert update.fps == 2.0


def _auth_headers() -> dict[str, str]:
    client.post("/auth/register", json={"email": "media1@example.com", "password": "pass1234", "role": "admin"})
    login = client.post("/auth/login", json={"email": "media1@example.com", "password": "pass1234"})
    token = login.json()["access_token"]
    return {"Authorization": f"Bearer {token}"}


def test_upload_video_creates_record():
    headers = _auth_headers()
    procedure_id = client.post(
        "/taxonomy/procedures", json={"name": "upload-test-procedure"}, headers=headers
    ).json()["id"]
    with open(FIXTURE_VIDEO, "rb") as f:
        response = client.post(
            "/media/videos",
            files={"file": ("tiny.mp4", f, "video/mp4")},
            data={"title": "Test procedure", "procedure_id": procedure_id},
            headers=headers,
        )
    assert response.status_code == 201
    body = response.json()
    assert body["title"] == "Test procedure"
    assert body["id"] > 0


def test_upload_video_requires_procedure_id():
    headers = _auth_headers()
    with open(FIXTURE_VIDEO, "rb") as f:
        response = client.post(
            "/media/videos",
            files={"file": ("tiny.mp4", f, "video/mp4")},
            data={"title": "No procedure"},
            headers=headers,
        )
    assert response.status_code == 422


def test_upload_video_stores_filename_and_size():
    headers = _auth_headers()
    procedure_id = client.post(
        "/taxonomy/procedures", json={"name": "filename-size-procedure"}, headers=headers
    ).json()["id"]
    with open(FIXTURE_VIDEO, "rb") as f:
        data = f.read()
    response = client.post(
        "/media/videos",
        files={"file": ("tiny.mp4", data, "video/mp4")},
        data={"title": "Filename test", "procedure_id": procedure_id},
        headers=headers,
    )
    assert response.status_code == 201
    body = response.json()
    assert body["filename"] == "tiny.mp4"


def test_list_videos_includes_uploaded():
    headers = _auth_headers()
    procedure_id = client.post(
        "/taxonomy/procedures", json={"name": "list-videos-procedure"}, headers=headers
    ).json()["id"]
    with open(FIXTURE_VIDEO, "rb") as f:
        client.post(
            "/media/videos",
            files={"file": ("tiny.mp4", f, "video/mp4")},
            data={"title": "Listed procedure", "procedure_id": procedure_id},
            headers=headers,
        )
    response = client.get("/media/videos", headers=headers)
    assert response.status_code == 200
    titles = [v["title"] for v in response.json()]
    assert "Listed procedure" in titles


def test_create_sequence_extracts_frames():
    headers = _auth_headers()
    procedure_id = client.post(
        "/taxonomy/procedures", json={"name": "extracts-frames-procedure"}, headers=headers
    ).json()["id"]
    with open(FIXTURE_VIDEO, "rb") as f:
        upload_response = client.post(
            "/media/videos",
            files={"file": ("tiny.mp4", f, "video/mp4")},
            data={"title": "Sequence source", "procedure_id": procedure_id},
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


def test_create_sequence_from_video_persists_selected_procedure_id():
    headers = _auth_headers()
    procedure_id = client.post(
        "/taxonomy/procedures", json={"name": "Video sequence procedure"}, headers=headers
    ).json()["id"]

    with open(FIXTURE_VIDEO, "rb") as f:
        upload_response = client.post(
            "/media/videos",
            files={"file": ("tiny.mp4", f, "video/mp4")},
            data={"title": "Procedure-tagged source", "procedure_id": procedure_id},
            headers=headers,
        )
    video_id = upload_response.json()["id"]

    sequence_response = client.post(
        f"/media/videos/{video_id}/sequences",
        json={
            "name": "procedure-tagged sequence",
            "procedure_id": procedure_id,
            "start_time": 0,
            "duration": 2,
        },
        headers=headers,
    )
    assert sequence_response.status_code == 201
    assert sequence_response.json()["procedure_id"] == procedure_id


def test_create_sequence_with_invalid_crop_box_returns_422_and_creates_no_sequence():
    headers = _auth_headers()
    procedure_id = client.post(
        "/taxonomy/procedures", json={"name": "invalid-crop-procedure"}, headers=headers
    ).json()["id"]
    with open(FIXTURE_VIDEO, "rb") as f:
        upload_response = client.post(
            "/media/videos",
            files={"file": ("tiny.mp4", f, "video/mp4")},
            data={"title": "Invalid crop source", "procedure_id": procedure_id},
            headers=headers,
        )
    video_id = upload_response.json()["id"]

    before_count = len(client.get(f"/media/videos/{video_id}/sequences", headers=headers).json())

    sequence_response = client.post(
        f"/media/videos/{video_id}/sequences",
        json={
            "name": "invalid crop sequence",
            "start_time": 0,
            "duration": 2,
            "crop": {"left": 60, "right": 60, "top": 0, "bottom": 0},
        },
        headers=headers,
    )
    assert sequence_response.status_code == 422

    after_count = len(client.get(f"/media/videos/{video_id}/sequences", headers=headers).json())
    assert after_count == before_count


def test_create_sequence_with_negative_crop_value_returns_422():
    headers = _auth_headers()
    procedure_id = client.post(
        "/taxonomy/procedures", json={"name": "negative-crop-procedure"}, headers=headers
    ).json()["id"]
    with open(FIXTURE_VIDEO, "rb") as f:
        upload_response = client.post(
            "/media/videos",
            files={"file": ("tiny.mp4", f, "video/mp4")},
            data={"title": "Negative crop source", "procedure_id": procedure_id},
            headers=headers,
        )
    video_id = upload_response.json()["id"]

    sequence_response = client.post(
        f"/media/videos/{video_id}/sequences",
        json={
            "name": "negative crop sequence",
            "start_time": 0,
            "duration": 2,
            "crop": {"left": -50, "right": 0, "top": 0, "bottom": 0},
        },
        headers=headers,
    )
    assert sequence_response.status_code == 422


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
    procedure_id = client.post(
        "/taxonomy/procedures", json={"name": "single-frame-procedure"}, headers=headers
    ).json()["id"]
    with open(FIXTURE_VIDEO, "rb") as f:
        upload_response = client.post(
            "/media/videos",
            files={"file": ("tiny.mp4", f, "video/mp4")},
            data={"title": "Single frame source", "procedure_id": procedure_id},
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
    procedure_id = client.post(
        "/taxonomy/procedures", json={"name": "sequence-listing-procedure"}, headers=headers
    ).json()["id"]
    with open(FIXTURE_VIDEO, "rb") as f:
        video_id = client.post(
            "/media/videos",
            files={"file": ("tiny.mp4", f, "video/mp4")},
            data={"title": "Sequence listing source", "procedure_id": procedure_id},
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


def test_extract_frames_windows_by_start_time_and_duration():
    from app.media.service import extract_frames

    fixture = Path(__file__).parent / "fixtures" / "tiny_10s.mp4"
    with open(fixture, "rb") as f:
        video_bytes = f.read()

    # 10s @ 10fps source, sampled at 1fps -- unwindowed extraction covers
    # the full 10 seconds (10 frames); windowed to [3, 3+4) must cover only
    # that 4-second slice (4 frames), not the whole video.
    full = extract_frames(video_bytes, sample_fps=1.0)
    assert len(full) == 10

    windowed = extract_frames(video_bytes, sample_fps=1.0, start_time=3.0, duration=4.0)
    assert len(windowed) == 4


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

    sequence_id = client.post(
        f"/media/videos/{video_id}/sequences",
        json={"name": "Library video seq", "start_time": 0, "duration": 2},
        headers=headers,
    ).json()["id"]

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
    body = response.json()
    assert body["page"] == 1
    assert body["page_size"] == 25
    assert body["total"] >= 2
    items = body["items"]
    video_item = next(i for i in items if i["kind"] == "video" and i["filename"] == "library_video.mp4")
    assert video_item["linked_sequence_count"] == 1
    assert video_item["title"] == "Library video"
    # No annotations yet -- last_edited_at falls back to the sequence's own created_at.
    assert video_item["last_edited_at"] is not None

    photo_item = next(i for i in items if i["kind"] == "photo" and i["id"] == photo_sequence_id)
    assert photo_item["linked_sequence_count"] == 1
    assert photo_item["filename"] == "Library photo seq"
    assert photo_item["title"] is None
    assert photo_item["last_edited_at"] is not None

    # Now add an annotation to the video's sequence and confirm last_edited_at moves forward.
    before_last_edited = video_item["last_edited_at"]

    procedures = client.get("/taxonomy/procedures", headers=headers).json()
    procedure = next(p for p in procedures if p["id"] == procedure_id)
    categories = client.get(
        f"/taxonomy/categories?procedure_id={procedure['id']}", headers=headers
    ).json()
    category = next((c for c in categories if c["name"] == "last-edited-category"), None)
    if category is None:
        category = client.post(
            "/taxonomy/categories",
            json={"name": "last-edited-category", "procedure_id": procedure["id"]},
            headers=headers,
        ).json()
    evaluation_types = client.get("/taxonomy/evaluation-types", headers=headers).json()
    evaluation_type = next(
        (e for e in evaluation_types if e["name"] == "last-edited-evaluation-type"), None
    )
    if evaluation_type is None:
        evaluation_type = client.post(
            "/taxonomy/evaluation-types",
            json={"name": "last-edited-evaluation-type"},
            headers=headers,
        ).json()
    label_id = client.post(
        "/taxonomy/labels",
        json={
            "name": "last-edited-label",
            "category_id": category["id"],
            "evaluation_type_id": evaluation_type["id"],
        },
        headers=headers,
    ).json()["id"]

    frames = client.get(f"/media/sequences/{sequence_id}/frames", headers=headers).json()
    frame_id = frames[0]["id"]
    client.post(
        f"/annotation/frames/{frame_id}/annotations",
        json={"label_id": label_id},
        headers=headers,
    )

    response_after = client.get("/media/library", headers=headers)
    items_after = response_after.json()["items"]
    video_item_after = next(
        i for i in items_after if i["kind"] == "video" and i["filename"] == "library_video.mp4"
    )
    assert video_item_after["last_edited_at"] >= before_last_edited
    assert video_item_after["last_edited_at"] > video_item_after["uploaded_at"]


def test_media_library_search_matches_video_title_or_filename():
    headers = _auth_headers()
    procedure_id = client.post(
        "/taxonomy/procedures", json={"name": "Search procedure"}, headers=headers
    ).json()["id"]

    with open(FIXTURE_VIDEO, "rb") as f:
        client.post(
            "/media/videos",
            files={"file": ("zzz_unique_filename.mp4", f, "video/mp4")},
            data={"title": "Totally different title", "procedure_id": str(procedure_id)},
            headers=headers,
        )

    by_filename = client.get(
        "/media/library", params={"search": "zzz_unique_filename"}, headers=headers
    ).json()
    assert any(i["filename"] == "zzz_unique_filename.mp4" for i in by_filename["items"])

    by_title = client.get(
        "/media/library", params={"search": "totally different"}, headers=headers
    ).json()
    assert any(i["filename"] == "zzz_unique_filename.mp4" for i in by_title["items"])

    no_match = client.get(
        "/media/library", params={"search": "no-such-media-exists-anywhere"}, headers=headers
    ).json()
    assert no_match["items"] == []
    assert no_match["total"] == 0


def test_media_library_filters_by_type():
    headers = _auth_headers()
    procedure_id = client.post(
        "/taxonomy/procedures", json={"name": "Type filter procedure"}, headers=headers
    ).json()["id"]

    fixture = Path(__file__).parent / "fixtures" / "tiny_frame.png"
    with open(fixture, "rb") as f:
        image_bytes = f.read()
    client.post(
        "/media/sequences/photos",
        data={"name": "Type filter photo seq", "procedure_id": str(procedure_id)},
        files=[("files", ("p.png", image_bytes, "image/png"))],
        headers=headers,
    )

    photos_only = client.get("/media/library", params={"type": "photo"}, headers=headers).json()
    assert all(i["kind"] == "photo" for i in photos_only["items"])

    videos_only = client.get("/media/library", params={"type": "video"}, headers=headers).json()
    assert all(i["kind"] == "video" for i in videos_only["items"])


def test_media_library_filters_by_procedure_id():
    headers = _auth_headers()
    procedure_a = client.post(
        "/taxonomy/procedures", json={"name": "Procedure filter A"}, headers=headers
    ).json()["id"]
    procedure_b = client.post(
        "/taxonomy/procedures", json={"name": "Procedure filter B"}, headers=headers
    ).json()["id"]

    fixture = Path(__file__).parent / "fixtures" / "tiny_frame.png"
    with open(fixture, "rb") as f:
        image_bytes = f.read()
    client.post(
        "/media/sequences/photos",
        data={"name": "Procedure A photo seq", "procedure_id": str(procedure_a)},
        files=[("files", ("pa.png", image_bytes, "image/png"))],
        headers=headers,
    )
    with open(fixture, "rb") as f:
        image_bytes_b = f.read()
    client.post(
        "/media/sequences/photos",
        data={"name": "Procedure B photo seq", "procedure_id": str(procedure_b)},
        files=[("files", ("pb.png", image_bytes_b, "image/png"))],
        headers=headers,
    )

    filtered = client.get(
        "/media/library", params={"procedure_id": procedure_a}, headers=headers
    ).json()
    assert all(i["procedure_id"] == procedure_a for i in filtered["items"])
    assert any(i["filename"] == "Procedure A photo seq" for i in filtered["items"])
    assert not any(i["filename"] == "Procedure B photo seq" for i in filtered["items"])


def test_media_library_sorts_by_size_bytes_ascending():
    headers = _auth_headers()
    response = client.get(
        "/media/library", params={"sort": "size_bytes", "order": "asc"}, headers=headers
    )
    assert response.status_code == 200
    sizes = [i["size_bytes"] for i in response.json()["items"]]
    assert sizes == sorted(sizes)


def test_media_library_sorts_by_size_bytes_descending():
    headers = _auth_headers()
    response = client.get(
        "/media/library", params={"sort": "size_bytes", "order": "desc"}, headers=headers
    )
    assert response.status_code == 200
    sizes = [i["size_bytes"] for i in response.json()["items"]]
    assert sizes == sorted(sizes, reverse=True)


def test_media_library_paginates_results():
    headers = _auth_headers()
    procedure_id = client.post(
        "/taxonomy/procedures", json={"name": "Pagination procedure"}, headers=headers
    ).json()["id"]

    fixture = Path(__file__).parent / "fixtures" / "tiny_frame.png"
    for n in range(3):
        with open(fixture, "rb") as f:
            image_bytes = f.read()
        client.post(
            "/media/sequences/photos",
            data={"name": f"Pagination photo seq {n}", "procedure_id": str(procedure_id)},
            files=[("files", (f"p{n}.png", image_bytes, "image/png"))],
            headers=headers,
        )

    page_1 = client.get(
        "/media/library",
        params={"procedure_id": procedure_id, "page": 1, "page_size": 2},
        headers=headers,
    ).json()
    assert len(page_1["items"]) == 2
    assert page_1["total"] == 3
    assert page_1["page"] == 1

    page_2 = client.get(
        "/media/library",
        params={"procedure_id": procedure_id, "page": 2, "page_size": 2},
        headers=headers,
    ).json()
    assert len(page_2["items"]) == 1
    assert page_2["total"] == 3

    page_ids_1 = {i["id"] for i in page_1["items"]}
    page_ids_2 = {i["id"] for i in page_2["items"]}
    assert page_ids_1.isdisjoint(page_ids_2)


def test_delete_video_without_sequences_succeeds():
    headers = _auth_headers()
    procedure_id = client.post(
        "/taxonomy/procedures", json={"name": "deletable-video-procedure"}, headers=headers
    ).json()["id"]
    with open(FIXTURE_VIDEO, "rb") as f:
        video_id = client.post(
            "/media/videos",
            files={"file": ("deletable.mp4", f, "video/mp4")},
            data={"title": "Deletable video", "procedure_id": procedure_id},
            headers=headers,
        ).json()["id"]

    response = client.delete(f"/media/videos/{video_id}", headers=headers)

    assert response.status_code == 204
    assert client.get("/media/videos", headers=headers).json()
    assert video_id not in [v["id"] for v in client.get("/media/videos", headers=headers).json()]


def test_delete_video_with_linked_sequence_returns_409():
    headers = _auth_headers()
    procedure_id = client.post(
        "/taxonomy/procedures", json={"name": "linked-video-procedure"}, headers=headers
    ).json()["id"]
    with open(FIXTURE_VIDEO, "rb") as f:
        video_id = client.post(
            "/media/videos",
            files={"file": ("linked.mp4", f, "video/mp4")},
            data={"title": "Linked video", "procedure_id": procedure_id},
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


def test_delete_video_derived_sequence_succeeds():
    headers = _auth_headers()
    procedure_id = client.post(
        "/taxonomy/procedures", json={"name": "deletable-derived-seq-procedure"}, headers=headers
    ).json()["id"]
    with open(FIXTURE_VIDEO, "rb") as f:
        video_id = client.post(
            "/media/videos",
            files={"file": ("deletable_derived.mp4", f, "video/mp4")},
            data={"title": "Deletable derived", "procedure_id": procedure_id},
            headers=headers,
        ).json()["id"]
    sequence_id = client.post(
        f"/media/videos/{video_id}/sequences",
        json={"name": "Video-derived seq", "start_time": 0, "duration": 2},
        headers=headers,
    ).json()["id"]

    response = client.delete(f"/media/sequences/{sequence_id}", headers=headers)

    assert response.status_code == 204
    assert client.get(f"/media/sequences/{sequence_id}", headers=headers).status_code == 404


def test_delete_video_derived_sequence_with_annotations_returns_409():
    headers = _auth_headers()

    # Mirrors backend/tests/test_annotation.py's _create_label get-or-create
    # pattern: Procedure/Category/EvaluationType creation 500s on a unique-
    # constraint collision instead of returning a JSON error, so look each
    # up first rather than assuming a fresh POST will succeed.
    procedures = client.get("/taxonomy/procedures", headers=headers).json()
    procedure = next((p for p in procedures if p["name"] == "delete-guard-procedure"), None)
    if procedure is None:
        procedure = client.post(
            "/taxonomy/procedures", json={"name": "delete-guard-procedure"}, headers=headers
        ).json()

    categories = client.get(
        f"/taxonomy/categories?procedure_id={procedure['id']}", headers=headers
    ).json()
    category = next((c for c in categories if c["name"] == "delete-guard-category"), None)
    if category is None:
        category = client.post(
            "/taxonomy/categories",
            json={"name": "delete-guard-category", "procedure_id": procedure["id"]},
            headers=headers,
        ).json()

    evaluation_types = client.get("/taxonomy/evaluation-types", headers=headers).json()
    evaluation_type = next(
        (e for e in evaluation_types if e["name"] == "delete-guard-evaluation-type"), None
    )
    if evaluation_type is None:
        evaluation_type = client.post(
            "/taxonomy/evaluation-types", json={"name": "delete-guard-evaluation-type"}, headers=headers
        ).json()

    label_id = client.post(
        "/taxonomy/labels",
        json={
            "name": "Delete-guard label",
            "category_id": category["id"],
            "evaluation_type_id": evaluation_type["id"],
        },
        headers=headers,
    ).json()["id"]

    with open(FIXTURE_VIDEO, "rb") as f:
        video_id = client.post(
            "/media/videos",
            files={"file": ("not_deletable_annotated.mp4", f, "video/mp4")},
            data={"title": "Not deletable annotated", "procedure_id": procedure["id"]},
            headers=headers,
        ).json()["id"]
    sequence_id = client.post(
        f"/media/videos/{video_id}/sequences",
        json={"name": "Annotated video-derived seq", "start_time": 0, "duration": 2},
        headers=headers,
    ).json()["id"]
    frame_id = client.get(
        f"/media/sequences/{sequence_id}/frames", headers=headers
    ).json()[0]["id"]
    client.post(
        f"/annotation/frames/{frame_id}/annotations",
        json={"label_id": label_id},
        headers=headers,
    )

    response = client.delete(f"/media/sequences/{sequence_id}", headers=headers)

    assert response.status_code == 409


def test_video_model_has_codec_compatibility_columns():
    from app.media.models import Video

    video = Video(
        storage_key="videos/x.mp4",
        filename="x.mp4",
        title="t",
        fps=1.0,
        duration_seconds=1.0,
        size_bytes=10,
        checksum="abc",
        browser_playable=True,
        container="mov,mp4,m4a,3gp,3g2,mj2",
        video_codec="h264",
    )
    assert video.browser_playable is True
    assert video.container == "mov,mp4,m4a,3gp,3g2,mj2"
    assert video.video_codec == "h264"


def test_probe_codec_compatibility_accepts_h264_mp4():
    with open(FIXTURE_VIDEO_H264, "rb") as f:
        data = f.read()
    playable, container, codec = probe_codec_compatibility(data)
    assert playable is True
    assert codec == "h264"
    assert container is not None


def test_probe_codec_compatibility_rejects_mpeg4():
    with open(FIXTURE_VIDEO, "rb") as f:
        data = f.read()
    playable, container, codec = probe_codec_compatibility(data)
    assert playable is False
    assert codec == "mpeg4"


def test_probe_codec_compatibility_accepts_vp8_webm():
    with open(FIXTURE_VIDEO_VP8_WEBM, "rb") as f:
        data = f.read()
    playable, container, codec = probe_codec_compatibility(data)
    assert playable is True
    assert codec == "vp8"
    assert container == "matroska,webm"


def test_upload_video_computes_browser_playable_true_for_h264():
    headers = _auth_headers()
    procedure_id = client.post(
        "/taxonomy/procedures", json={"name": "h264-source-procedure"}, headers=headers
    ).json()["id"]
    with open(FIXTURE_VIDEO_H264, "rb") as f:
        response = client.post(
            "/media/videos",
            files={"file": ("tiny_h264.mp4", f, "video/mp4")},
            data={"title": "H264 source", "procedure_id": procedure_id},
            headers=headers,
        )
    assert response.status_code == 201
    body = response.json()
    assert body["browser_playable"] is True
    assert body["video_codec"] == "h264"


def test_upload_video_computes_browser_playable_false_for_mpeg4():
    headers = _auth_headers()
    procedure_id = client.post(
        "/taxonomy/procedures", json={"name": "mpeg4-source-procedure"}, headers=headers
    ).json()["id"]
    with open(FIXTURE_VIDEO, "rb") as f:
        response = client.post(
            "/media/videos",
            files={"file": ("tiny.mp4", f, "video/mp4")},
            data={"title": "MPEG4 source", "procedure_id": procedure_id},
            headers=headers,
        )
    assert response.status_code == 201
    body = response.json()
    assert body["browser_playable"] is False
    assert body["video_codec"] == "mpeg4"


def test_get_video_by_id_returns_full_record():
    headers = _auth_headers()
    procedure_id = client.post(
        "/taxonomy/procedures", json={"name": "fetch-me-procedure"}, headers=headers
    ).json()["id"]
    with open(FIXTURE_VIDEO_H264, "rb") as f:
        upload_response = client.post(
            "/media/videos",
            files={"file": ("tiny_h264.mp4", f, "video/mp4")},
            data={"title": "Fetch me", "procedure_id": procedure_id},
            headers=headers,
        )
    video_id = upload_response.json()["id"]

    response = client.get(f"/media/videos/{video_id}", headers=headers)
    assert response.status_code == 200
    assert response.json()["id"] == video_id
    assert response.json()["browser_playable"] is True
    assert response.json()["stream_url"].startswith("http")


def test_get_video_404_for_missing_video():
    headers = _auth_headers()
    response = client.get("/media/videos/999999999", headers=headers)
    assert response.status_code == 404


def test_transcode_video_creates_job():
    headers = _auth_headers()
    procedure_id = client.post(
        "/taxonomy/procedures", json={"name": "needs-transcode-procedure"}, headers=headers
    ).json()["id"]
    with open(FIXTURE_VIDEO, "rb") as f:  # tiny.mp4 -- mpeg4, not playable
        upload_response = client.post(
            "/media/videos",
            files={"file": ("tiny.mp4", f, "video/mp4")},
            data={"title": "Needs transcode", "procedure_id": procedure_id},
            headers=headers,
        )
    video_id = upload_response.json()["id"]

    response = client.post(f"/media/videos/{video_id}/transcode", headers=headers)
    assert response.status_code == 201
    body = response.json()
    assert body["job_type"] == "video_transcode"
    assert body["status"] == "pending"


def test_transcode_video_404_for_missing_video():
    headers = _auth_headers()
    response = client.post("/media/videos/999999999/transcode", headers=headers)
    assert response.status_code == 404


def test_transcode_video_409_when_already_playable():
    headers = _auth_headers()
    procedure_id = client.post(
        "/taxonomy/procedures", json={"name": "already-fine-procedure"}, headers=headers
    ).json()["id"]
    with open(FIXTURE_VIDEO_H264, "rb") as f:  # already h264
        upload_response = client.post(
            "/media/videos",
            files={"file": ("tiny_h264.mp4", f, "video/mp4")},
            data={"title": "Already fine", "procedure_id": procedure_id},
            headers=headers,
        )
    video_id = upload_response.json()["id"]

    response = client.post(f"/media/videos/{video_id}/transcode", headers=headers)
    assert response.status_code == 409


def test_transcode_video_409_when_already_pending():
    headers = _auth_headers()
    procedure_id = client.post(
        "/taxonomy/procedures", json={"name": "double-transcode-procedure"}, headers=headers
    ).json()["id"]
    with open(FIXTURE_VIDEO, "rb") as f:
        upload_response = client.post(
            "/media/videos",
            files={"file": ("tiny.mp4", f, "video/mp4")},
            data={"title": "Double transcode", "procedure_id": procedure_id},
            headers=headers,
        )
    video_id = upload_response.json()["id"]

    first = client.post(f"/media/videos/{video_id}/transcode", headers=headers)
    assert first.status_code == 201

    second = client.post(f"/media/videos/{video_id}/transcode", headers=headers)
    assert second.status_code == 409


def test_get_sequence_reports_zero_annotation_count_when_none_exist():
    headers = _auth_headers()
    procedure_id = client.post(
        "/taxonomy/procedures", json={"name": "annotation-count-source-procedure"}, headers=headers
    ).json()["id"]
    with open(FIXTURE_VIDEO, "rb") as f:
        upload_response = client.post(
            "/media/videos",
            files={"file": ("tiny.mp4", f, "video/mp4")},
            data={"title": "annotation count source", "procedure_id": procedure_id},
            headers=headers,
        )
    video_id = upload_response.json()["id"]
    sequence_response = client.post(
        f"/media/videos/{video_id}/sequences",
        json={"name": "count test sequence", "start_time": 0, "duration": 2},
        headers=headers,
    )
    sequence_id = sequence_response.json()["id"]

    response = client.get(f"/media/sequences/{sequence_id}", headers=headers)
    assert response.status_code == 200
    assert response.json()["annotation_count"] == 0


def test_get_sequence_reports_actual_annotation_count():
    headers = _auth_headers()
    procedure_id_for_video = client.post(
        "/taxonomy/procedures", json={"name": "annotation-count-source-2-procedure"}, headers=headers
    ).json()["id"]
    with open(FIXTURE_VIDEO, "rb") as f:
        upload_response = client.post(
            "/media/videos",
            files={"file": ("tiny.mp4", f, "video/mp4")},
            data={"title": "annotation count source 2", "procedure_id": procedure_id_for_video},
            headers=headers,
        )
    video_id = upload_response.json()["id"]
    sequence_response = client.post(
        f"/media/videos/{video_id}/sequences",
        json={"name": "count test sequence 2", "start_time": 0, "duration": 2},
        headers=headers,
    )
    sequence_id = sequence_response.json()["id"]
    frame_id = client.get(
        f"/media/sequences/{sequence_id}/frames", headers=headers
    ).json()[0]["id"]

    procedures = client.get("/taxonomy/procedures", headers=headers).json()
    procedure = next((p for p in procedures if p["name"] == "seq-count-procedure"), None)
    if procedure is None:
        procedure = client.post(
            "/taxonomy/procedures", json={"name": "seq-count-procedure"}, headers=headers
        ).json()
    categories = client.get(
        f"/taxonomy/categories?procedure_id={procedure['id']}", headers=headers
    ).json()
    category = next((c for c in categories if c["name"] == "seq-count-category"), None)
    if category is None:
        category = client.post(
            "/taxonomy/categories",
            json={"name": "seq-count-category", "procedure_id": procedure["id"]},
            headers=headers,
        ).json()
    evaluation_types = client.get("/taxonomy/evaluation-types", headers=headers).json()
    evaluation_type = next(
        (e for e in evaluation_types if e["name"] == "seq-count-evaluation-type"), None
    )
    if evaluation_type is None:
        evaluation_type = client.post(
            "/taxonomy/evaluation-types",
            json={"name": "seq-count-evaluation-type"},
            headers=headers,
        ).json()
    label_id = client.post(
        "/taxonomy/labels",
        json={
            "name": "seq-count-label",
            "category_id": category["id"],
            "evaluation_type_id": evaluation_type["id"],
        },
        headers=headers,
    ).json()["id"]

    client.post(
        f"/annotation/frames/{frame_id}/annotations",
        json={"label_id": label_id},
        headers=headers,
    )

    response = client.get(f"/media/sequences/{sequence_id}", headers=headers)
    assert response.status_code == 200
    assert response.json()["annotation_count"] == 1


def test_sequence_stats_reports_zero_for_empty_sequence():
    headers = _auth_headers()
    procedure_id = client.post(
        "/taxonomy/procedures", json={"name": "stats-empty-procedure"}, headers=headers
    ).json()["id"]
    sequence_id = client.post(
        "/media/sequences",
        json={"procedure_id": procedure_id, "name": "stats empty sequence"},
        headers=headers,
    ).json()["id"]

    response = client.get(f"/media/sequences/{sequence_id}/stats", headers=headers)

    assert response.status_code == 200
    body = response.json()
    assert body["frame_count"] == 0
    assert body["frame_width"] is None
    assert body["frame_height"] is None
    assert body["labels"] == []


def test_sequence_stats_reports_frame_count_and_resolution_from_first_frame():
    headers = _auth_headers()
    procedure_id = client.post(
        "/taxonomy/procedures", json={"name": "stats-resolution-procedure"}, headers=headers
    ).json()["id"]
    with open(FIXTURE_VIDEO, "rb") as f:
        video_id = client.post(
            "/media/videos", files={"file": ("tiny.mp4", f, "video/mp4")},
            data={"title": "stats resolution source", "procedure_id": procedure_id}, headers=headers,
        ).json()["id"]
    sequence_id = client.post(
        f"/media/videos/{video_id}/sequences",
        json={"name": "stats resolution sequence", "start_time": 0, "duration": 2},
        headers=headers,
    ).json()["id"]
    frames = client.get(f"/media/sequences/{sequence_id}/frames", headers=headers).json()

    response = client.get(f"/media/sequences/{sequence_id}/stats", headers=headers)

    assert response.status_code == 200
    body = response.json()
    assert body["frame_count"] == len(frames)
    first_frame = min(frames, key=lambda f: f["frame_index"])
    assert body["frame_width"] == first_frame["width"]
    assert body["frame_height"] == first_frame["height"]


def test_sequence_stats_groups_annotations_by_label_across_types():
    headers = _auth_headers()
    video_procedure_id = client.post(
        "/taxonomy/procedures", json={"name": "stats-label-source-procedure"}, headers=headers
    ).json()["id"]
    with open(FIXTURE_VIDEO, "rb") as f:
        video_id = client.post(
            "/media/videos", files={"file": ("tiny.mp4", f, "video/mp4")},
            data={"title": "stats label source", "procedure_id": video_procedure_id}, headers=headers,
        ).json()["id"]
    sequence_id = client.post(
        f"/media/videos/{video_id}/sequences",
        json={"name": "stats label sequence", "start_time": 0, "duration": 2},
        headers=headers,
    ).json()["id"]
    frame_ids = [
        f["id"]
        for f in client.get(f"/media/sequences/{sequence_id}/frames", headers=headers).json()
    ]
    assert len(frame_ids) >= 2, "fixture must yield at least 2 frames for this test"

    procedures = client.get("/taxonomy/procedures", headers=headers).json()
    procedure = next((p for p in procedures if p["name"] == "stats-label-procedure"), None)
    if procedure is None:
        procedure = client.post(
            "/taxonomy/procedures", json={"name": "stats-label-procedure"}, headers=headers
        ).json()
    categories = client.get(
        f"/taxonomy/categories?procedure_id={procedure['id']}", headers=headers
    ).json()
    category = next((c for c in categories if c["name"] == "stats-label-category"), None)
    if category is None:
        category = client.post(
            "/taxonomy/categories",
            json={"name": "stats-label-category", "procedure_id": procedure["id"]},
            headers=headers,
        ).json()
    evaluation_types = client.get("/taxonomy/evaluation-types", headers=headers).json()
    evaluation_type = next(
        (e for e in evaluation_types if e["name"] == "stats-label-evaluation-type"), None
    )
    if evaluation_type is None:
        evaluation_type = client.post(
            "/taxonomy/evaluation-types",
            json={"name": "stats-label-evaluation-type"},
            headers=headers,
        ).json()

    def _get_or_create_label(name: str) -> int:
        # Labels have no list-by-name lookup endpoint, so create and rely on
        # this test's unique name to avoid needing a search.
        return client.post(
            "/taxonomy/labels",
            json={
                "name": name,
                "category_id": category["id"],
                "evaluation_type_id": evaluation_type["id"],
            },
            headers=headers,
        ).json()["id"]

    polyp_label_id = _get_or_create_label("stats-test-polyp")
    blood_label_id = _get_or_create_label("stats-test-blood")

    # Two annotations on "polyp" (across two different frames), one on "blood".
    client.post(
        f"/annotation/frames/{frame_ids[0]}/annotations",
        json={"label_id": polyp_label_id},
        headers=headers,
    )
    client.post(
        f"/annotation/frames/{frame_ids[1]}/annotations",
        json={"label_id": polyp_label_id},
        headers=headers,
    )
    client.post(
        f"/annotation/frames/{frame_ids[0]}/annotations",
        json={"label_id": blood_label_id},
        headers=headers,
    )

    response = client.get(f"/media/sequences/{sequence_id}/stats", headers=headers)

    assert response.status_code == 200
    labels_by_name = {entry["label_name"]: entry["count"] for entry in response.json()["labels"]}
    assert labels_by_name["stats-test-polyp"] == 2
    assert labels_by_name["stats-test-blood"] == 1


def test_sequence_stats_404_for_missing_sequence():
    headers = _auth_headers()
    response = client.get("/media/sequences/999999999/stats", headers=headers)
    assert response.status_code == 404


def test_patch_sequence_rename_updates_name_and_procedure():
    headers = _auth_headers()
    procedure_id = client.post(
        "/taxonomy/procedures", json={"name": "patch-rename-procedure"}, headers=headers
    ).json()["id"]
    with open(FIXTURE_VIDEO, "rb") as f:
        video_id = client.post(
            "/media/videos", files={"file": ("tiny.mp4", f, "video/mp4")},
            data={"title": "patch rename source", "procedure_id": procedure_id}, headers=headers,
        ).json()["id"]
    sequence_id = client.post(
        f"/media/videos/{video_id}/sequences",
        json={"name": "before rename", "start_time": 0, "duration": 2},
        headers=headers,
    ).json()["id"]

    response = client.patch(
        f"/media/sequences/{sequence_id}",
        json={"name": "after rename", "procedure_id": procedure_id},
        headers=headers,
    )

    assert response.status_code == 200
    body = response.json()
    assert body["name"] == "after rename"
    assert body["procedure_id"] == procedure_id
    assert body["start_time"] == 0
    assert body["duration"] == 2


def test_patch_sequence_rename_leaves_frames_untouched():
    headers = _auth_headers()
    procedure_id = client.post(
        "/taxonomy/procedures", json={"name": "patch-rename-frames-procedure"}, headers=headers
    ).json()["id"]
    with open(FIXTURE_VIDEO, "rb") as f:
        video_id = client.post(
            "/media/videos", files={"file": ("tiny.mp4", f, "video/mp4")},
            data={"title": "patch rename frames source", "procedure_id": procedure_id}, headers=headers,
        ).json()["id"]
    sequence_id = client.post(
        f"/media/videos/{video_id}/sequences",
        json={"name": "rename frames test", "start_time": 0, "duration": 2},
        headers=headers,
    ).json()["id"]
    frames_before = client.get(f"/media/sequences/{sequence_id}/frames", headers=headers).json()

    response = client.patch(f"/media/sequences/{sequence_id}", json={"name": "renamed"}, headers=headers)
    assert response.status_code == 200

    frames_after = client.get(f"/media/sequences/{sequence_id}/frames", headers=headers).json()
    assert [f["id"] for f in frames_before] == [f["id"] for f in frames_after]


def test_patch_sequence_recut_replaces_frames():
    headers = _auth_headers()
    procedure_id = client.post(
        "/taxonomy/procedures", json={"name": "patch-recut-procedure"}, headers=headers
    ).json()["id"]
    with open(FIXTURE_VIDEO, "rb") as f:
        video_id = client.post(
            "/media/videos", files={"file": ("tiny.mp4", f, "video/mp4")},
            data={"title": "patch recut source", "procedure_id": procedure_id}, headers=headers,
        ).json()["id"]
    sequence_id = client.post(
        f"/media/videos/{video_id}/sequences",
        json={"name": "recut test", "start_time": 0, "duration": 2, "fps": 1.0},
        headers=headers,
    ).json()["id"]
    frames_before = client.get(f"/media/sequences/{sequence_id}/frames", headers=headers).json()

    response = client.patch(
        f"/media/sequences/{sequence_id}",
        json={"start_time": 0, "duration": 2, "fps": 2.0},
        headers=headers,
    )

    assert response.status_code == 200
    frames_after = client.get(f"/media/sequences/{sequence_id}/frames", headers=headers).json()
    assert [f["id"] for f in frames_before] != [f["id"] for f in frames_after]
    assert len(frames_after) >= len(frames_before)


def test_patch_sequence_recut_with_crop_persists_it():
    headers = _auth_headers()
    procedure_id = client.post(
        "/taxonomy/procedures", json={"name": "patch-recut-crop-procedure"}, headers=headers
    ).json()["id"]
    with open(FIXTURE_VIDEO, "rb") as f:
        video_id = client.post(
            "/media/videos", files={"file": ("tiny.mp4", f, "video/mp4")},
            data={"title": "patch recut crop source", "procedure_id": procedure_id}, headers=headers,
        ).json()["id"]
    sequence_id = client.post(
        f"/media/videos/{video_id}/sequences",
        json={"name": "recut crop test", "start_time": 0, "duration": 2, "fps": 1.0},
        headers=headers,
    ).json()["id"]

    response = client.patch(
        f"/media/sequences/{sequence_id}",
        json={
            "start_time": 0, "duration": 2, "fps": 1.0,
            "crop": {"left": 10, "right": 10, "top": 5, "bottom": 5},
        },
        headers=headers,
    )

    assert response.status_code == 200
    assert response.json()["crop_box"] == {"left": 10.0, "right": 10.0, "top": 5.0, "bottom": 5.0}


def test_patch_sequence_recut_without_crop_keeps_existing_crop_box():
    headers = _auth_headers()
    procedure_id = client.post(
        "/taxonomy/procedures", json={"name": "patch-recut-no-crop-procedure"}, headers=headers
    ).json()["id"]
    with open(FIXTURE_VIDEO, "rb") as f:
        video_id = client.post(
            "/media/videos", files={"file": ("tiny.mp4", f, "video/mp4")},
            data={"title": "patch recut no-crop source", "procedure_id": procedure_id}, headers=headers,
        ).json()["id"]
    sequence_id = client.post(
        f"/media/videos/{video_id}/sequences",
        json={
            "name": "recut no-crop test", "start_time": 0, "duration": 2, "fps": 1.0,
            "crop": {"left": 15, "right": 15, "top": 8, "bottom": 8},
        },
        headers=headers,
    ).json()["id"]

    response = client.patch(
        f"/media/sequences/{sequence_id}",
        json={"start_time": 0, "duration": 2, "fps": 2.0},
        headers=headers,
    )

    assert response.status_code == 200
    assert response.json()["crop_box"] == {"left": 15.0, "right": 15.0, "top": 8.0, "bottom": 8.0}


def test_patch_sequence_recut_on_standalone_sequence_returns_404():
    headers = _auth_headers()
    procedure_id = client.post(
        "/taxonomy/procedures", json={"name": "patch-standalone-procedure"}, headers=headers
    ).json()["id"]
    sequence_id = client.post(
        "/media/sequences",
        json={"name": "standalone", "procedure_id": procedure_id},
        headers=headers,
    ).json()["id"]

    response = client.patch(
        f"/media/sequences/{sequence_id}",
        json={"start_time": 0, "duration": 1, "fps": 1.0},
        headers=headers,
    )

    assert response.status_code == 404


def test_patch_sequence_recut_with_out_of_bounds_range_returns_422():
    headers = _auth_headers()
    procedure_id = client.post(
        "/taxonomy/procedures", json={"name": "patch-recut-oob-procedure"}, headers=headers
    ).json()["id"]
    with open(FIXTURE_VIDEO, "rb") as f:
        video_id = client.post(
            "/media/videos", files={"file": ("tiny.mp4", f, "video/mp4")},
            data={"title": "patch recut oob source", "procedure_id": procedure_id}, headers=headers,
        ).json()["id"]
    video_duration = client.get(f"/media/videos/{video_id}", headers=headers).json()["duration_seconds"]
    sequence_id = client.post(
        f"/media/videos/{video_id}/sequences",
        json={"name": "oob recut test", "start_time": 0, "duration": 2},
        headers=headers,
    ).json()["id"]

    response = client.patch(
        f"/media/sequences/{sequence_id}",
        json={"start_time": 0, "duration": int(video_duration) + 100, "fps": 1.0},
        headers=headers,
    )

    assert response.status_code == 422


def test_patch_sequence_404_for_missing_sequence():
    headers = _auth_headers()
    response = client.patch(
        "/media/sequences/999999999", json={"name": "x"}, headers=headers
    )
    assert response.status_code == 404


def test_patch_sequence_recut_with_zero_fps_returns_422():
    headers = _auth_headers()
    procedure_id = client.post(
        "/taxonomy/procedures", json={"name": "recut-zero-fps-procedure"}, headers=headers
    ).json()["id"]
    with open(FIXTURE_VIDEO, "rb") as f:
        video_id = client.post(
            "/media/videos", files={"file": ("tiny.mp4", f, "video/mp4")},
            data={"title": "patch recut zero fps source", "procedure_id": procedure_id}, headers=headers,
        ).json()["id"]
    sequence_id = client.post(
        f"/media/videos/{video_id}/sequences",
        json={"name": "zero fps recut test", "start_time": 0, "duration": 2},
        headers=headers,
    ).json()["id"]

    response = client.patch(
        f"/media/sequences/{sequence_id}",
        json={"start_time": 0, "duration": 1, "fps": 0},
        headers=headers,
    )

    assert response.status_code == 422


def _create_label_for_delete_tests(headers: dict[str, str], suffix: str) -> int:
    # Mirrors test_delete_video_derived_sequence_with_annotations_returns_409's
    # get-or-create pattern: Procedure/Category/EvaluationType creation 500s
    # on a unique-constraint collision instead of returning a JSON error, so
    # look each up first rather than assuming a fresh POST will succeed.
    procedures = client.get("/taxonomy/procedures", headers=headers).json()
    procedure = next((p for p in procedures if p["name"] == f"frame-delete-procedure-{suffix}"), None)
    if procedure is None:
        procedure = client.post(
            "/taxonomy/procedures", json={"name": f"frame-delete-procedure-{suffix}"}, headers=headers
        ).json()

    categories = client.get(f"/taxonomy/categories?procedure_id={procedure['id']}", headers=headers).json()
    category = next((c for c in categories if c["name"] == f"frame-delete-category-{suffix}"), None)
    if category is None:
        category = client.post(
            "/taxonomy/categories",
            json={"name": f"frame-delete-category-{suffix}", "procedure_id": procedure["id"]},
            headers=headers,
        ).json()

    evaluation_types = client.get("/taxonomy/evaluation-types", headers=headers).json()
    evaluation_type = next(
        (e for e in evaluation_types if e["name"] == f"frame-delete-evaluation-type-{suffix}"), None
    )
    if evaluation_type is None:
        evaluation_type = client.post(
            "/taxonomy/evaluation-types", json={"name": f"frame-delete-evaluation-type-{suffix}"}, headers=headers
        ).json()

    return client.post(
        "/taxonomy/labels",
        json={
            "name": f"Frame-delete label {suffix}",
            "category_id": category["id"],
            "evaluation_type_id": evaluation_type["id"],
        },
        headers=headers,
    ).json()["id"]


def test_bulk_delete_frame_removes_frame_and_cascades_mask_annotation():
    headers = _auth_headers()
    procedure_id = client.post(
        "/taxonomy/procedures", json={"name": "bulk-delete-frame-procedure"}, headers=headers
    ).json()["id"]
    with open(FIXTURE_VIDEO, "rb") as f:
        video_id = client.post(
            "/media/videos",
            files={"file": ("bulk_delete.mp4", f, "video/mp4")},
            data={"title": "Bulk delete source", "procedure_id": procedure_id},
            headers=headers,
        ).json()["id"]
    sequence_id = client.post(
        f"/media/videos/{video_id}/sequences",
        json={"name": "Bulk delete seq", "start_time": 0, "duration": 2},
        headers=headers,
    ).json()["id"]
    frame_id = client.get(f"/media/sequences/{sequence_id}/frames", headers=headers).json()[0]["id"]
    label_id = _create_label_for_delete_tests(headers, "mask-cascade")

    # The API can only create CLASSIFICATION-type annotations (no storage_key
    # / mask file) -- create_classification_annotation in
    # app/annotation/service.py always sets storage_key=None. To exercise
    # the mask-file cleanup path this endpoint must perform, build a MASK
    # annotation with a real uploaded storage object directly via the ORM,
    # mirroring test_sequence_can_be_created_without_a_video's direct-session
    # pattern for state the HTTP API cannot produce.
    from app.annotation.models import Annotation, AnnotationType
    from app.db import SessionLocal
    from app.storage import get_storage_service

    storage = get_storage_service()
    mask_key = f"masks/test/{frame_id}-bulk-delete.png"
    storage.upload(mask_key, b"fake-mask-bytes", "image/png")

    session = SessionLocal()
    try:
        user_id = session.execute(
            __import__("sqlalchemy").text("SELECT id FROM users WHERE email = :email"),
            {"email": "media1@example.com"},
        ).scalar_one()
        annotation = Annotation(
            frame_id=frame_id,
            label_id=label_id,
            taxonomy_version=1,
            annotation_type=AnnotationType.MASK,
            payload={},
            storage_key=mask_key,
            created_by_id=user_id,
        )
        session.add(annotation)
        session.commit()
        annotation_id = annotation.id
    finally:
        session.close()

    response = client.request(
        "DELETE",
        f"/media/sequences/{sequence_id}/frames",
        json={"frame_ids": [frame_id]},
        headers=headers,
    )

    assert response.status_code == 200
    assert response.json() == {"deleted_ids": [frame_id]}

    # Frame gone
    assert client.get(f"/media/frames/{frame_id}", headers=headers).status_code == 404

    # Annotation row gone
    session = SessionLocal()
    try:
        assert session.get(Annotation, annotation_id) is None
    finally:
        session.close()

    # Mask storage object gone
    import pytest
    from botocore.exceptions import ClientError

    with pytest.raises(ClientError):
        storage.download(mask_key)


def test_bulk_delete_frames_silently_skips_nonexistent_and_foreign_ids():
    headers = _auth_headers()
    procedure_id = client.post(
        "/taxonomy/procedures", json={"name": "bulk-delete-skip-procedure"}, headers=headers
    ).json()["id"]
    with open(FIXTURE_VIDEO, "rb") as f:
        video_id = client.post(
            "/media/videos",
            files={"file": ("bulk_delete_skip.mp4", f, "video/mp4")},
            data={"title": "Bulk delete skip source", "procedure_id": procedure_id},
            headers=headers,
        ).json()["id"]
    sequence_a = client.post(
        f"/media/videos/{video_id}/sequences",
        json={"name": "Skip seq A", "start_time": 0, "duration": 2},
        headers=headers,
    ).json()["id"]
    sequence_b = client.post(
        f"/media/videos/{video_id}/sequences",
        json={"name": "Skip seq B", "start_time": 0, "duration": 2},
        headers=headers,
    ).json()["id"]
    frame_a_id = client.get(f"/media/sequences/{sequence_a}/frames", headers=headers).json()[0]["id"]
    frame_b_id = client.get(f"/media/sequences/{sequence_b}/frames", headers=headers).json()[0]["id"]

    response = client.request(
        "DELETE",
        f"/media/sequences/{sequence_a}/frames",
        json={"frame_ids": [frame_a_id, frame_b_id, 999999999]},
        headers=headers,
    )

    assert response.status_code == 200
    assert response.json() == {"deleted_ids": [frame_a_id]}
    # frame_b (different sequence) survives
    assert client.get(f"/media/frames/{frame_b_id}", headers=headers).status_code == 200


def test_bulk_delete_frame_with_no_annotations_succeeds():
    headers = _auth_headers()
    procedure_id = client.post(
        "/taxonomy/procedures", json={"name": "bulk-delete-no-annotation-procedure"}, headers=headers
    ).json()["id"]
    with open(FIXTURE_VIDEO, "rb") as f:
        video_id = client.post(
            "/media/videos",
            files={"file": ("bulk_delete_no_annotation.mp4", f, "video/mp4")},
            data={"title": "Bulk delete no-annotation source", "procedure_id": procedure_id},
            headers=headers,
        ).json()["id"]
    sequence_id = client.post(
        f"/media/videos/{video_id}/sequences",
        json={"name": "No-annotation seq", "start_time": 0, "duration": 2},
        headers=headers,
    ).json()["id"]
    frame_id = client.get(f"/media/sequences/{sequence_id}/frames", headers=headers).json()[0]["id"]

    response = client.request(
        "DELETE",
        f"/media/sequences/{sequence_id}/frames",
        json={"frame_ids": [frame_id]},
        headers=headers,
    )

    assert response.status_code == 200
    assert response.json() == {"deleted_ids": [frame_id]}


def test_rank_quality_creates_job():
    headers = _auth_headers()
    procedure_id = client.post(
        "/taxonomy/procedures", json={"name": "rank-quality-procedure"}, headers=headers
    ).json()["id"]
    fixture = Path(__file__).parent / "fixtures" / "tiny_frame.png"
    with open(fixture, "rb") as f:
        image_bytes = f.read()
    sequence_id = client.post(
        "/media/sequences/photos",
        data={"name": "Rank quality seq", "procedure_id": str(procedure_id)},
        files=[("files", ("a.png", image_bytes, "image/png"))],
        headers=headers,
    ).json()["id"]

    response = client.post(
        f"/media/sequences/{sequence_id}/rank-quality", json={"percent": 20}, headers=headers
    )
    assert response.status_code == 201
    body = response.json()
    assert body["job_type"] == "rank_quality"
    assert body["status"] == "pending"


def test_rank_quality_404_for_missing_sequence():
    headers = _auth_headers()
    response = client.post(
        "/media/sequences/999999999/rank-quality", json={"percent": 20}, headers=headers
    )
    assert response.status_code == 404


def test_rank_quality_409_when_already_pending():
    headers = _auth_headers()
    procedure_id = client.post(
        "/taxonomy/procedures", json={"name": "rank-quality-double-procedure"}, headers=headers
    ).json()["id"]
    fixture = Path(__file__).parent / "fixtures" / "tiny_frame.png"
    with open(fixture, "rb") as f:
        image_bytes = f.read()
    sequence_id = client.post(
        "/media/sequences/photos",
        data={"name": "Rank quality double seq", "procedure_id": str(procedure_id)},
        files=[("files", ("a.png", image_bytes, "image/png"))],
        headers=headers,
    ).json()["id"]

    first = client.post(
        f"/media/sequences/{sequence_id}/rank-quality", json={"percent": 20}, headers=headers
    )
    assert first.status_code == 201

    second = client.post(
        f"/media/sequences/{sequence_id}/rank-quality", json={"percent": 20}, headers=headers
    )
    assert second.status_code == 409


def test_find_similar_creates_job():
    headers = _auth_headers()
    procedure_id = client.post(
        "/taxonomy/procedures", json={"name": "find-similar-procedure"}, headers=headers
    ).json()["id"]
    fixture = Path(__file__).parent / "fixtures" / "tiny_frame.png"
    with open(fixture, "rb") as f:
        image_bytes = f.read()
    sequence_id = client.post(
        "/media/sequences/photos",
        data={"name": "Find similar seq", "procedure_id": str(procedure_id)},
        files=[("files", ("a.png", image_bytes, "image/png"))],
        headers=headers,
    ).json()["id"]

    response = client.post(
        f"/media/sequences/{sequence_id}/find-similar", json={"percent": 85}, headers=headers
    )
    assert response.status_code == 201
    body = response.json()
    assert body["job_type"] == "find_similar"
    assert body["status"] == "pending"


def test_find_similar_404_for_missing_sequence():
    headers = _auth_headers()
    response = client.post(
        "/media/sequences/999999999/find-similar", json={"percent": 85}, headers=headers
    )
    assert response.status_code == 404


def test_find_similar_409_when_already_pending():
    headers = _auth_headers()
    procedure_id = client.post(
        "/taxonomy/procedures", json={"name": "find-similar-double-procedure"}, headers=headers
    ).json()["id"]
    fixture = Path(__file__).parent / "fixtures" / "tiny_frame.png"
    with open(fixture, "rb") as f:
        image_bytes = f.read()
    sequence_id = client.post(
        "/media/sequences/photos",
        data={"name": "Find similar double seq", "procedure_id": str(procedure_id)},
        files=[("files", ("a.png", image_bytes, "image/png"))],
        headers=headers,
    ).json()["id"]

    first = client.post(
        f"/media/sequences/{sequence_id}/find-similar", json={"percent": 85}, headers=headers
    )
    assert first.status_code == 201

    second = client.post(
        f"/media/sequences/{sequence_id}/find-similar", json={"percent": 85}, headers=headers
    )
    assert second.status_code == 409


def _create_labeled_photo_sequence(headers: dict[str, str], name: str, procedure_id: int) -> tuple[int, int]:
    """Create a 1-frame photo sequence and return (sequence_id, frame_id)."""
    fixture = Path(__file__).parent / "fixtures" / "tiny_frame.png"
    with open(fixture, "rb") as f:
        image_bytes = f.read()
    sequence_id = client.post(
        "/media/sequences/photos",
        data={"name": name, "procedure_id": str(procedure_id)},
        files=[("files", ("p.png", image_bytes, "image/png"))],
        headers=headers,
    ).json()["id"]
    frame_id = client.get(f"/media/sequences/{sequence_id}/frames", headers=headers).json()[0]["id"]
    return sequence_id, frame_id


def _make_label(headers: dict[str, str], procedure_id: int, name: str) -> int:
    categories = client.get(f"/taxonomy/categories?procedure_id={procedure_id}", headers=headers).json()
    category = next((c for c in categories if c["name"] == f"{name}-category"), None)
    if category is None:
        category = client.post(
            "/taxonomy/categories",
            json={"name": f"{name}-category", "procedure_id": procedure_id},
            headers=headers,
        ).json()
    evaluation_types = client.get("/taxonomy/evaluation-types", headers=headers).json()
    evaluation_type = next((e for e in evaluation_types if e["name"] == f"{name}-eval-type"), None)
    if evaluation_type is None:
        evaluation_type = client.post(
            "/taxonomy/evaluation-types", json={"name": f"{name}-eval-type"}, headers=headers
        ).json()
    return client.post(
        "/taxonomy/labels",
        json={"name": name, "category_id": category["id"], "evaluation_type_id": evaluation_type["id"]},
        headers=headers,
    ).json()["id"]


def test_list_sequences_returns_paginated_page():
    headers = _auth_headers()
    procedure_id = client.post(
        "/taxonomy/procedures", json={"name": "list-sequences-procedure"}, headers=headers
    ).json()["id"]
    _create_labeled_photo_sequence(headers, "list-sequences-seq-a", procedure_id)
    _create_labeled_photo_sequence(headers, "list-sequences-seq-b", procedure_id)

    response = client.get(
        "/media/sequences", params={"procedure_id": procedure_id, "page": 1, "page_size": 1}, headers=headers
    )

    assert response.status_code == 200
    body = response.json()
    assert body["page"] == 1
    assert body["page_size"] == 1
    assert body["total"] == 2
    assert len(body["items"]) == 1


def test_list_sequences_reports_labeled_frame_count_for_mask_annotation():
    headers = _auth_headers()
    procedure_id = client.post(
        "/taxonomy/procedures", json={"name": "list-sequences-mask-procedure"}, headers=headers
    ).json()["id"]
    sequence_id, frame_id = _create_labeled_photo_sequence(
        headers, "list-sequences-mask-seq", procedure_id
    )
    label_id = _make_label(headers, procedure_id, "list-sequences-mask-label")

    client.post(f"/annotation/frames/{frame_id}/annotations", json={"label_id": label_id}, headers=headers)

    response = client.get("/media/sequences", params={"procedure_id": procedure_id}, headers=headers)
    item = next(i for i in response.json()["items"] if i["id"] == sequence_id)
    assert item["frame_count"] == 1
    assert item["labeled_frame_count"] == 1


def test_list_sequences_reports_labeled_frame_count_for_classification_only():
    headers = _auth_headers()
    procedure_id = client.post(
        "/taxonomy/procedures", json={"name": "list-sequences-classify-procedure"}, headers=headers
    ).json()["id"]
    sequence_id, frame_id = _create_labeled_photo_sequence(
        headers, "list-sequences-classify-seq", procedure_id
    )
    label_id = _make_label(headers, procedure_id, "list-sequences-classify-label")

    client.post(
        "/annotation/frames/bulk-classify",
        json={"frame_ids": [frame_id], "label_id": label_id},
        headers=headers,
    )

    response = client.get("/media/sequences", params={"procedure_id": procedure_id}, headers=headers)
    item = next(i for i in response.json()["items"] if i["id"] == sequence_id)
    assert item["labeled_frame_count"] == 1


def test_list_sequences_filters_by_labeled_status():
    headers = _auth_headers()
    procedure_id = client.post(
        "/taxonomy/procedures", json={"name": "list-sequences-filter-procedure"}, headers=headers
    ).json()["id"]
    labeled_id, frame_id = _create_labeled_photo_sequence(
        headers, "list-sequences-filter-labeled", procedure_id
    )
    unlabeled_id, _ = _create_labeled_photo_sequence(
        headers, "list-sequences-filter-unlabeled", procedure_id
    )
    label_id = _make_label(headers, procedure_id, "list-sequences-filter-label")
    client.post(f"/annotation/frames/{frame_id}/annotations", json={"label_id": label_id}, headers=headers)

    labeled_only = client.get(
        "/media/sequences",
        params={"procedure_id": procedure_id, "labeled": "labeled"},
        headers=headers,
    ).json()["items"]
    assert {i["id"] for i in labeled_only} == {labeled_id}

    unlabeled_only = client.get(
        "/media/sequences",
        params={"procedure_id": procedure_id, "labeled": "unlabeled"},
        headers=headers,
    ).json()["items"]
    assert {i["id"] for i in unlabeled_only} == {unlabeled_id}


def test_list_sequences_includes_preview_frames_with_mask_annotations():
    headers = _auth_headers()
    procedure_id = client.post(
        "/taxonomy/procedures", json={"name": "list-sequences-preview-procedure"}, headers=headers
    ).json()["id"]
    sequence_id, frame_id = _create_labeled_photo_sequence(
        headers, "list-sequences-preview-seq", procedure_id
    )
    label_id = _make_label(headers, procedure_id, "list-sequences-preview-label")
    client.post(f"/annotation/frames/{frame_id}/annotations", json={"label_id": label_id}, headers=headers)

    response = client.get("/media/sequences", params={"procedure_id": procedure_id}, headers=headers)
    item = next(i for i in response.json()["items"] if i["id"] == sequence_id)

    assert len(item["preview_frames"]) == 1
    preview_frame = item["preview_frames"][0]
    assert preview_frame["frame_id"] == frame_id
    assert preview_frame["image_url"]
    assert len(preview_frame["annotations"]) == 1
    assert preview_frame["annotations"][0]["label_id"] == label_id
    # A plain create-annotation call has no SAM2-produced mask yet (that's
    # written by the ml-worker job), so mask_url is expected to be None here --
    # this test only proves the field is wired through, not that it's populated.
    assert "mask_url" in preview_frame["annotations"][0]


def test_sequences_stats_aggregates_across_sequences():
    headers = _auth_headers()
    procedure_id = client.post(
        "/taxonomy/procedures", json={"name": "sequences-stats-procedure"}, headers=headers
    ).json()["id"]
    labeled_id, frame_id = _create_labeled_photo_sequence(
        headers, "sequences-stats-labeled", procedure_id
    )
    _create_labeled_photo_sequence(headers, "sequences-stats-unlabeled", procedure_id)
    label_id = _make_label(headers, procedure_id, "sequences-stats-label")
    client.post(f"/annotation/frames/{frame_id}/annotations", json={"label_id": label_id}, headers=headers)

    response = client.get("/media/sequences/stats", params={"procedure_id": procedure_id}, headers=headers)

    assert response.status_code == 200
    body = response.json()
    assert body["total_sequences"] == 2
    assert body["total_frames"] == 2
    assert body["labeled_sequences"] == 1
    assert body["unlabeled_sequences"] == 1


def test_list_sequences_404_is_not_returned_for_empty_result():
    headers = _auth_headers()
    response = client.get(
        "/media/sequences", params={"search": "no-such-sequence-name-exists-anywhere"}, headers=headers
    )
    assert response.status_code == 200
    assert response.json()["items"] == []
    assert response.json()["total"] == 0


def test_frame_defaults_to_not_reviewed_no_findings():
    headers = _auth_headers()
    procedure_id = client.post(
        "/taxonomy/procedures", json={"name": "no-findings-default-procedure"}, headers=headers
    ).json()["id"]
    with open(FIXTURE_VIDEO, "rb") as f:
        upload = client.post(
            "/media/videos",
            files={"file": ("tiny.mp4", f, "video/mp4")},
            data={"title": "no-findings-default", "procedure_id": str(procedure_id)},
            headers=headers,
        )
    video_id = upload.json()["id"]
    sequence = client.post(
        f"/media/videos/{video_id}/sequences",
        json={"name": "no-findings-default-seq", "start_time": 0, "duration": 2},
        headers=headers,
    ).json()
    frames = client.get(f"/media/sequences/{sequence['id']}/frames", headers=headers).json()

    assert frames[0]["no_findings_reviewed"] is False
