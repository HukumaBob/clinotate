import pytest
from sqlalchemy import create_engine, text
from sqlalchemy.orm import sessionmaker

import app.db as db_module
from app.config import get_settings
from app.db import Base


@pytest.fixture(scope="session")
def test_engine():
    settings = get_settings()
    test_db_url = settings.database_url.rsplit("/", 1)[0] + "/endoscopy_test"
    engine = create_engine(test_db_url)
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
                "INSERT INTO platform_settings (id, max_track_range_frames, mask_postprocess_strength) "
                "VALUES (1, 10, 0.3) ON CONFLICT (id) DO NOTHING"
            )
        )
    yield engine
    Base.metadata.drop_all(engine)


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
