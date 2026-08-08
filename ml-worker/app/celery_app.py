from celery import Celery
import torch

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

# Hard ceiling on this process's own VRAM allocations, independent of any
# request-level or pre-flight heuristic (see
# docs/superpowers/specs/2026-08-08-sam2-gpu-oom-host-crash-design.md):
# this GPU is shared with the desktop session (Xorg/gnome-shell/browser),
# and letting a single tracking job grow unbounded has previously exhausted
# VRAM badly enough to reboot the host. 0.8 leaves ~1.6 GiB of this GPU's
# 8 GiB for the desktop. Once this fraction is hit, PyTorch raises
# torch.cuda.OutOfMemoryError instead of continuing to allocate -- an
# ordinary Python exception the existing track() failure handling in
# app/tasks.py already recovers from via a worker process restart.
if torch.cuda.is_available():
    torch.cuda.set_per_process_memory_fraction(0.8)

# tasks.py defines the @celery_app.task-decorated sam3_predict/sam3_track
# tasks against this same app instance; importing it here is what actually
# registers them with the worker (celery_app.worker_main only imports this
# module by name, never tasks.py on its own).
from app import tasks  # noqa: E402,F401
