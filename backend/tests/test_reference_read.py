from datetime import datetime, timezone

import pytest
import app.db as db_module
import app.main  # noqa: F401 -- registers every model on Base.metadata
from fastapi.testclient import TestClient

from app.main import app
from app.media.models import Video
from app.reference.models import ReferenceInterval, VideoReference
from app.taxonomy.models import AnnotationScope, Category, EvaluationType, Label, Procedure

client = TestClient(app)


def _headers(email: str) -> dict[str, str]:
    client.post("/auth/register", json={"email": email, "password": "pass1234", "role": "admin"})
    response = client.post("/auth/login", json={"email": email, "password": "pass1234"})
    return {"Authorization": f"Bearer {response.json()['access_token']}"}


@pytest.fixture
def world():
    """Committed rows in the isolated test database; removed on teardown."""
    session = db_module.SessionLocal()
    created = {"eval": None}
    evaluation_type = (
        session.query(EvaluationType).filter(EvaluationType.name == "frame_classification").first()
    )
    if evaluation_type is None:
        evaluation_type = EvaluationType(
            name="frame_classification", annotation_scope=AnnotationScope.FRAME
        )
        session.add(evaluation_type)
        session.flush()
        created["eval"] = evaluation_type.id
    other_type = EvaluationType(name="ref-other-eval", annotation_scope=AnnotationScope.FRAME)
    session.add(other_type)
    session.flush()

    procedures: list[int] = []
    videos: list[int] = []

    class W:
        pass

    w = W()
    w.session = session
    w.eval_id = evaluation_type.id

    def make_procedure(name: str, axes: dict[str, int]) -> tuple[int, dict[str, list[int]]]:
        procedure = Procedure(name=name)
        session.add(procedure)
        session.flush()
        procedures.append(procedure.id)
        labels: dict[str, list[int]] = {}
        for axis, count in axes.items():
            category = Category(name=axis, procedure_id=procedure.id)
            session.add(category)
            session.flush()
            ids = []
            for i in range(count):
                label = Label(
                    name=f"{axis}-{i}", category_id=category.id, evaluation_type_id=evaluation_type.id
                )
                session.add(label)
                session.flush()
                ids.append(label.id)
            labels[axis] = [category.id, *ids]
        # a category holding only non-classification labels is not an axis
        decoy = Category(name="Decoy", procedure_id=procedure.id)
        session.add(decoy)
        session.flush()
        session.add(Label(name="decoy", category_id=decoy.id, evaluation_type_id=other_type.id))
        session.commit()
        return procedure.id, labels

    def make_video(procedure_id: int | None, duration: float = 12.3456) -> int:
        video = Video(
            storage_key="ref/x.mp4", title="ref", procedure_id=procedure_id,
            duration_seconds=duration, checksum="0" * 64,
        )
        session.add(video)
        session.commit()
        videos.append(video.id)
        return video.id

    w.make_procedure = make_procedure
    w.make_video = make_video
    yield w

    session.rollback()
    session.query(ReferenceInterval).filter(ReferenceInterval.video_id.in_(videos)).delete(
        synchronize_session=False
    )
    session.query(VideoReference).filter(VideoReference.video_id.in_(videos)).delete(
        synchronize_session=False
    )
    session.query(Video).filter(Video.id.in_(videos)).delete(synchronize_session=False)
    cats = [c.id for c in session.query(Category).filter(Category.procedure_id.in_(procedures))]
    session.query(Label).filter(Label.category_id.in_(cats)).delete(synchronize_session=False)
    session.query(Category).filter(Category.id.in_(cats)).delete(synchronize_session=False)
    session.query(Procedure).filter(Procedure.id.in_(procedures)).delete(synchronize_session=False)
    session.query(EvaluationType).filter(EvaluationType.name == "ref-other-eval").delete(
        synchronize_session=False
    )
    if created["eval"] is not None:
        session.query(EvaluationType).filter(EvaluationType.id == created["eval"]).delete(
            synchronize_session=False
        )
    session.commit()
    session.close()


def _get(video_id, email="ref-read@example.com"):
    return client.get(f"/reference/videos/{video_id}", headers=_headers(email))


def _keys(body):
    return [[c["key"] for c in axis["classes"]] for axis in body["axes"]]


def test_keys_run_across_axes_with_zero_as_tenth(world):
    procedure_id, _ = world.make_procedure("ref-colon", {"Anatomy": 8, "Quality": 2})
    body = _get(world.make_video(procedure_id)).json()
    assert [a["name"] for a in body["axes"]] == ["Anatomy", "Quality"]
    assert _keys(body) == [list("12345678"), ["9", "0"]]
    assert body["duration_ms"] == 12346
    assert body["procedure_id"] == procedure_id


def test_classes_after_the_tenth_have_no_key(world):
    procedure_id, _ = world.make_procedure("ref-big", {"Anatomy": 12, "Quality": 2})
    body = _get(world.make_video(procedure_id)).json()
    assert _keys(body) == [list("1234567890") + [None, None], [None, None]]


def test_no_axes_without_classification_labels_or_procedure(world):
    session = world.session
    procedure = Procedure(name="ref-empty")
    session.add(procedure)
    session.commit()
    try:
        assert _get(world.make_video(procedure.id)).json()["axes"] == []
        assert _get(world.make_video(None)).json()["axes"] == []
    finally:
        session.query(Video).filter(Video.procedure_id == procedure.id).delete()
        session.query(Procedure).filter(Procedure.id == procedure.id).delete()
        session.commit()


def test_status_none_clean_compromised(world):
    procedure_id, labels = world.make_procedure("ref-status", {"Anatomy": 2})
    video_id = world.make_video(procedure_id)
    assert _get(video_id).json()["status"] == "none"
    session = world.session
    category_id, label_id = labels["Anatomy"][0], labels["Anatomy"][1]
    session.add(ReferenceInterval(
        video_id=video_id, category_id=category_id, label_id=label_id,
        taxonomy_version=1, start_ms=0, end_ms=500, created_by_id=_user_id(),
    ))
    session.commit()
    body = _get(video_id).json()
    assert body["status"] == "clean"
    assert body["compromised_at"] is None
    assert body["intervals"][0]["orphaned"] is False
    session.add(VideoReference(
        video_id=video_id, compromised_at=datetime.now(timezone.utc),
        compromised_by_training_run_id=77,
    ))
    session.commit()
    body = _get(video_id).json()
    assert body["status"] == "compromised"
    assert body["compromised_by_training_run_id"] == 77
    assert body["compromised_at"] is not None


def _user_id() -> int:
    from app.auth.models import User

    session = db_module.SessionLocal()
    try:
        return session.query(User).filter(User.email == "ref-read@example.com").one().id
    finally:
        session.close()


def test_intervals_ordered_and_moved_label_is_orphaned(world):
    procedure_id, labels = world.make_procedure("ref-orphan", {"Anatomy": 2, "Quality": 2})
    video_id = world.make_video(procedure_id)
    _headers("ref-read@example.com")
    uid = _user_id()
    session = world.session
    a_cat, a_label = labels["Anatomy"][0], labels["Anatomy"][1]
    q_cat, q_label = labels["Quality"][0], labels["Quality"][1]
    for cat, lab, start in ((q_cat, q_label, 0), (a_cat, a_label, 900), (a_cat, a_label, 100)):
        session.add(ReferenceInterval(
            video_id=video_id, category_id=cat, label_id=lab, taxonomy_version=1,
            start_ms=start, end_ms=start + 200, created_by_id=uid,
        ))
    session.commit()
    body = _get(video_id).json()
    assert [(i["category_id"], i["start_ms"]) for i in body["intervals"]] == [
        (a_cat, 100), (a_cat, 900), (q_cat, 0),
    ]
    assert not any(i["orphaned"] for i in body["intervals"])

    session.query(Label).filter(Label.id == a_label).update({"category_id": q_cat})
    session.commit()
    body = _get(video_id).json()
    assert [i["orphaned"] for i in body["intervals"]] == [True, True, False]


def test_unknown_video_is_404():
    assert _get(999999).status_code == 404


def test_label_whose_evaluation_type_changed_is_orphaned(world):
    procedure_id, labels = world.make_procedure("ref-orphan-eval", {"Anatomy": 2})
    video_id = world.make_video(procedure_id)
    _headers("ref-read@example.com")
    uid = _user_id()
    session = world.session
    cat, first, second = labels["Anatomy"]
    for lab, start in ((first, 0), (second, 1000)):
        session.add(ReferenceInterval(
            video_id=video_id, category_id=cat, label_id=lab, taxonomy_version=1,
            start_ms=start, end_ms=start + 200, created_by_id=uid,
        ))
    session.commit()
    other = session.query(EvaluationType).filter(EvaluationType.name == "ref-other-eval").one()
    session.query(Label).filter(Label.id == first).update({"evaluation_type_id": other.id})
    session.commit()
    body = _get(video_id).json()
    assert [a["category_id"] for a in body["axes"]] == [cat]
    assert [i["orphaned"] for i in body["intervals"]] == [True, False]
