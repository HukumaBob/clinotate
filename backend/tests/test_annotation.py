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

    from app.db import SessionLocal
    from app.taxonomy.models import Procedure

    session = SessionLocal()
    procedure = session.query(Procedure).filter_by(name="annotation-frame-procedure").one_or_none()
    if procedure is None:
        procedure = Procedure(name="annotation-frame-procedure")
        session.add(procedure)
        session.commit()
        session.refresh(procedure)
    procedure_id = procedure.id
    session.close()

    fixture = Path(__file__).parent / "fixtures" / "tiny.mp4"
    with open(fixture, "rb") as f:
        upload = client.post(
            "/media/videos", files={"file": ("tiny.mp4", f, "video/mp4")},
            data={"title": "annotation source", "procedure_id": procedure_id}, headers=headers,
        )
    video_id = upload.json()["id"]
    sequence = client.post(
        f"/media/videos/{video_id}/sequences",
        json={"name": "test sequence", "start_time": 0, "duration": 2},
        headers=headers,
    ).json()
    frames = client.get(f"/media/sequences/{sequence['id']}/frames", headers=headers).json()
    return frames[0]["id"]


def _create_label(token: str) -> int:
    headers = _headers(token)

    # Get-or-create for procedure/category/evaluation-type: this helper is called by
    # every test in this file (and the fixture names are shared across runs against
    # the same dev DB), so look each one up first rather than relying on the POST to
    # fail gracefully -- Procedure/Category/EvaluationType creation raises a raw 500
    # on a unique-constraint collision instead of returning a JSON error body.
    procedures = client.get("/taxonomy/procedures", headers=headers).json()
    procedure = next((p for p in procedures if p["name"] == "annotation-test-procedure"), None)
    if procedure is None:
        procedure = client.post(
            "/taxonomy/procedures", json={"name": "annotation-test-procedure"}, headers=headers
        ).json()

    categories = client.get(
        f"/taxonomy/categories?procedure_id={procedure['id']}", headers=headers
    ).json()
    category = next((c for c in categories if c["name"] == "annotation-test-category"), None)
    if category is None:
        category = client.post(
            "/taxonomy/categories",
            json={"name": "annotation-test-category", "procedure_id": procedure["id"]},
            headers=headers,
        ).json()

    evaluation_types = client.get("/taxonomy/evaluation-types", headers=headers).json()
    evaluation_type = next(
        (e for e in evaluation_types if e["name"] == "annotation-test-evaluation-type"), None
    )
    if evaluation_type is None:
        evaluation_type = client.post(
            "/taxonomy/evaluation-types", json={"name": "annotation-test-evaluation-type"}, headers=headers
        ).json()

    return client.post(
        "/taxonomy/labels",
        json={
            "name": "Landmark",
            "category_id": category["id"],
            "evaluation_type_id": evaluation_type["id"],
        },
        headers=headers,
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


def test_list_annotations_includes_mask_postprocess_strength_from_payload():
    token = _register_and_login("annot7@example.com")
    frame_id = _create_frame(token)
    label_id = _create_label(token)

    from app.annotation.models import Annotation, AnnotationStatus, AnnotationType
    from app.auth.models import User
    from app.db import SessionLocal

    session = SessionLocal()
    try:
        user = session.query(User).filter(User.email == "annot7@example.com").one()
        annotation = Annotation(
            frame_id=frame_id,
            label_id=label_id,
            taxonomy_version=1,
            annotation_type=AnnotationType.MASK,
            status=AnnotationStatus.DRAFT,
            created_by_id=user.id,
            storage_key="masks/test-mask-strength.png",
            payload={"mask_postprocess_strength": 0.3},
        )
        session.add(annotation)
        session.commit()
    finally:
        session.close()

    response = client.get(f"/annotation/frames/{frame_id}/annotations", headers=_headers(token))

    assert response.status_code == 200
    mask_annotation = next(a for a in response.json() if a["annotation_type"] == "mask")
    assert mask_annotation["mask_postprocess_strength"] == 0.3


def test_list_annotations_mask_postprocess_strength_is_null_when_not_set():
    token = _register_and_login("annot8@example.com")
    frame_id = _create_frame(token)
    label_id = _create_label(token)

    from app.annotation.models import Annotation, AnnotationStatus, AnnotationType
    from app.auth.models import User
    from app.db import SessionLocal

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
            storage_key="masks/test-mask-no-strength.png",
        )
        session.add(annotation)
        session.commit()
    finally:
        session.close()

    response = client.get(f"/annotation/frames/{frame_id}/annotations", headers=_headers(token))

    assert response.status_code == 200
    mask_annotation = next(a for a in response.json() if a["annotation_type"] == "mask")
    assert mask_annotation["mask_postprocess_strength"] is None


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


def _create_label_in_category(
    token: str,
    category_name: str,
    label_name: str,
    evaluation_type_name: str = "annotation-test-evaluation-type",
) -> int:
    headers = _headers(token)

    procedures = client.get("/taxonomy/procedures", headers=headers).json()
    procedure = next((p for p in procedures if p["name"] == "annotation-test-procedure"), None)
    if procedure is None:
        procedure = client.post(
            "/taxonomy/procedures", json={"name": "annotation-test-procedure"}, headers=headers
        ).json()

    categories = client.get(
        f"/taxonomy/categories?procedure_id={procedure['id']}", headers=headers
    ).json()
    category = next((c for c in categories if c["name"] == category_name), None)
    if category is None:
        category = client.post(
            "/taxonomy/categories",
            json={"name": category_name, "procedure_id": procedure["id"]},
            headers=headers,
        ).json()

    evaluation_types = client.get("/taxonomy/evaluation-types", headers=headers).json()
    evaluation_type = next(
        (e for e in evaluation_types if e["name"] == evaluation_type_name), None
    )
    if evaluation_type is None:
        evaluation_type = client.post(
            "/taxonomy/evaluation-types", json={"name": evaluation_type_name}, headers=headers
        ).json()

    return client.post(
        "/taxonomy/labels",
        json={
            "name": label_name,
            "category_id": category["id"],
            "evaluation_type_id": evaluation_type["id"],
        },
        headers=headers,
    ).json()["id"]


def test_bulk_classify_assigns_label_to_all_frames():
    token = _register_and_login("bulkclass1@example.com")
    frame_id_1 = _create_frame(token)
    frame_id_2 = _create_frame(token)
    label_id = _create_label_in_category(token, "bulk-classify-landmark", "antrum")

    response = client.post(
        "/annotation/frames/bulk-classify",
        json={"frame_ids": [frame_id_1, frame_id_2], "label_id": label_id},
        headers=_headers(token),
    )

    assert response.status_code == 201
    assert set(response.json()["frame_ids"]) == {frame_id_1, frame_id_2}

    for frame_id in (frame_id_1, frame_id_2):
        annotations = client.get(f"/annotation/frames/{frame_id}/annotations", headers=_headers(token)).json()
        assert len(annotations) == 1
        assert annotations[0]["label_id"] == label_id
        assert annotations[0]["annotation_type"] == "classification"


def test_bulk_classify_replaces_existing_label_in_same_category():
    token = _register_and_login("bulkclass2@example.com")
    frame_id = _create_frame(token)
    antrum_id = _create_label_in_category(token, "bulk-classify-replace", "antrum")
    ge_junction_id = _create_label_in_category(token, "bulk-classify-replace", "ge_junction")

    client.post(
        "/annotation/frames/bulk-classify",
        json={"frame_ids": [frame_id], "label_id": antrum_id},
        headers=_headers(token),
    )
    response = client.post(
        "/annotation/frames/bulk-classify",
        json={"frame_ids": [frame_id], "label_id": ge_junction_id},
        headers=_headers(token),
    )

    assert response.status_code == 201
    annotations = client.get(f"/annotation/frames/{frame_id}/annotations", headers=_headers(token)).json()
    assert len(annotations) == 1
    assert annotations[0]["label_id"] == ge_junction_id


def test_bulk_classify_keeps_labels_in_different_categories_independent():
    token = _register_and_login("bulkclass3@example.com")
    frame_id = _create_frame(token)
    landmark_id = _create_label_in_category(token, "bulk-classify-landmark-axis", "antrum")
    quality_id = _create_label_in_category(token, "bulk-classify-quality-axis", "low_quality")

    client.post(
        "/annotation/frames/bulk-classify",
        json={"frame_ids": [frame_id], "label_id": landmark_id},
        headers=_headers(token),
    )
    response = client.post(
        "/annotation/frames/bulk-classify",
        json={"frame_ids": [frame_id], "label_id": quality_id},
        headers=_headers(token),
    )

    assert response.status_code == 201
    annotations = client.get(f"/annotation/frames/{frame_id}/annotations", headers=_headers(token)).json()
    label_ids = {a["label_id"] for a in annotations}
    assert label_ids == {landmark_id, quality_id}


def test_bulk_classify_404s_for_unknown_label():
    token = _register_and_login("bulkclass4@example.com")
    frame_id = _create_frame(token)

    response = client.post(
        "/annotation/frames/bulk-classify",
        json={"frame_ids": [frame_id], "label_id": 999999999},
        headers=_headers(token),
    )

    assert response.status_code == 404


def test_bulk_clear_classification_removes_label_in_that_category_only():
    token = _register_and_login("bulkclear1@example.com")
    frame_id = _create_frame(token)
    landmark_id = _create_label_in_category(token, "bulk-clear-landmark", "antrum")
    quality_id = _create_label_in_category(token, "bulk-clear-quality", "low_quality")
    landmark_label = client.get("/taxonomy/labels", headers=_headers(token)).json()
    landmark_row = next(l for l in landmark_label if l["id"] == landmark_id)
    landmark_category_id = landmark_row["category_id"]
    landmark_evaluation_type_id = landmark_row["evaluation_type_id"]

    client.post(
        "/annotation/frames/bulk-classify",
        json={"frame_ids": [frame_id], "label_id": landmark_id},
        headers=_headers(token),
    )
    client.post(
        "/annotation/frames/bulk-classify",
        json={"frame_ids": [frame_id], "label_id": quality_id},
        headers=_headers(token),
    )

    response = client.post(
        "/annotation/frames/bulk-clear-classification",
        json={
            "frame_ids": [frame_id],
            "category_id": landmark_category_id,
            "evaluation_type_id": landmark_evaluation_type_id,
        },
        headers=_headers(token),
    )

    assert response.status_code == 200
    annotations = client.get(f"/annotation/frames/{frame_id}/annotations", headers=_headers(token)).json()
    label_ids = {a["label_id"] for a in annotations}
    assert label_ids == {quality_id}


def test_bulk_clear_classification_is_a_no_op_when_nothing_to_clear():
    token = _register_and_login("bulkclear2@example.com")
    frame_id = _create_frame(token)
    label_id = _create_label_in_category(token, "bulk-clear-empty", "some_label")
    labels = client.get("/taxonomy/labels", headers=_headers(token)).json()
    label_row = next(l for l in labels if l["id"] == label_id)

    response = client.post(
        "/annotation/frames/bulk-clear-classification",
        json={
            "frame_ids": [frame_id],
            "category_id": label_row["category_id"],
            "evaluation_type_id": label_row["evaluation_type_id"],
        },
        headers=_headers(token),
    )

    assert response.status_code == 200
    assert response.json()["frame_ids"] == [frame_id]


def test_bulk_classify_404s_for_unknown_frame_id_without_partial_apply():
    token = _register_and_login("bulkclass5@example.com")
    frame_id = _create_frame(token)
    label_id = _create_label_in_category(token, "bulk-classify-missing-frame", "antrum")

    response = client.post(
        "/annotation/frames/bulk-classify",
        json={"frame_ids": [frame_id, 999999999], "label_id": label_id},
        headers=_headers(token),
    )

    assert response.status_code == 404
    annotations = client.get(f"/annotation/frames/{frame_id}/annotations", headers=_headers(token)).json()
    classification_annotations = [a for a in annotations if a["annotation_type"] == "classification"]
    assert classification_annotations == []


def test_bulk_clear_classification_404s_for_unknown_frame_id():
    token = _register_and_login("bulkclear3@example.com")
    frame_id = _create_frame(token)
    label_id = _create_label_in_category(token, "bulk-clear-missing-frame", "antrum")
    labels = client.get("/taxonomy/labels", headers=_headers(token)).json()
    label_row = next(l for l in labels if l["id"] == label_id)

    response = client.post(
        "/annotation/frames/bulk-clear-classification",
        json={
            "frame_ids": [frame_id, 999999999],
            "category_id": label_row["category_id"],
            "evaluation_type_id": label_row["evaluation_type_id"],
        },
        headers=_headers(token),
    )

    assert response.status_code == 404


def test_bulk_clear_classification_scopes_by_evaluation_type_not_just_category():
    token = _register_and_login("bulkclear4@example.com")
    frame_id = _create_frame(token)
    frame_classification_id = _create_label_in_category(
        token,
        "bulk-clear-shared-category",
        "antrum",
        evaluation_type_name="bulk-clear-frame-classification-type",
    )
    morphological_id = _create_label_in_category(
        token,
        "bulk-clear-shared-category",
        "polyp-shape",
        evaluation_type_name="bulk-clear-morphological-type",
    )
    labels = client.get("/taxonomy/labels", headers=_headers(token)).json()
    frame_classification_row = next(l for l in labels if l["id"] == frame_classification_id)
    morphological_row = next(l for l in labels if l["id"] == morphological_id)
    assert frame_classification_row["category_id"] == morphological_row["category_id"]

    client.post(
        "/annotation/frames/bulk-classify",
        json={"frame_ids": [frame_id], "label_id": frame_classification_id},
        headers=_headers(token),
    )
    client.post(
        f"/annotation/frames/{frame_id}/annotations",
        json={"label_id": morphological_id},
        headers=_headers(token),
    )

    response = client.post(
        "/annotation/frames/bulk-clear-classification",
        json={
            "frame_ids": [frame_id],
            "category_id": frame_classification_row["category_id"],
            "evaluation_type_id": frame_classification_row["evaluation_type_id"],
        },
        headers=_headers(token),
    )

    assert response.status_code == 200
    annotations = client.get(f"/annotation/frames/{frame_id}/annotations", headers=_headers(token)).json()
    label_ids = {a["label_id"] for a in annotations}
    assert label_ids == {morphological_id}
