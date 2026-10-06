"""Create, inspect and delete inference runs.

A run is a Job like every other long operation, executed by ml-worker. The
predictions live in object storage as one JSON document; this module only
ever hands out a presigned link to it.
"""

import logging

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.auth.models import User
from app.celery_app import celery_app
from app.datasets.models import TaskType
from app.inference.models import InferenceRun, InferenceRunStatus
from app.jobs.models import Job, JobStatus, JobType
from app.media.models import Video
from app.storage import StorageService
from app.training import service as training_service

logger = logging.getLogger(__name__)

SUPPORTED_TASK_TYPES = (TaskType.DETECTION, TaskType.SEGMENTATION)
ACTIVE_STATUSES = (InferenceRunStatus.PENDING, InferenceRunStatus.RUNNING)


class VideoNotFound(Exception):
    """No such video."""


class VideoNotPlayable(Exception):
    """The video cannot be played in a browser, so its result could not be viewed."""


class UnsupportedModelType(Exception):
    """Only detection and segmentation models can be run."""


class InferenceRunNotFound(Exception):
    """No such run."""


class RunStillActive(Exception):
    """The run is pending or running and cannot be deleted yet."""


class PredictionsNotReady(Exception):
    """The run has not succeeded, so there is nothing to download."""


def create_inference_run(
    session: Session,
    *,
    video_id: int,
    model_version_id: int,
    frame_stride: int,
    created_by: User,
) -> InferenceRun:
    video = session.get(Video, video_id)
    if video is None:
        raise VideoNotFound(f"Video {video_id} not found")
    # `is False`, not falsy: None means "not probed yet", which the player
    # also treats as playable.
    if video.browser_playable is False:
        raise VideoNotPlayable(
            f"Video {video_id} is not browser-playable; convert it in Media first"
        )

    version = training_service.get_model_version(session, model_version_id)
    if version.task_type not in SUPPORTED_TASK_TYPES:
        raise UnsupportedModelType(
            f"A {version.task_type.value} model cannot be run yet; "
            "only detection and segmentation models are supported"
        )

    run = InferenceRun(
        video_id=video_id,
        model_version_id=version.id,
        model_name=version.name,
        frame_stride=frame_stride,
        created_by_id=created_by.id,
    )
    session.add(run)
    session.commit()
    session.refresh(run)

    job = Job(
        job_type=JobType.INFERENCE_RUN,
        status=JobStatus.PENDING,
        payload={
            "inference_run_id": run.id,
            "video_id": video_id,
            "model_version_id": version.id,
            "model_name": version.name,
            "weights_key": version.storage_key,
            "task_type": version.task_type.value,
            "frame_stride": frame_stride,
        },
        created_by_id=created_by.id,
    )
    session.add(job)
    session.commit()
    session.refresh(job)

    run.job_id = job.id
    session.commit()
    session.refresh(run)

    # Default "celery" queue -- ml-worker consumes it.
    celery_app.send_task("inference_run", args=[job.id])
    return run


def get_run(session: Session, run_id: int) -> InferenceRun:
    run = session.get(InferenceRun, run_id)
    if run is None:
        raise InferenceRunNotFound(f"Inference run {run_id} not found")
    return run


def list_runs(session: Session) -> list[InferenceRun]:
    return list(session.scalars(select(InferenceRun).order_by(InferenceRun.id.desc())))


def get_predictions_url(session: Session, storage: StorageService, run_id: int) -> str:
    run = get_run(session, run_id)
    if run.status != InferenceRunStatus.SUCCEEDED or not run.predictions_key:
        raise PredictionsNotReady(f"Inference run {run_id} is {run.status.value}")
    return storage.url_for(run.predictions_key)


def delete_run(session: Session, storage: StorageService, run_id: int) -> None:
    """Delete a finished run and the object that holds its predictions.

    The object goes before the row, matching delete_model_version: a
    storage failure then leaves a recoverable run rather than orphaned
    bytes. An active run is refused because the worker still holds a
    reference to its row.
    """
    run = get_run(session, run_id)
    if run.status in ACTIVE_STATUSES:
        raise RunStillActive(f"Inference run {run_id} is still {run.status.value}")
    if run.predictions_key:
        try:
            storage.delete(run.predictions_key)
        except Exception:  # noqa: BLE001 -- a missing object must not block the delete
            logger.warning("delete_run: could not remove %s", run.predictions_key)
    session.delete(run)
    session.commit()
