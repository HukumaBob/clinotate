import os

import pytest

from app.config import WorkerSettings


def test_settings_reads_database_url_components(monkeypatch):
    monkeypatch.setenv("POSTGRES_USER", "endoscopy")
    monkeypatch.setenv("POSTGRES_PASSWORD", "pw")
    monkeypatch.setenv("POSTGRES_DB", "endoscopy")
    monkeypatch.setenv("POSTGRES_HOST", "postgres")
    monkeypatch.setenv("REDIS_URL", "redis://redis:6379/0")
    monkeypatch.setenv("MINIO_ENDPOINT", "minio:9000")
    monkeypatch.setenv("MINIO_ACCESS_KEY", "key")
    monkeypatch.setenv("MINIO_SECRET_KEY", "secret")
    monkeypatch.setenv("MINIO_BUCKET", "endoscopy-media")
    monkeypatch.setenv("HF_TOKEN", "hf_test_token")

    settings = WorkerSettings()

    assert settings.database_url == "postgresql+psycopg2://endoscopy:pw@postgres:5432/endoscopy"
    assert settings.redis_url == "redis://redis:6379/0"
    assert settings.hf_token == "hf_test_token"
