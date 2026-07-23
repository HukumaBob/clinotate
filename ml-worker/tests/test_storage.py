import os

import pytest

os.environ.setdefault("POSTGRES_USER", "endoscopy")
os.environ.setdefault("POSTGRES_PASSWORD", "endoscopy_dev_password")
os.environ.setdefault("POSTGRES_DB", "endoscopy")
os.environ.setdefault("POSTGRES_HOST", "localhost")
os.environ.setdefault("MINIO_ENDPOINT", "localhost:9000")
os.environ.setdefault("MINIO_ACCESS_KEY", "endoscopy_dev")
os.environ.setdefault("MINIO_SECRET_KEY", "endoscopy_dev_secret")
os.environ.setdefault("MINIO_BUCKET", "endoscopy-media")
os.environ.setdefault("HF_TOKEN", "unused-in-this-test")

from app.storage import StorageService
from app.config import get_worker_settings


@pytest.fixture
def storage():
    service = StorageService(get_worker_settings())
    service.ensure_bucket()
    return service


def test_worker_storage_roundtrips_bytes(storage):
    key = "test/worker-roundtrip.bin"
    storage.upload(key, b"worker hello", content_type="application/octet-stream")

    result = storage.download(key)

    assert result == b"worker hello"
