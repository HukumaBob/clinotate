import io

import numpy as np
from fastapi.testclient import TestClient
from PIL import Image

from app.main import app

client = TestClient(app)


def _register_and_login(email: str) -> str:
    client.post("/auth/register", json={"email": email, "password": "pass1234", "role": "annotator"})
    response = client.post("/auth/login", json={"email": email, "password": "pass1234"})
    return response.json()["access_token"]


def _headers(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


def _upload_raw_mask(key: str) -> None:
    from app.storage import get_storage_service

    mask = np.zeros((100, 100), dtype=bool)
    mask[20:80, 20:80] = True
    mask[10:12, 10:12] = True  # speckle
    buffer = io.BytesIO()
    Image.fromarray((mask.astype("uint8")) * 255, mode="L").save(buffer, format="PNG")
    get_storage_service().upload(key, buffer.getvalue(), content_type="image/png")


def _create_frame(token: str) -> int:
    headers = _headers(token)
    from pathlib import Path

    from app.db import SessionLocal
    from app.taxonomy.models import Procedure

    session = SessionLocal()
    procedure = session.query(Procedure).filter_by(name="postprocess-endpoint-procedure").one_or_none()
    if procedure is None:
        procedure = Procedure(name="postprocess-endpoint-procedure")
        session.add(procedure)
        session.commit()
        session.refresh(procedure)
    procedure_id = procedure.id
    session.close()

    fixture = Path(__file__).parent / "fixtures" / "tiny.mp4"
    with open(fixture, "rb") as f:
        upload = client.post(
            "/media/videos", files={"file": ("tiny.mp4", f, "video/mp4")},
            data={"title": "postprocess endpoint source", "procedure_id": procedure_id}, headers=headers,
        )
    video_id = upload.json()["id"]
    sequence = client.post(
        f"/media/videos/{video_id}/sequences",
        json={"name": "test sequence", "start_time": 0, "duration": 2},
        headers=headers,
    ).json()
    frames = client.get(f"/media/sequences/{sequence['id']}/frames", headers=headers).json()
    return frames[0]["id"]


def _create_label() -> int:
    from app.db import SessionLocal
    from app.taxonomy.models import Category, EvaluationType, Label, Procedure

    session = SessionLocal()
    procedure = session.query(Procedure).filter_by(name="postprocess-endpoint-label-procedure").one_or_none()
    if procedure is None:
        procedure = Procedure(name="postprocess-endpoint-label-procedure")
        session.add(procedure)
        session.flush()
    category = session.query(Category).filter_by(
        name="postprocess-endpoint-category", procedure_id=procedure.id
    ).one_or_none()
    if category is None:
        category = Category(name="postprocess-endpoint-category", procedure_id=procedure.id)
        session.add(category)
        session.flush()
    evaluation_type = session.query(EvaluationType).filter_by(
        name="postprocess-endpoint-evaluation-type"
    ).one_or_none()
    if evaluation_type is None:
        evaluation_type = EvaluationType(name="postprocess-endpoint-evaluation-type")
        session.add(evaluation_type)
        session.flush()
    label = Label(
        name="postprocess-endpoint-label", category_id=category.id,
        evaluation_type_id=evaluation_type.id, taxonomy_version=1,
    )
    session.add(label)
    session.commit()
    session.refresh(label)
    label_id = label.id
    session.close()
    return label_id


def test_reapply_postprocess_updates_storage_key_and_payload():
    from app.annotation.models import Annotation, AnnotationStatus, AnnotationType
    from app.auth.models import User
    from app.db import SessionLocal
    from app.storage import get_storage_service

    email = "postprocess-endpoint1@example.com"
    token = _register_and_login(email)
    frame_id = _create_frame(token)
    label_id = _create_label()

    raw_key = "masks/postprocess-endpoint-test/raw1.png"
    _upload_raw_mask(raw_key)

    session = SessionLocal()
    user = session.query(User).filter(User.email == email).one()
    annotation = Annotation(
        frame_id=frame_id, label_id=label_id, taxonomy_version=1,
        annotation_type=AnnotationType.MASK, payload={}, status=AnnotationStatus.DRAFT,
        created_by_id=user.id, storage_key=raw_key, raw_mask_storage_key=raw_key,
    )
    session.add(annotation)
    session.commit()
    session.refresh(annotation)
    annotation_id = annotation.id
    session.close()

    response = client.patch(
        f"/annotation/annotations/{annotation_id}/mask-postprocess",
        json={"strength": 0.5},
        headers=_headers(token),
    )

    assert response.status_code == 200
    body = response.json()
    assert body["mask_postprocess_strength"] == 0.5

    session = SessionLocal()
    refreshed = session.get(Annotation, annotation_id)
    postprocessed_bytes = get_storage_service().download(refreshed.storage_key)
    session.close()

    postprocessed = np.array(Image.open(io.BytesIO(postprocessed_bytes)))
    assert not (postprocessed[10:12, 10:12] > 0).any()  # speckle removed


def test_reapply_postprocess_404s_for_missing_annotation():
    token = _register_and_login("postprocess-endpoint2@example.com")

    response = client.patch(
        "/annotation/annotations/999999999/mask-postprocess",
        json={"strength": 0.5},
        headers=_headers(token),
    )

    assert response.status_code == 404


def test_reapply_postprocess_404s_for_annotation_without_raw_mask():
    from app.annotation.models import Annotation, AnnotationStatus, AnnotationType
    from app.auth.models import User
    from app.db import SessionLocal

    email = "postprocess-endpoint3@example.com"
    token = _register_and_login(email)
    frame_id = _create_frame(token)
    label_id = _create_label()

    session = SessionLocal()
    user = session.query(User).filter(User.email == email).one()
    annotation = Annotation(
        frame_id=frame_id, label_id=label_id, taxonomy_version=1,
        annotation_type=AnnotationType.MASK, payload={}, status=AnnotationStatus.DRAFT,
        created_by_id=user.id, storage_key="masks/no-raw/mask.png", raw_mask_storage_key=None,
    )
    session.add(annotation)
    session.commit()
    session.refresh(annotation)
    annotation_id = annotation.id
    session.close()

    response = client.patch(
        f"/annotation/annotations/{annotation_id}/mask-postprocess",
        json={"strength": 0.5},
        headers=_headers(token),
    )

    assert response.status_code == 404


def test_reapply_postprocess_rejects_strength_out_of_range():
    email = "postprocess-endpoint4@example.com"
    token = _register_and_login(email)
    frame_id = _create_frame(token)
    label_id = _create_label()

    from app.annotation.models import Annotation, AnnotationStatus, AnnotationType
    from app.auth.models import User
    from app.db import SessionLocal

    raw_key = "masks/postprocess-endpoint-test/raw4.png"
    _upload_raw_mask(raw_key)

    session = SessionLocal()
    user = session.query(User).filter(User.email == email).one()
    annotation = Annotation(
        frame_id=frame_id, label_id=label_id, taxonomy_version=1,
        annotation_type=AnnotationType.MASK, payload={}, status=AnnotationStatus.DRAFT,
        created_by_id=user.id, storage_key=raw_key, raw_mask_storage_key=raw_key,
    )
    session.add(annotation)
    session.commit()
    session.refresh(annotation)
    annotation_id = annotation.id
    session.close()

    response = client.patch(
        f"/annotation/annotations/{annotation_id}/mask-postprocess",
        json={"strength": 1.5},
        headers=_headers(token),
    )

    assert response.status_code == 422


def test_reapply_postprocess_requires_auth():
    response = client.patch(
        "/annotation/annotations/1/mask-postprocess",
        json={"strength": 0.5},
    )
    assert response.status_code == 401
