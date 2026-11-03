import uuid

import app.db as db_module
import pytest
from fastapi.testclient import TestClient

from app.auth.models import User
from app.datasets.models import TaskType
from app.main import app
from app.media.models import Frame, Sequence
from app.reference.models import ReferenceInterval, VideoReference

from tests.test_reference_read import _headers, world  # noqa: F401

client = TestClient(app)
EMAIL = "ref-guards@example.com"


@pytest.fixture
def setup(world):  # noqa: F811
    procedure_id, labels = world.make_procedure("ref-guards", {"Anatomy": 2})
    headers = _headers(EMAIL)
    session = world.session
    user = session.query(User).filter(User.email == EMAIL).one()
    world.user_id = user.id
    world.sequences = []
    yield world, procedure_id, labels, headers
    session.rollback()
    session.query(Frame).filter(Frame.sequence_id.in_(world.sequences)).delete(
        synchronize_session=False
    )
    session.query(Sequence).filter(Sequence.id.in_(world.sequences)).delete(
        synchronize_session=False
    )
    session.query(ReferenceInterval).filter(ReferenceInterval.created_by_id == user.id).delete(
        synchronize_session=False
    )
    session.commit()
    session.query(User).filter(User.id == user.id).delete(synchronize_session=False)
    session.commit()


def _add_interval(world, video_id, labels):
    session = world.session
    if session.get(VideoReference, video_id) is None:
        session.add(VideoReference(video_id=video_id))
    interval = ReferenceInterval(
        video_id=video_id, category_id=labels["Anatomy"][0], label_id=labels["Anatomy"][1],
        taxonomy_version=1, start_ms=0, end_ms=500, created_by_id=world.user_id,
    )
    session.add(interval)
    session.commit()
    return interval.id


def test_video_with_reference_cannot_be_deleted_until_intervals_are(setup):
    world, procedure_id, labels, headers = setup
    video_id = world.make_video(procedure_id)
    interval_id = _add_interval(world, video_id, labels)

    response = client.delete(f"/media/videos/{video_id}", headers=headers)
    assert response.status_code == 409
    assert response.json()["detail"] == (
        "This video still has a reference: delete its intervals first"
    )

    done = client.delete(f"/reference/videos/{video_id}/intervals/{interval_id}", headers=headers)
    assert done.status_code == 204
    assert client.delete(f"/media/videos/{video_id}", headers=headers).status_code == 204
    world.session.expire_all()
    assert world.session.get(VideoReference, video_id) is None


def test_label_with_reference_interval_cannot_be_deleted(setup):
    world, procedure_id, labels, headers = setup
    video_id = world.make_video(procedure_id)
    _add_interval(world, video_id, labels)

    response = client.delete(f"/taxonomy/labels/{labels['Anatomy'][1]}", headers=headers)
    assert response.status_code == 409
    detail = response.json()["detail"]
    assert "reference" in detail.lower()
    assert "annotations referencing" not in detail

    free = client.delete(f"/taxonomy/labels/{labels['Anatomy'][2]}", headers=headers)
    assert free.status_code == 204


def _clean_sequence(world, procedure_id, labels):
    video_id = world.make_video(procedure_id)
    _add_interval(world, video_id, labels)
    session = world.session
    seq = Sequence(video_id=video_id, procedure_id=procedure_id, name="s")
    session.add(seq)
    session.flush()
    session.add(Frame(sequence_id=seq.id, storage_key=f"ref/{uuid.uuid4()}", frame_index=0,
                      width=1, height=1))
    session.commit()
    world.sequences.append(seq.id)
    return video_id, seq.id


def test_balance_reports_reference_exposure_for_classification_only(setup):
    world, procedure_id, labels, headers = setup
    video_id, seq_id = _clean_sequence(world, procedure_id, labels)

    cls = client.post(
        "/datasets/balance",
        json={"sequence_ids": [seq_id], "task_type": TaskType.CLASSIFICATION.value},
        headers=headers,
    )
    assert cls.status_code == 200
    assert [e["video_id"] for e in cls.json()["reference_exposure"]] == [video_id]
    assert cls.json()["reference_exposure"][0]["frames"] == 1

    det = client.post(
        "/datasets/balance",
        json={"sequence_ids": [seq_id], "task_type": TaskType.DETECTION.value},
        headers=headers,
    )
    assert det.status_code == 200
    assert det.json()["reference_exposure"] == []
