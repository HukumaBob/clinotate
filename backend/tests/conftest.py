import pytest
from sqlalchemy import create_engine
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
    yield engine
    Base.metadata.drop_all(engine)


@pytest.fixture
def db_session(test_engine):
    connection = test_engine.connect()
    transaction = connection.begin()
    SessionForTest = sessionmaker(bind=connection)
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
