import pytest
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
    from app.db import SessionLocal
    from app.taxonomy.models import Procedure

    session = SessionLocal()
    procedure = session.query(Procedure).filter_by(name="jobs-frame-procedure").one_or_none()
    if procedure is None:
        procedure = Procedure(name="jobs-frame-procedure")
        session.add(procedure)
        session.commit()
        session.refresh(procedure)
    procedure_id = procedure.id
    session.close()
    fixture = Path(__file__).parent / "fixtures" / "tiny.mp4"
    with open(fixture, "rb") as f:
        upload = client.post(
            "/media/videos", files={"file": ("tiny.mp4", f, "video/mp4")},
            data={"title": "jobs test source", "procedure_id": procedure_id}, headers=headers,
        )
    video_id = upload.json()["id"]
    sequence = client.post(
        f"/media/videos/{video_id}/sequences",
        json={"name": "test sequence", "start_time": 0, "duration": 2},
        headers=headers,
    ).json()
    frames = client.get(f"/media/sequences/{sequence['id']}/frames", headers=headers).json()
    return frames[0]["id"], sequence["id"]


def _create_label() -> int:
    from app.db import SessionLocal
    from app.taxonomy.models import Category, EvaluationType, Label, Procedure

    session = SessionLocal()
    procedure = session.query(Procedure).filter_by(name="jobs-test-procedure").one_or_none()
    if procedure is None:
        procedure = Procedure(name="jobs-test-procedure")
        session.add(procedure)
        session.flush()
    category = session.query(Category).filter_by(name="jobs-test-category", procedure_id=procedure.id).one_or_none()
    if category is None:
        category = Category(name="jobs-test-category", procedure_id=procedure.id)
        session.add(category)
        session.flush()
    evaluation_type = session.query(EvaluationType).filter_by(name="jobs-test-evaluation-type").one_or_none()
    if evaluation_type is None:
        evaluation_type = EvaluationType(name="jobs-test-evaluation-type")
        session.add(evaluation_type)
        session.flush()
    label = Label(
        name="jobs-test-label",
        category_id=category.id,
        evaluation_type_id=evaluation_type.id,
        taxonomy_version=1,
    )
    session.add(label)
    session.commit()
    session.refresh(label)
    label_id = label.id
    session.close()
    return label_id


def test_enqueue_sam3_predict_creates_pending_job():
    token = _register_and_login("jobs3@example.com")
    frame_id, _ = _create_frame(token)
    label_id = _create_label()

    response = client.post(
        "/jobs/sam3/predict",
        json={
            "frame_id": frame_id,
            "label_id": label_id,
            "prompts": [{"type": "point", "coords": [0.5, 0.5], "label": True}],
        },
        headers=_auth_headers(token),
    )

    assert response.status_code == 201
    body = response.json()
    assert body["job_type"] == "sam3_predict"
    assert body["status"] == "pending"


def test_enqueue_sam3_predict_stores_label_id_in_payload():
    from app.db import SessionLocal
    from app.jobs.models import Job

    token = _register_and_login("jobs5@example.com")
    frame_id, _ = _create_frame(token)
    label_id = _create_label()

    response = client.post(
        "/jobs/sam3/predict",
        json={
            "frame_id": frame_id,
            "label_id": label_id,
            "prompts": [{"type": "point", "coords": [0.5, 0.5], "label": True}],
        },
        headers=_auth_headers(token),
    )

    job_id = response.json()["id"]
    session = SessionLocal()
    job = session.get(Job, job_id)
    assert job.payload["label_id"] == label_id
    session.close()


def test_enqueue_sam3_predict_with_unknown_label_returns_404():
    token = _register_and_login("jobs6@example.com")
    frame_id, _ = _create_frame(token)

    response = client.post(
        "/jobs/sam3/predict",
        json={
            "frame_id": frame_id,
            "label_id": 999999,
            "prompts": [{"type": "point", "coords": [0.5, 0.5], "label": True}],
        },
        headers=_auth_headers(token),
    )

    assert response.status_code == 404


def test_enqueue_sam3_track_creates_pending_job():
    token = _register_and_login("jobs4@example.com")
    _, sequence_id = _create_frame(token)
    label_id = _create_label()

    response = client.post(
        "/jobs/sam3/track",
        json={
            "sequence_id": sequence_id,
            "label_id": label_id,
            "prompts": [{"type": "box", "coords": [0.1, 0.1, 0.3, 0.3], "label": True}],
        },
        headers=_auth_headers(token),
    )

    assert response.status_code == 201
    body = response.json()
    assert body["job_type"] == "sam3_track"
    assert body["status"] == "pending"


def test_enqueue_sam3_track_with_unknown_label_returns_404():
    token = _register_and_login("jobs7@example.com")
    _, sequence_id = _create_frame(token)

    response = client.post(
        "/jobs/sam3/track",
        json={
            "sequence_id": sequence_id,
            "label_id": 999999,
            "prompts": [{"type": "box", "coords": [0.1, 0.1, 0.3, 0.3], "label": True}],
        },
        headers=_auth_headers(token),
    )

    assert response.status_code == 404


def test_enqueue_requires_auth():
    response = client.post("/jobs/sam3/predict", json={"frame_id": 1, "label_id": 1, "prompts": []})
    assert response.status_code == 401


def test_prompt_in_accepts_mask_type_with_base64_png():
    from app.jobs.schemas import PromptIn

    prompt = PromptIn(type="mask", mask_png="aGVsbG8=")

    assert prompt.type == "mask"
    assert prompt.mask_png == "aGVsbG8="
    assert prompt.coords == []


def test_prompt_in_rejects_mask_type_without_mask_png():
    from pydantic import ValidationError

    from app.jobs.schemas import PromptIn

    with pytest.raises(ValidationError, match="mask_png"):
        PromptIn(type="mask")


def test_prompt_in_rejects_oversized_mask_png():
    from pydantic import ValidationError

    from app.jobs.schemas import PromptIn

    oversized = "A" * (10 * 1024 * 1024 + 1)
    with pytest.raises(ValidationError, match="mask_png"):
        PromptIn(type="mask", mask_png=oversized)


def test_sam2_track_request_requires_anchor_and_direction_fields():
    from pydantic import ValidationError

    from app.jobs.schemas import Sam2TrackRequest

    with pytest.raises(ValidationError):
        Sam2TrackRequest(sequence_id=1, label_id=1, prompts=[])


def test_sam2_track_request_accepts_full_payload():
    from app.jobs.schemas import Sam2TrackRequest, PromptIn

    request = Sam2TrackRequest(
        sequence_id=1,
        label_id=2,
        prompts=[PromptIn(type="point", coords=[0.5, 0.5], label=True)],
        anchor_frame_id=10,
        backward=3,
        forward=5,
    )

    assert request.anchor_frame_id == 10
    assert request.backward == 3
    assert request.forward == 5


def test_sam2_track_request_rejects_negative_backward():
    from pydantic import ValidationError

    from app.jobs.schemas import PromptIn, Sam2TrackRequest

    with pytest.raises(ValidationError):
        Sam2TrackRequest(
            sequence_id=1,
            label_id=1,
            prompts=[PromptIn(type="point", coords=[0.5, 0.5], label=True)],
            anchor_frame_id=10,
            backward=-1,
            forward=5,
        )


def test_job_type_has_sam2_variants():
    from app.jobs.models import JobType

    assert JobType.SAM2_PREDICT == "sam2_predict"
    assert JobType.SAM2_TRACK == "sam2_track"


def test_enqueue_sam2_predict_creates_pending_job():
    from app.auth.models import User
    from app.db import SessionLocal
    from app.jobs.service import enqueue_sam2_predict

    token = _register_and_login("sam2-jobs1@example.com")
    frame_id, _ = _create_frame(token)
    label_id = _create_label()

    session = SessionLocal()
    user = session.query(User).filter(User.email == "sam2-jobs1@example.com").one()
    job = enqueue_sam2_predict(
        session, frame_id, label_id,
        prompts=[{"type": "point", "coords": [0.5, 0.5], "label": True}],
        created_by=user,
    )
    session.close()

    assert job.job_type == "sam2_predict"
    assert job.status == "pending"
    assert job.payload["frame_id"] == frame_id


def test_enqueue_sam2_track_stores_anchor_and_direction_in_payload():
    from app.auth.models import User
    from app.db import SessionLocal
    from app.jobs.service import enqueue_sam2_track

    token = _register_and_login("sam2-jobs2@example.com")
    frame_id, sequence_id = _create_frame(token)
    label_id = _create_label()

    session = SessionLocal()
    user = session.query(User).filter(User.email == "sam2-jobs2@example.com").one()
    job = enqueue_sam2_track(
        session, sequence_id, label_id,
        prompts=[{"type": "box", "coords": [0.1, 0.1, 0.3, 0.3], "label": True}],
        anchor_frame_id=frame_id, backward=2, forward=4,
        created_by=user,
    )
    session.close()

    assert job.job_type == "sam2_track"
    assert job.payload["anchor_frame_id"] == frame_id
    assert job.payload["backward"] == 2
    assert job.payload["forward"] == 4


def test_enqueue_sam2_track_rejects_combined_range_over_live_setting():
    from app.db import SessionLocal
    from app.settings.models import PlatformSettings

    token = _register_and_login("jobs-range1@example.com")
    frame_id, sequence_id = _create_frame(token)
    label_id = _create_label()

    session = SessionLocal()
    settings_row = session.get(PlatformSettings, 1)
    original_value = settings_row.max_track_range_frames
    settings_row.max_track_range_frames = 10
    session.commit()
    session.close()

    response = client.post(
        "/jobs/sam2/track",
        json={
            "sequence_id": sequence_id,
            "label_id": label_id,
            "prompts": [{"type": "point", "coords": [0.5, 0.5], "label": True}],
            "anchor_frame_id": frame_id,
            "backward": 6,
            "forward": 6,
        },
        headers=_auth_headers(token),
    )
    assert response.status_code == 422

    session = SessionLocal()
    settings_row = session.get(PlatformSettings, 1)
    settings_row.max_track_range_frames = original_value
    session.commit()
    session.close()


def test_enqueue_sam2_track_accepts_combined_range_at_live_setting():
    from app.db import SessionLocal
    from app.settings.models import PlatformSettings

    token = _register_and_login("jobs-range2@example.com")
    frame_id, sequence_id = _create_frame(token)
    label_id = _create_label()

    session = SessionLocal()
    settings_row = session.get(PlatformSettings, 1)
    original_value = settings_row.max_track_range_frames
    settings_row.max_track_range_frames = 10
    session.commit()
    session.close()

    response = client.post(
        "/jobs/sam2/track",
        json={
            "sequence_id": sequence_id,
            "label_id": label_id,
            "prompts": [{"type": "point", "coords": [0.5, 0.5], "label": True}],
            "anchor_frame_id": frame_id,
            "backward": 5,
            "forward": 5,
        },
        headers=_auth_headers(token),
    )
    assert response.status_code == 201

    session = SessionLocal()
    settings_row = session.get(PlatformSettings, 1)
    settings_row.max_track_range_frames = original_value
    session.commit()
    session.close()


def test_enqueue_sam2_predict_endpoint_creates_pending_job():
    token = _register_and_login("sam2-endpoint1@example.com")
    frame_id, _ = _create_frame(token)
    label_id = _create_label()

    response = client.post(
        "/jobs/sam2/predict",
        json={
            "frame_id": frame_id,
            "label_id": label_id,
            "prompts": [{"type": "point", "coords": [0.5, 0.5], "label": True}],
        },
        headers=_auth_headers(token),
    )

    assert response.status_code == 201
    body = response.json()
    assert body["job_type"] == "sam2_predict"
    assert body["status"] == "pending"


def test_enqueue_sam2_track_endpoint_creates_pending_job():
    token = _register_and_login("sam2-endpoint2@example.com")
    frame_id, sequence_id = _create_frame(token)
    label_id = _create_label()

    response = client.post(
        "/jobs/sam2/track",
        json={
            "sequence_id": sequence_id,
            "label_id": label_id,
            "prompts": [{"type": "box", "coords": [0.1, 0.1, 0.3, 0.3], "label": True}],
            "anchor_frame_id": frame_id,
            "backward": 2,
            "forward": 4,
        },
        headers=_auth_headers(token),
    )

    assert response.status_code == 201
    body = response.json()
    assert body["job_type"] == "sam2_track"


def test_enqueue_sam2_predict_endpoint_requires_auth():
    response = client.post(
        "/jobs/sam2/predict",
        json={"frame_id": 1, "label_id": 1, "prompts": []},
    )
    assert response.status_code == 401


def test_enqueue_video_transcode_creates_pending_job():
    from app.auth.models import User
    from app.db import SessionLocal
    from app.jobs.models import JobStatus, JobType
    from app.jobs.service import enqueue_video_transcode

    token = _register_and_login("video-transcode1@example.com")
    _, sequence_id = _create_frame(token)
    sequence = client.get(f"/media/sequences/{sequence_id}", headers=_auth_headers(token)).json()
    video_id = sequence["video_id"]

    session = SessionLocal()
    user = session.query(User).filter(User.email == "video-transcode1@example.com").one()
    job = enqueue_video_transcode(session, video_id, user)
    session.close()

    assert job.job_type == JobType.VIDEO_TRANSCODE
    assert job.status == JobStatus.PENDING
    assert job.payload == {"video_id": video_id}


def test_get_job_returns_vram_fields():
    from app.db import SessionLocal
    from app.jobs.models import Job, JobStatus, JobType

    token_str = _register_and_login("jobs_vram@example.com")
    token = _auth_headers(token_str)

    me_response = client.get("/auth/me", headers=token)
    user_id = me_response.json()["id"]

    session = SessionLocal()
    job = Job(
        job_type=JobType.SAM2_PREDICT,
        status=JobStatus.SUCCEEDED,
        progress=100,
        payload={"frame_id": 1},
        created_by_id=user_id,
        vram_used_bytes=4_294_967_296,
        vram_total_bytes=8_589_934_592,
    )
    session.add(job)
    session.commit()
    session.refresh(job)
    job_id = job.id
    session.close()

    response = client.get(f"/jobs/{job_id}", headers=token)

    assert response.status_code == 200
    body = response.json()
    assert body["vram_used_bytes"] == 4_294_967_296
    assert body["vram_total_bytes"] == 8_589_934_592


def test_get_job_vram_fields_default_to_null():
    from app.db import SessionLocal
    from app.jobs.models import Job, JobStatus, JobType

    token_str = _register_and_login("jobs_vram_null@example.com")
    token = _auth_headers(token_str)

    me_response = client.get("/auth/me", headers=token)
    user_id = me_response.json()["id"]

    session = SessionLocal()
    job = Job(
        job_type=JobType.SAM2_PREDICT,
        status=JobStatus.PENDING,
        progress=0,
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
    assert body["vram_used_bytes"] is None
    assert body["vram_total_bytes"] is None
