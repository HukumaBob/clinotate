import pytest

from app.storage import StorageService
from app.config import get_settings


@pytest.fixture
def storage():
    service = StorageService(get_settings())
    service.ensure_bucket()
    return service


def test_upload_then_download_roundtrips_bytes(storage):
    key = "test/roundtrip.bin"
    storage.upload(key, b"hello world", content_type="application/octet-stream")

    result = storage.download(key)

    assert result == b"hello world"
    storage.delete(key)


def test_delete_removes_object(storage):
    key = "test/to-delete.bin"
    storage.upload(key, b"temp", content_type="application/octet-stream")

    storage.delete(key)

    with pytest.raises(Exception):
        storage.download(key)
