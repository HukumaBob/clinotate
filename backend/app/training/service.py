"""Create, inspect and stop training runs.

A run is a Job like every other long operation here, executed by
ml-worker. What makes it different is the stop path: ml-worker runs
--pool=solo, so revoke(terminate=True) would SIGTERM the whole container.
Stopping is therefore a flag the adapter polls at epoch boundaries.
"""

from datetime import datetime, timezone

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.auth.models import User
from app.celery_app import celery_app
from app.datasets.models import Dataset
from app.jobs.models import Job, JobStatus, JobType
from app.storage import StorageService
from app.training.models import ModelVersion, TrainingRun, TrainingRunStatus

ADAPTER_NAME = "ultralytics_yolo"

ACTIVE_STATUSES = (TrainingRunStatus.PENDING, TrainingRunStatus.RUNNING)


class DatasetNotExported(Exception):
    """The dataset has no finished export archive to train on."""


class RunAlreadyActive(Exception):
    """Another run is pending or running; ml-worker handles one at a time."""


class RunNotStoppable(Exception):
    """The run has already reached a terminal status."""


class TrainingRunNotFound(Exception):
    """No such run."""


class ModelVersionNotFound(Exception):
    """No such model version."""


def find_export_job(session: Session, dataset_id: int) -> Job | None:
    """The most recent succeeded export for this dataset, or None.

    The archive's location lives in Job.result_ref rather than on Dataset,
    so "is this dataset trainable?" is a job lookup, not a column read.
    """
    candidates = session.scalars(
        select(Job)
        .where(
            Job.job_type == JobType.DATASET_EXPORT,
            Job.status == JobStatus.SUCCEEDED,
            Job.result_ref.is_not(None),
        )
        .order_by(Job.id.desc())
    )
    for job in candidates:
        if job.payload.get("dataset_id") == dataset_id:
            return job
    return None


def create_training_run(
    session: Session,
    *,
    dataset_id: int,
    base_model: str,
    config: dict,
    created_by: User,
) -> TrainingRun:
    dataset = session.get(Dataset, dataset_id)
    if dataset is None:
        raise DatasetNotExported(f"Dataset {dataset_id} not found")

    export_job = find_export_job(session, dataset_id)
    if export_job is None:
        raise DatasetNotExported(
            f"Dataset {dataset_id} has no finished export; export it before training"
        )

    active = session.scalars(
        select(TrainingRun).where(TrainingRun.status.in_(ACTIVE_STATUSES))
    ).first()
    if active is not None:
        # Under --pool=solo a second run would merely queue, but a refusal
        # explains itself where a silent "pending" does not.
        raise RunAlreadyActive(f"Training run {active.id} is still active")

    run = TrainingRun(
        dataset_id=dataset_id,
        adapter=ADAPTER_NAME,
        base_model=base_model,
        task_type=dataset.task_type,
        config=config,
        total_epochs=int(config.get("epochs", 1)),
        created_by_id=created_by.id,
    )
    session.add(run)
    session.commit()
    session.refresh(run)

    job = Job(
        job_type=JobType.MODEL_TRAIN,
        status=JobStatus.PENDING,
        payload={
            "training_run_id": run.id,
            "export_key": export_job.result_ref,
        },
        created_by_id=created_by.id,
    )
    session.add(job)
    session.commit()
    session.refresh(job)

    run.job_id = job.id
    session.commit()
    session.refresh(run)

    # Default "celery" queue -- ml-worker consumes it, unlike the transcode
    # worker's video_transcode queue.
    celery_app.send_task("model_train", args=[job.id])
    return run


def get_run(session: Session, run_id: int) -> TrainingRun:
    run = session.get(TrainingRun, run_id)
    if run is None:
        raise TrainingRunNotFound(f"Training run {run_id} not found")
    return run


def request_stop(session: Session, run_id: int) -> TrainingRun:
    """Stop is cooperative on the first press: it only raises the flag,
    and a live worker is expected to notice TrainingRun.stop_requested and
    end the run itself at the next epoch boundary (see ml-worker's
    model_train task). There is no service-side path that ever moves a
    RUNNING run to a terminal status on its own -- if the worker that
    would have noticed the flag is dead (container restart, or the known
    open issue where GPU pressure hard-reboots this host), nothing ever
    will, and create_training_run's global "only one active run" guard
    then refuses every future run forever.

    So a *second* Stop on a run that already has stop_requested set is
    read as the user confirming the worker isn't answering, and force-
    terminates the run here instead of waiting on it. This is the only
    escape hatch; the alternative is a permanently unusable feature after
    one bad restart.

    A PENDING run is a different case: nothing has picked it up yet, so
    there is no live worker polling the flag and no cooperative shutdown
    to wait for. The first press force-stops it immediately rather than
    making the user press Stop twice for no reason.
    """
    run = get_run(session, run_id)
    if run.status not in ACTIVE_STATUSES:
        raise RunNotStoppable(f"Training run {run_id} is {run.status.value}")

    if run.status == TrainingRunStatus.PENDING or run.stop_requested:
        _force_stop(session, run)
    else:
        run.stop_requested = True
        session.commit()
        session.refresh(run)
    return run


def _force_stop(session: Session, run: TrainingRun) -> None:
    now = datetime.now(timezone.utc)
    run.stop_requested = True
    run.status = TrainingRunStatus.STOPPED
    run.finished_at = now
    run.error = (
        "Force-stopped: the worker did not acknowledge the stop request. "
        "Treated as a dead/unresponsive worker (e.g. after a host restart)."
    )
    if run.job_id is not None:
        job = session.get(Job, run.job_id)
        if job is not None and job.status in (JobStatus.PENDING, JobStatus.RUNNING):
            job.status = JobStatus.FAILED
            job.error = run.error
            job.finished_at = now
    session.commit()
    session.refresh(run)


def list_runs(session: Session, status: TrainingRunStatus | None = None) -> list[TrainingRun]:
    statement = select(TrainingRun).order_by(TrainingRun.id.desc())
    if status is not None:
        statement = statement.where(TrainingRun.status == status)
    return list(session.scalars(statement))


def read_log(session: Session, run_id: int, offset: int) -> tuple[str, int, TrainingRunStatus]:
    run = get_run(session, run_id)
    text = run.log_text or ""
    if offset < 0 or offset > len(text):
        offset = 0
    tail = text[offset:]
    return tail, len(text), run.status


def list_model_versions(session: Session) -> list[ModelVersion]:
    return list(session.scalars(select(ModelVersion).order_by(ModelVersion.id.desc())))


def get_model_version(session: Session, version_id: int) -> ModelVersion:
    version = session.get(ModelVersion, version_id)
    if version is None:
        raise ModelVersionNotFound(f"Model version {version_id} not found")
    return version


def delete_model_version(session: Session, storage: StorageService, version_id: int) -> None:
    version = get_model_version(session, version_id)
    storage.delete(version.storage_key)
    session.delete(version)
    session.commit()
