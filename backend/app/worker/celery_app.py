from celery import Celery

from app.config import get_settings

settings = get_settings()

# Separate Celery application from the main API process's app.celery_app
# and from ml-worker's app.celery_app -- this one runs CPU-only ffmpeg
# transcode jobs and must never share ml-worker's GPU-bound container or
# lifecycle. Uses the same Redis broker (one Redis instance backs every
# Celery app in this project) but is its own worker process.
celery_app = Celery(
    "endoscopy_platform_transcode_worker",
    broker=settings.redis_url,
    backend=settings.redis_url,
)
celery_app.conf.task_serializer = "json"
celery_app.conf.result_serializer = "json"
celery_app.conf.accept_content = ["json"]

# tasks.py's @celery_app.task-decorated transcode_video is registered by
# importing it here, mirroring ml-worker/app/celery_app.py's own comment
# on why this import (not just defining tasks.py) is what makes the
# worker process see the task at startup.
from app import worker  # noqa: E402,F401
from app.worker import tasks  # noqa: E402,F401
