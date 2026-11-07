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


def test_download_to_file_streams_to_disk_without_reading_into_memory(tmp_path):
    """Large dataset archives must reach disk through boto3's streaming
    download_file, never through a bytes object held for the whole job."""
    calls = []

    class FakeClient:
        def download_file(self, bucket, key, filename):
            calls.append((bucket, key, filename))
            with open(filename, "wb") as fh:
                fh.write(b"streamed")

        def get_object(self, **kwargs):  # pragma: no cover - must not be used
            raise AssertionError("download_to_file must not call get_object")

    service = StorageService.__new__(StorageService)
    service._bucket = "bucket"
    service._client = FakeClient()
    target = tmp_path / "out.zip"

    service.download_to_file("some/key.zip", target)

    assert calls == [("bucket", "some/key.zip", str(target))]
    assert target.read_bytes() == b"streamed"
