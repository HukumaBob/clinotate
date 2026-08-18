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

# Own queue, not the default "celery" queue -- the main API process's
# app.celery_app and ml-worker's app.celery_app both also default to
# "celery" on this same Redis broker, and ml-worker has no video_transcode
# task registered, so a message landing there first is silently dropped.
# This worker must be started with `-Q video_transcode` to consume it.
celery_app.conf.task_default_queue = "video_transcode"
celery_app.conf.task_routes = {
    "video_transcode": {"queue": "video_transcode"},
    # Export is CPU-only, so it shares the transcode worker rather than
    # needing a process of its own. Routed explicitly rather than relying
    # on task_default_queue: a queue-name mismatch is this project's known
    # cause of silently dropped messages.
    "dataset_export": {"queue": "video_transcode"},
}

# tasks.py's @celery_app.task-decorated transcode_video is registered by
# importing it here, mirroring ml-worker/app/celery_app.py's own comment
# on why this import (not just defining tasks.py) is what makes the
# worker process see the task at startup.
from app import worker  # noqa: E402,F401
from app.worker import tasks  # noqa: E402,F401
from app.worker import export_task  # noqa: E402,F401
