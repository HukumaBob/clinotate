from functools import lru_cache

import boto3
from botocore.client import Config
from botocore.exceptions import ClientError

from app.config import WorkerSettings, get_worker_settings


class StorageService:
    def __init__(self, settings: WorkerSettings):
        self._bucket = settings.minio_bucket
        protocol = "https" if settings.minio_secure else "http"
        self._client = boto3.client(
            "s3",
            endpoint_url=f"{protocol}://{settings.minio_endpoint}",
            aws_access_key_id=settings.minio_access_key,
            aws_secret_access_key=settings.minio_secret_key,
            config=Config(signature_version="s3v4"),
        )

    def ensure_bucket(self) -> None:
        try:
            self._client.head_bucket(Bucket=self._bucket)
        except ClientError:
            self._client.create_bucket(Bucket=self._bucket)

    def upload(self, key: str, data: bytes, content_type: str) -> None:
        self._client.put_object(
            Bucket=self._bucket, Key=key, Body=data, ContentType=content_type
        )

    def download(self, key: str) -> bytes:
        response = self._client.get_object(Bucket=self._bucket, Key=key)
        return response["Body"].read()

    def download_to_file(self, key: str, path) -> None:
        """Streams an object straight to ``path`` in chunks. Use this for
        large objects (dataset archives, weights): ``download`` holds the
        whole object in RAM, and a caller that keeps the bytes alive for a
        long job -- training -- pins gigabytes the DataLoader workers then
        inherit."""
        self._client.download_file(self._bucket, key, str(path))


@lru_cache
def get_storage_service() -> StorageService:
    service = StorageService(get_worker_settings())
    service.ensure_bucket()
    return service
