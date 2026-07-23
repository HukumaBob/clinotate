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
