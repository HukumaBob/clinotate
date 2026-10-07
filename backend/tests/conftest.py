import pytest
from sqlalchemy import create_engine, text
from sqlalchemy.orm import sessionmaker

import app.db as db_module
from app.config import get_settings
from app.db import Base


def _assert_test_database_url(url: str) -> None:
    """Hard safety guard: every raw-DDL teardown helper in this file must
    call this before touching the database. `endoscopy_test` is disposable;
    `endoscopy` holds real clinical data (annotations, labels, taxonomy).
    A bug here must fail loudly instead of ever risking the real database.
    """
    if not url.endswith("/endoscopy_test"):
        raise RuntimeError(
            f"Refusing to run destructive schema DDL against non-test database URL: {url!r}. "
            "Expected it to end with '/endoscopy_test'."
        )


def _reset_schema(engine, url: str) -> None:
    """Hard reset: drop and recreate the `public` schema.

    `Base.metadata.drop_all()` drops tables in dependency order it infers
    from the ORM's FK graph, but that inference has repeatedly fallen out
    of sync with the real schema (e.g. `datasets`/`dataset_items` added FKs
    to `labels`/`frames`/`users` after `drop_all` order was last correct),
    causing `DependentObjectsStillExist` and leaving a half-dropped schema
    that poisons every subsequent test run. Dropping the whole schema
    sidesteps table-level ordering entirely -- CASCADE semantics are
    implicit when the schema itself is dropped.
    """
    _assert_test_database_url(url)
    with engine.begin() as connection:
        connection.execute(text("DROP SCHEMA public CASCADE"))
        connection.execute(text("CREATE SCHEMA public"))


@pytest.fixture(scope="session")
def test_engine():
    settings = get_settings()
    test_db_url = settings.database_url.rsplit("/", 1)[0] + "/endoscopy_test"
    _assert_test_database_url(test_db_url)
    engine = create_engine(test_db_url)
    # Defensive: a prior run's teardown may have failed midway (e.g. after
    # a schema change made `drop_all`'s dependency ordering stale) and left
    # a half-dropped schema behind. Reset unconditionally before creating
    # tables so a dirty state can never poison this run's setup.
    _reset_schema(engine, test_db_url)
    Base.metadata.create_all(engine)
    # `create_all` builds tables from the ORM models, not from Alembic
    # migrations -- so data-seeding migrations (e.g. the
    # `platform_settings` singleton row inserted by
    # 65dffec667fb_add_platform_settings_table) never run against this
    # database. Re-seed by hand for any table whose app code relies on a
    # pre-existing row rather than creating one on demand.
    with engine.begin() as connection:
        connection.execute(
            text(
                "INSERT INTO platform_settings "
                "(id, max_track_range_frames, mask_postprocess_strength, min_mask_area_fraction) "
                "VALUES (1, 10, 0.3, 0.0005) ON CONFLICT (id) DO NOTHING"
            )
        )
    yield engine
    # Reset (not drop_all) for the same reason as above: drop_all's
    # inferred ordering is not guaranteed to stay valid as FKs are added,
    # and a failure here would otherwise poison every future run.
    _reset_schema(engine, test_db_url)


@pytest.fixture
def db_session(test_engine):
    connection = test_engine.connect()
    transaction = connection.begin()
    # join_transaction_mode="create_savepoint": without this, a
    # session.commit() issued by code under test (e.g. a Celery task body
    # patched to reuse this exact session) is nested directly inside the
    # fixture's own outer `transaction`, so a later session.rollback() --
    # e.g. a task's `except: session.rollback()` error-handling path --
    # rolls back past that "committed" data too, not just the failed
    # unit of work. Using a real SAVEPOINT means session.commit() releases
    # the savepoint (durable within the outer transaction) and
    # session.rollback() only undoes back to the next savepoint boundary.
    # The fixture's own final `transaction.rollback()` still discards
    # everything at test teardown either way.
    SessionForTest = sessionmaker(bind=connection, join_transaction_mode="create_savepoint")
    session = SessionForTest()
    yield session
    session.close()
    transaction.rollback()
    connection.close()


@pytest.fixture(scope="session", autouse=True)
def _route_app_db_sessions_to_the_test_database(test_engine):
    """Points `app.db`'s module-level `engine`/`SessionLocal` at
    `endoscopy_test` instead of the real `endoscopy` database, for the
    whole test session.

    Several test modules construct `TestClient(app)` directly (so FastAPI's
    `Depends(get_session)` resolves through `app.db.SessionLocal`) AND
    separately import `from app.db import SessionLocal` to manipulate rows
    directly within the same test — both call sites must resolve to the
    same engine for a test to see its own setup. Overriding only
    `app.dependency_overrides` would fix the first call site but not the
    second, leaving the two path out of sync. Patching `app.db`'s globals
    directly fixes both, since every consumer resolves the same module
    attributes at call time (`app.db.SessionLocal()`), not a copy captured
    at import time.
    """
    original_engine = db_module.engine
    original_session_local = db_module.SessionLocal

    db_module.engine = test_engine
    db_module.SessionLocal = sessionmaker(bind=test_engine, autoflush=False, autocommit=False)

    yield

    db_module.engine = original_engine
    db_module.SessionLocal = original_session_local


@pytest.fixture
def committed_inference_rows():
    """Committed rows the inference API tests need, deleted afterwards.

    TestClient requests run on their own sessions, so rows seeded through
    the rolled-back `db_session` would be invisible to them. Everything
    here is deleted in teardown, children before parents.
    """
    from types import SimpleNamespace

    from app.auth.models import User, UserRole
    from app.datasets.models import Dataset, TaskType
    from app.inference.models import InferenceRun
    from app.jobs.models import Job
    from app.media.models import Video
    from app.training.models import ModelVersion, TrainingRun

    session = db_module.SessionLocal()
    user = User(email="inference-seed@example.com", hashed_password="x", role=UserRole.ADMIN)
    session.add(user)
    session.commit()
    dataset = Dataset(
        name="ds-inference-seed",
        task_type=TaskType.DETECTION,
        taxonomy_version=1,
        split_config={"train": 80, "val": 20},
        grouping_overrides={},
        excluded_label_ids=[],
        balance_metrics={},
        created_by_id=user.id,
    )
    session.add(dataset)
    session.commit()

    def _video(title: str, playable: bool | None) -> Video:
        video = Video(
            storage_key=f"videos/{title}.mp4",
            filename=f"{title}.mp4",
            title=title,
            fps=25.0,
            duration_seconds=10.0,
            size_bytes=1,
            checksum=title,
            browser_playable=playable,
        )
        session.add(video)
        return video

    playable = _video("inference-playable", True)
    unplayable = _video("inference-unplayable", False)

    training_run_ids: list[int] = []

    def _version(task_type: TaskType) -> ModelVersion:
        run = TrainingRun(
            dataset_id=dataset.id,
            adapter="ultralytics_yolo",
            base_model="yolo11n.pt",
            task_type=task_type,
            config={},
            total_epochs=1,
            created_by_id=user.id,
        )
        session.add(run)
        session.commit()
        training_run_ids.append(run.id)
        version = ModelVersion(
            training_run_id=run.id,
            name=f"seed-{task_type.value}",
            task_type=task_type,
            storage_key=f"models/{run.id}/best.pt",
        )
        session.add(version)
        return version

    detect = _version(TaskType.DETECTION)
    segment = _version(TaskType.SEGMENTATION)
    classify = _version(TaskType.CLASSIFICATION)
    session.commit()

    rows = SimpleNamespace(
        user_id=user.id,
        video_id=playable.id,
        playable_video_id=playable.id,
        unplayable_video_id=unplayable.id,
        detect_version_id=detect.id,
        segment_version_id=segment.id,
        classify_version_id=classify.id,
    )
    dataset_id = dataset.id
    yield rows

    # Plain ints captured above: the test may have deleted ORM rows (e.g. a
    # ModelVersion), and touching an expired deleted instance would raise.
    session.rollback()
    video_ids = [rows.playable_video_id, rows.unplayable_video_id]
    runs = session.query(InferenceRun).filter(InferenceRun.video_id.in_(video_ids)).all()
    job_ids = [run.job_id for run in runs if run.job_id is not None]
    session.query(InferenceRun).filter(InferenceRun.video_id.in_(video_ids)).delete(
        synchronize_session=False
    )
    if job_ids:
        session.query(Job).filter(Job.id.in_(job_ids)).delete(synchronize_session=False)
    session.query(ModelVersion).filter(
        ModelVersion.id.in_(
            [rows.detect_version_id, rows.segment_version_id, rows.classify_version_id]
        )
    ).delete(synchronize_session=False)
    session.query(TrainingRun).filter(TrainingRun.id.in_(training_run_ids)).delete(
        synchronize_session=False
    )
    from app.media.models import Frame, Sequence

    sequence_ids = [
        row[0] for row in session.query(Sequence.id).filter(Sequence.video_id.in_(video_ids)).all()
    ]
    if sequence_ids:
        session.query(Frame).filter(Frame.sequence_id.in_(sequence_ids)).delete(
            synchronize_session=False
        )
        session.query(Sequence).filter(Sequence.id.in_(sequence_ids)).delete(
            synchronize_session=False
        )
    session.query(Video).filter(Video.id.in_(video_ids)).delete(synchronize_session=False)
    session.query(Dataset).filter(Dataset.id == dataset_id).delete()
    session.query(User).filter(User.id == rows.user_id).delete()
    session.commit()
    session.close()
