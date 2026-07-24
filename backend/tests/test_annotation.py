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


def test_list_annotations_includes_mask_url_when_storage_key_present():
    token = _register_and_login("annot5@example.com")
    frame_id = _create_frame(token)
    label_id = _create_label(token)

    from app.annotation.models import Annotation, AnnotationStatus, AnnotationType
    from app.auth.models import User
    from app.db import SessionLocal

    session = SessionLocal()
    try:
        user = session.query(User).filter(User.email == "annot5@example.com").one()
        annotation = Annotation(
            frame_id=frame_id,
            label_id=label_id,
            taxonomy_version=1,
            annotation_type=AnnotationType.MASK,
            status=AnnotationStatus.DRAFT,
            created_by_id=user.id,
            storage_key="masks/test-mask.png",
        )
        session.add(annotation)
        session.commit()
    finally:
        session.close()

    response = client.get(f"/annotation/frames/{frame_id}/annotations", headers=_headers(token))

    assert response.status_code == 200
    mask_annotation = next(a for a in response.json() if a["annotation_type"] == "mask")
    assert mask_annotation["mask_url"] is not None
    assert mask_annotation["mask_url"].startswith("http")


def test_annotation_mask_url_is_null_for_classification_annotations():
    token = _register_and_login("annot6@example.com")
    frame_id = _create_frame(token)
    label_id = _create_label(token)
    client.post(f"/annotation/frames/{frame_id}/annotations", json={"label_id": label_id}, headers=_headers(token))

    response = client.get(f"/annotation/frames/{frame_id}/annotations", headers=_headers(token))

    assert response.status_code == 200
    assert response.json()[0]["mask_url"] is None


def test_annotation_job_id_column_accepts_a_real_job_reference():
    token = _register_and_login("annot7@example.com")
    frame_id = _create_frame(token)
    label_id = _create_label(token)

    from app.annotation.models import Annotation, AnnotationStatus, AnnotationType
    from app.auth.models import User
    from app.db import SessionLocal
    from app.jobs.models import Job, JobStatus, JobType

    session = SessionLocal()
    try:
        user = session.query(User).filter(User.email == "annot7@example.com").one()
        job = Job(
            job_type=JobType.SAM2_PREDICT,
            status=JobStatus.SUCCEEDED,
            progress=100,
            payload={},
            created_by_id=user.id,
        )
        session.add(job)
        session.commit()
        session.refresh(job)

        annotation = Annotation(
            frame_id=frame_id,
            label_id=label_id,
            taxonomy_version=1,
            annotation_type=AnnotationType.MASK,
            status=AnnotationStatus.DRAFT,
            created_by_id=user.id,
            storage_key="masks/test-job-id.png",
            job_id=job.id,
        )
        session.add(annotation)
        session.commit()
        session.refresh(annotation)

        assert annotation.job_id == job.id
    finally:
        session.close()


def test_delete_single_annotation_removes_it_and_its_storage_object():
    token = _register_and_login("annot8@example.com")
    frame_id = _create_frame(token)
    label_id = _create_label(token)

    from app.annotation.models import Annotation, AnnotationStatus, AnnotationType
    from app.auth.models import User
    from app.db import SessionLocal
    from app.storage import get_storage_service

    storage = get_storage_service()
    storage_key = "masks/delete-test/single.png"
    storage.upload(storage_key, b"fake-png-bytes", content_type="image/png")

    session = SessionLocal()
    try:
        user = session.query(User).filter(User.email == "annot8@example.com").one()
        annotation = Annotation(
            frame_id=frame_id,
            label_id=label_id,
            taxonomy_version=1,
            annotation_type=AnnotationType.MASK,
            status=AnnotationStatus.DRAFT,
            created_by_id=user.id,
            storage_key=storage_key,
        )
        session.add(annotation)
        session.commit()
        session.refresh(annotation)
        annotation_id = annotation.id
    finally:
        session.close()

    response = client.delete(f"/annotation/annotations/{annotation_id}", headers=_headers(token))
    assert response.status_code == 204

    list_response = client.get(f"/annotation/frames/{frame_id}/annotations", headers=_headers(token))
    assert all(a["id"] != annotation_id for a in list_response.json())


def test_delete_single_annotation_404s_for_missing_annotation():
    token = _register_and_login("annot9@example.com")

    response = client.delete("/annotation/annotations/999999999", headers=_headers(token))
    assert response.status_code == 404


def test_delete_job_annotations_removes_only_that_jobs_annotations():
    token = _register_and_login("annot10@example.com")
    frame_id = _create_frame(token)
    label_id = _create_label(token)

    from app.annotation.models import Annotation, AnnotationStatus, AnnotationType
    from app.auth.models import User
    from app.db import SessionLocal
    from app.jobs.models import Job, JobStatus, JobType

    session = SessionLocal()
    try:
        user = session.query(User).filter(User.email == "annot10@example.com").one()

        job_a = Job(job_type=JobType.SAM2_TRACK, status=JobStatus.SUCCEEDED, progress=100, payload={}, created_by_id=user.id)
        job_b = Job(job_type=JobType.SAM2_TRACK, status=JobStatus.SUCCEEDED, progress=100, payload={}, created_by_id=user.id)
        session.add_all([job_a, job_b])
        session.commit()
        session.refresh(job_a)
        session.refresh(job_b)

        annotation_a1 = Annotation(
            frame_id=frame_id, label_id=label_id, taxonomy_version=1,
            annotation_type=AnnotationType.MASK, status=AnnotationStatus.DRAFT,
            created_by_id=user.id, storage_key="masks/bulk-test/a1.png", job_id=job_a.id,
        )
        annotation_a2 = Annotation(
            frame_id=frame_id, label_id=label_id, taxonomy_version=1,
            annotation_type=AnnotationType.MASK, status=AnnotationStatus.DRAFT,
            created_by_id=user.id, storage_key="masks/bulk-test/a2.png", job_id=job_a.id,
        )
        annotation_b1 = Annotation(
            frame_id=frame_id, label_id=label_id, taxonomy_version=1,
            annotation_type=AnnotationType.MASK, status=AnnotationStatus.DRAFT,
            created_by_id=user.id, storage_key="masks/bulk-test/b1.png", job_id=job_b.id,
        )
        session.add_all([annotation_a1, annotation_a2, annotation_b1])
        session.commit()
        session.refresh(annotation_a1)
        session.refresh(annotation_a2)
        session.refresh(annotation_b1)

        job_a_id = job_a.id
        annotation_b1_id = annotation_b1.id
    finally:
        session.close()

    response = client.delete(f"/annotation/jobs/{job_a_id}/annotations", headers=_headers(token))
    assert response.status_code == 200
    assert len(response.json()["deleted_ids"]) == 2

    list_response = client.get(f"/annotation/frames/{frame_id}/annotations", headers=_headers(token))
    remaining_ids = [a["id"] for a in list_response.json()]
    assert annotation_b1_id in remaining_ids
