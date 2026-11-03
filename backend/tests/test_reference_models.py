import pytest
from sqlalchemy.exc import IntegrityError

import app.main  # noqa: F401 -- registers every model on Base.metadata
from app.auth.models import User, UserRole
from app.media.models import Video
from app.reference.models import ReferenceInterval, VideoReference
from app.taxonomy.models import AnnotationScope, Category, EvaluationType, Label, Procedure


def _seed(session):
    user = User(email="reference-model@example.com", hashed_password="x", role=UserRole.ADMIN)
    procedure = Procedure(name="reference-model-proc")
    session.add_all([user, procedure])
    session.flush()
    video = Video(
        storage_key="videos/reference-model.mp4",
        title="reference-model",
        checksum="c" * 64,
    )
    category = Category(name="Anatomy", procedure_id=procedure.id)
    evaluation = EvaluationType(name="reference-model-eval", annotation_scope=AnnotationScope.FRAME)
    session.add_all([video, category, evaluation])
    session.flush()
    label = Label(
        name="Cecum",
        category_id=category.id,
        evaluation_type_id=evaluation.id,
        taxonomy_version=3,
    )
    session.add(label)
    session.flush()
    return user, video, category, label


def test_a_reference_interval_round_trips(db_session):
    user, video, category, label = _seed(db_session)
    interval = ReferenceInterval(
        video_id=video.id,
        category_id=category.id,
        label_id=label.id,
        taxonomy_version=3,
        start_ms=1000,
        end_ms=4500,
        created_by_id=user.id,
    )
    reference = VideoReference(video_id=video.id)
    db_session.add_all([interval, reference])
    db_session.flush()
    db_session.expire_all()

    loaded = db_session.get(ReferenceInterval, interval.id)
    assert (loaded.video_id, loaded.category_id, loaded.label_id) == (
        video.id,
        category.id,
        label.id,
    )
    assert (loaded.taxonomy_version, loaded.start_ms, loaded.end_ms) == (3, 1000, 4500)
    assert loaded.created_by_id == user.id
    assert loaded.created_at.tzinfo is not None
    assert loaded.updated_at.tzinfo is not None

    ref = db_session.get(VideoReference, video.id)
    assert ref.compromised_at is None
    assert ref.compromised_by_training_run_id is None

    # The origin of a compromise must outlive the run: no foreign key.
    ref.compromised_by_training_run_id = 987654
    db_session.flush()

    loaded.end_ms = 5000
    db_session.flush()
    assert loaded.end_ms == 5000

    with pytest.raises(IntegrityError):
        with db_session.begin_nested():
            db_session.delete(video)
            db_session.flush()
