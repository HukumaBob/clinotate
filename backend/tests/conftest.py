import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

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
