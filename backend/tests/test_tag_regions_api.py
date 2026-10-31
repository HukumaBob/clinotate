import uuid

import pytest
from fastapi.testclient import TestClient

import app.db as db_module
from app.annotation.models import Annotation, AnnotationStatus, AnnotationType
from app.auth.models import User
from app.main import app
from app.media.models import Frame, Sequence, Video
from app.storage import get_storage_service
from app.taxonomy.models import Category, EvaluationType, Label, Procedure
from tests.tag_regions_helpers import FakeStorage, add_region, build_world

client = TestClient(app)


def _headers() -> dict[str, str]:
    email = f"tag-regions-api-{uuid.uuid4().hex[:8]}@example.com"
    client.post("/auth/register", json={"email": email, "password": "pass1234", "role": "annotator"})
    token = client.post("/auth/login", json={"email": email, "password": "pass1234"}).json()[
        "access_token"
    ]
    return {"Authorization": f"Bearer {token}"}


@pytest.fixture()
def api_world():
    storage = FakeStorage()
    app.dependency_overrides[get_storage_service] = lambda: storage
    session = db_module.SessionLocal()
    world = build_world(session)
    world.storage = storage
    world.session = session
    yield world
    app.dependency_overrides.pop(get_storage_service, None)
    session.rollback()
    frame_ids = [f.id for f in world.frames_a + world.frames_b]
    annotations = session.query(Annotation).filter(Annotation.frame_id.in_(frame_ids))
    # Copies (with a source link) before the annotations they point at.
    annotations.filter(Annotation.source_annotation_id.isnot(None)).delete(
        synchronize_session=False
    )
    annotations.delete(synchronize_session=False)
    session.query(Frame).filter(Frame.id.in_(frame_ids)).delete(synchronize_session=False)
    session.query(Sequence).filter(
        Sequence.id.in_([world.sequence_a.id, world.sequence_b.id])
    ).delete(synchronize_session=False)
    session.query(Video).filter(Video.id == world.sequence_a.video_id).delete()
    session.query(Label).filter(Label.category_id == world.category.id).filter(
        Label.parent_label_id.isnot(None)
    ).delete(synchronize_session=False)
    session.query(Label).filter(Label.category_id == world.category.id).delete(
        synchronize_session=False
    )
    session.query(Category).filter(Category.id == world.category.id).delete()
    session.query(EvaluationType).filter(
        EvaluationType.id.in_(
            [world.geometric.id, world.morphological.id, world.frame_scope.id]
        )
    ).delete(synchronize_session=False)
    session.query(Procedure).filter(Procedure.id == world.procedure.id).delete()
    session.query(User).filter(User.id == world.user.id).delete()
    session.commit()
    session.close()


def _frame_ids(world):
    return [f.id for f in world.frames_a]


def test_region_labels_endpoint(api_world):
    w = api_world
    add_region(w.session, w.storage, w.frames_a[0], w.polyp_ip, w.user)
    add_region(w.session, w.storage, w.frames_a[1], w.polyp, w.user, AnnotationType.BBOX)
    response = client.post(
        "/annotation/frames/region-labels", json={"frame_ids": _frame_ids(w)}, headers=_headers()
    )
    assert response.status_code == 200
    by_name = {r["name"]: r for r in response.json()}
    assert by_name["polyp"]["count"] == 2
    assert by_name["polyp_ip"]["count"] == 1
    assert set(by_name["polyp"]) == {"label_id", "name", "count", "category_name"}


def test_tag_regions_dry_run_then_create_round_trip(api_world):
    w = api_world
    headers = _headers()
    add_region(w.session, w.storage, w.frames_a[0], w.polyp, w.user)
    add_region(w.session, w.storage, w.frames_a[1], w.polyp, w.user, AnnotationType.BBOX)
    body = {
        "frame_ids": _frame_ids(w),
        "source_label_id": w.polyp.id,
        "target_label_id": w.adenoma.id,
    }
    dry = client.post(
        "/annotation/frames/tag-regions", json={**body, "dry_run": True}, headers=headers
    )
    assert dry.status_code == 200
    assert dry.json()["dry_run"] is True
    assert dry.json()["regions"] == 2
    assert w.session.query(Annotation).filter_by(label_id=w.adenoma.id).count() == 0

    created = client.post("/annotation/frames/tag-regions", json=body, headers=headers)
    assert created.status_code == 200
    for key in ("regions", "frames", "skipped_already_copied", "frames_with_manual_regions",
                "skipped_manual_frames", "already_copied_label_names"):
        assert created.json()[key] == dry.json()[key]
    assert created.json()["dry_run"] is False

    listed = client.get(f"/annotation/frames/{w.frames_a[0].id}/annotations", headers=headers)
    assert listed.status_code == 200
    assert w.adenoma.id in {a["label_id"] for a in listed.json()}


def test_tag_regions_validation_returns_422(api_world):
    w = api_world
    headers = _headers()
    ok = {"source_label_id": w.polyp.id, "target_label_id": w.adenoma.id}
    assert client.post(
        "/annotation/frames/tag-regions", json={**ok, "frame_ids": []}, headers=headers
    ).status_code == 422
    assert client.post(
        "/annotation/frames/tag-regions",
        json={"frame_ids": _frame_ids(w), "source_label_id": w.polyp.id,
              "target_label_id": w.polyp.id},
        headers=headers,
    ).status_code == 422
    assert client.post(
        "/annotation/frames/tag-regions",
        json={**ok, "frame_ids": [w.frames_a[0].id, w.frames_b[0].id]},
        headers=headers,
    ).status_code == 422
    assert client.post(
        "/annotation/frames/region-labels", json={"frame_ids": []}, headers=headers
    ).status_code == 422
    assert client.post(
        "/annotation/frames/remove-region-copies",
        json={"frame_ids": [], "target_label_id": w.adenoma.id},
        headers=headers,
    ).status_code == 422


def test_remove_copies_endpoint(api_world):
    w = api_world
    headers = _headers()
    source = add_region(w.session, w.storage, w.frames_a[0], w.polyp, w.user)
    add_region(
        w.session, w.storage, w.frames_a[0], w.adenoma, w.user, source_annotation_id=source.id
    )
    reviewed_src = add_region(w.session, w.storage, w.frames_a[1], w.polyp, w.user)
    add_region(
        w.session, w.storage, w.frames_a[1], w.adenoma, w.user,
        status=AnnotationStatus.REVIEWED, source_annotation_id=reviewed_src.id,
    )
    body = {"frame_ids": _frame_ids(w), "target_label_id": w.adenoma.id}
    dry = client.post(
        "/annotation/frames/remove-region-copies", json={**body, "dry_run": True}, headers=headers
    )
    assert dry.json() == {"dry_run": True, "removed": 1, "kept_reviewed": 1}
    done = client.post("/annotation/frames/remove-region-copies", json=body, headers=headers)
    assert done.status_code == 200
    assert done.json() == {"dry_run": False, "removed": 1, "kept_reviewed": 1}
    w.session.expire_all()
    assert w.session.query(Annotation).filter_by(label_id=w.adenoma.id).count() == 1


def test_endpoints_require_auth(api_world):
    w = api_world
    for path, body in (
        ("region-labels", {"frame_ids": [w.frames_a[0].id]}),
        ("tag-regions", {"frame_ids": [w.frames_a[0].id], "source_label_id": 1,
                         "target_label_id": 2}),
        ("remove-region-copies", {"frame_ids": [w.frames_a[0].id], "target_label_id": 2}),
    ):
        assert client.post(f"/annotation/frames/{path}", json=body).status_code == 401
