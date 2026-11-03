import threading

import app.db as db_module
import pytest
from fastapi.testclient import TestClient

from app.auth.models import User
from app.main import app
from app.media.models import Video
from app.reference import service
from app.reference.models import ReferenceInterval, VideoReference
from app.reference.schemas import IntervalCreate
from app.taxonomy.models import Label

from tests.test_reference_read import _headers, world  # noqa: F401

client = TestClient(app)
EMAIL = "ref-intervals@example.com"
DURATION = 12.3456  # 12346 ms


@pytest.fixture
def setup(world):  # noqa: F811
    procedure_id, labels = world.make_procedure("ref-iv", {"Anatomy": 2, "Quality": 2})
    video_id = world.make_video(procedure_id)
    headers = _headers(EMAIL)
    yield world, video_id, labels, headers
    session = db_module.SessionLocal()
    user_ids = [u.id for u in session.query(User).filter(User.email == EMAIL)]
    session.query(ReferenceInterval).filter(ReferenceInterval.created_by_id.in_(user_ids)).delete(
        synchronize_session=False
    )
    session.query(User).filter(User.id.in_(user_ids)).delete(synchronize_session=False)
    session.commit()
    session.close()


def _post(video_id, headers, label_id, start, end):
    return client.post(
        f"/reference/videos/{video_id}/intervals",
        json={"label_id": label_id, "start_ms": start, "end_ms": end},
        headers=headers,
    )


def test_create_copies_version_and_creates_video_reference(setup):
    world, video_id, labels, headers = setup
    cat, lab = labels["Anatomy"][0], labels["Anatomy"][1]
    session = world.session
    session.query(Label).filter(Label.id == lab).update({"taxonomy_version": 3})
    session.commit()
    assert session.get(VideoReference, video_id) is None
    r = _post(video_id, headers, lab, 0, 500)
    assert r.status_code == 201
    body = r.json()
    assert body["category_id"] == cat and body["label_id"] == lab
    assert body["taxonomy_version"] == 3
    assert body["orphaned"] is False
    assert (body["start_ms"], body["end_ms"]) == (0, 500)
    session.expire_all()
    assert session.get(VideoReference, video_id) is not None
    assert _post(video_id, headers, lab, 600, 900).status_code == 201


def test_label_of_other_procedure_or_not_classification_is_422(setup):
    world, video_id, labels, headers = setup
    _, other_labels = world.make_procedure("ref-iv-other", {"X": 1})
    other = other_labels["X"][1]
    assert _post(video_id, headers, other, 0, 500).status_code == 422
    decoy = world.session.query(Label).filter(Label.name == "decoy").first().id
    assert _post(video_id, headers, decoy, 0, 500).status_code == 422
    assert _post(video_id, headers, 99999999, 0, 500).status_code == 422


@pytest.mark.parametrize(
    "start,end", [(500, 500), (600, 500), (0, 99), (-1, 500), (0, 12347)]
)
def test_invalid_spans_are_422(setup, start, end):
    _, video_id, labels, headers = setup
    assert _post(video_id, headers, labels["Anatomy"][1], start, end).status_code == 422


def test_boundary_spans_are_accepted(setup):
    _, video_id, labels, headers = setup
    lab = labels["Anatomy"][1]
    assert _post(video_id, headers, lab, 0, 100).status_code == 201
    assert _post(video_id, headers, lab, 12246, 12346).status_code == 201


def test_overlap_409_touching_201_other_category_ok(setup):
    _, video_id, labels, headers = setup
    a1, a2 = labels["Anatomy"][1], labels["Anatomy"][2]
    q1 = labels["Quality"][1]
    assert _post(video_id, headers, a1, 1000, 2000).status_code == 201
    assert _post(video_id, headers, a2, 1500, 2500).status_code == 409
    assert _post(video_id, headers, a2, 900, 1001).status_code == 409
    assert _post(video_id, headers, a2, 2000, 3000).status_code == 201
    assert _post(video_id, headers, a2, 0, 1000).status_code == 201
    assert _post(video_id, headers, q1, 1500, 2500).status_code == 201


def test_patch_edges_and_relabel(setup):
    _, video_id, labels, headers = setup
    a1, a2 = labels["Anatomy"][1], labels["Anatomy"][2]
    q1 = labels["Quality"][1]
    first = _post(video_id, headers, a1, 0, 1000).json()
    second = _post(video_id, headers, a1, 1000, 2000).json()
    url = f"/reference/videos/{video_id}/intervals/{second['id']}"
    assert client.patch(url, json={"start_ms": 900}, headers=headers).status_code == 409
    moved = client.patch(url, json={"start_ms": 1100}, headers=headers)
    assert moved.status_code == 200 and moved.json()["start_ms"] == 1100
    relabeled = client.patch(url, json={"label_id": a2}, headers=headers)
    assert relabeled.status_code == 200 and relabeled.json()["label_id"] == a2
    assert client.patch(url, json={"label_id": q1}, headers=headers).status_code == 422
    assert client.patch(url, json={"end_ms": 1100}, headers=headers).status_code == 422
    assert client.patch(url, json={"end_ms": 99999}, headers=headers).status_code == 422
    assert client.patch(url, json={}, headers=headers).status_code == 422
    # an interval does not conflict with itself
    assert client.patch(url, json={"end_ms": 2100}, headers=headers).status_code == 200
    assert first["id"] != second["id"]


def test_delete_frees_the_span(setup):
    _, video_id, labels, headers = setup
    a1 = labels["Anatomy"][1]
    iv = _post(video_id, headers, a1, 0, 1000).json()
    url = f"/reference/videos/{video_id}/intervals/{iv['id']}"
    assert client.delete(url, headers=headers).status_code == 204
    assert client.delete(url, headers=headers).status_code == 404
    assert _post(video_id, headers, a1, 0, 1000).status_code == 201


def test_unknown_video_and_interval_404(setup):
    _, video_id, labels, headers = setup
    a1 = labels["Anatomy"][1]
    assert _post(999999, headers, a1, 0, 500).status_code == 404
    assert client.patch(
        f"/reference/videos/{video_id}/intervals/999999", json={"start_ms": 1}, headers=headers
    ).status_code == 404
    assert client.delete(
        f"/reference/videos/{video_id}/intervals/999999", headers=headers
    ).status_code == 404
    assert client.delete(
        f"/reference/videos/999999/intervals/1", headers=headers
    ).status_code == 404


def test_interval_of_another_video_is_404(setup):
    world, video_id, labels, headers = setup
    other = world.make_video(world.session.get(Video, video_id).procedure_id)
    iv = _post(other, headers, labels["Anatomy"][1], 0, 500).json()
    url = f"/reference/videos/{video_id}/intervals/{iv['id']}"
    assert client.delete(url, headers=headers).status_code == 404


def test_concurrent_overlapping_creates_yield_one_winner(setup):
    _, video_id, labels, headers = setup
    a1, a2 = labels["Anatomy"][1], labels["Anatomy"][2]
    session = db_module.SessionLocal()
    user = session.query(User).filter(User.email == EMAIL).one()
    session.close()
    barrier = threading.Barrier(2)
    results: list[str] = []

    def worker(label_id):
        s = db_module.SessionLocal()
        try:
            barrier.wait()
            service.create_interval(
                s, video_id, IntervalCreate(label_id=label_id, start_ms=1000, end_ms=2000), user
            )
            results.append("ok")
        except service.IntervalOverlap:
            results.append("overlap")
        finally:
            s.close()

    threads = [threading.Thread(target=worker, args=(lab,)) for lab in (a1, a2)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    assert sorted(results) == ["ok", "overlap"]


def test_patch_of_orphaned_interval_reports_orphaned(setup):
    world, video_id, labels, headers = setup
    a_cat, a_lab = labels["Anatomy"][0], labels["Anatomy"][1]
    q_cat = labels["Quality"][0]
    created = _post(video_id, headers, a_lab, 0, 500).json()
    session = world.session
    session.query(Label).filter(Label.id == a_lab).update({"category_id": q_cat})
    session.commit()
    r = client.patch(
        f"/reference/videos/{video_id}/intervals/{created['id']}",
        json={"end_ms": 600},
        headers=headers,
    )
    assert r.status_code == 200
    assert r.json()["orphaned"] is True
    session.query(Label).filter(Label.id == a_lab).update({"category_id": a_cat})
    session.commit()
