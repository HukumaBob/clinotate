from celery import Celery

from app.config import get_worker_settings

settings = get_worker_settings()

celery_app = Celery(
    "endoscopy_platform_worker",
    broker=settings.redis_url,
    backend=settings.redis_url,
)
celery_app.conf.task_serializer = "json"
celery_app.conf.result_serializer = "json"
celery_app.conf.accept_content = ["json"]

# tasks.py defines the @celery_app.task-decorated sam3_predict/sam3_track
# tasks against this same app instance; importing it here is what actually
# registers them with the worker (celery_app.worker_main only imports this
# module by name, never tasks.py on its own).
from app import tasks  # noqa: E402,F401
