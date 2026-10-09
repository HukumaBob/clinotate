"""Create, inspect and stop training runs.

A run is a Job like every other long operation here, executed by
ml-worker. What makes it different is the stop path: ml-worker runs
--pool=solo, so revoke(terminate=True) would SIGTERM the whole container.
Stopping is therefore a flag the adapter polls at epoch boundaries.
"""

import logging
from datetime import datetime, timezone

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.auth.models import User
from app.celery_app import celery_app
from app.datasets.models import Dataset, TaskType
from app.jobs.models import Job, JobStatus, JobType
from app.storage import StorageService
from app.training import catalog, params
from app.training.models import ModelVersion, TrainingRun, TrainingRunStatus

logger = logging.getLogger(__name__)

ADAPTER_NAME = catalog.ADAPTER_NAME

ACTIVE_STATUSES = (TrainingRunStatus.PENDING, TrainingRunStatus.RUNNING)


class DatasetNotExported(Exception):
    """The dataset has no finished export archive to train on."""


class RunAlreadyActive(Exception):
    """Another run is pending or running; ml-worker handles one at a time."""


class DatasetNotFound(Exception):
    """No such dataset."""


class InvalidBaseModel(Exception):
    """The requested starting point is not usable for this dataset."""


class RunNotStoppable(Exception):
    """The run has already reached a terminal status."""


class TrainingRunNotFound(Exception):
    """No such run."""


class ModelVersionNotFound(Exception):
    """No such model version."""


class ArtifactNotFound(Exception):
    """No artifact at that index for this model version."""


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


def _headline(task_type: TaskType, metrics: dict) -> str | None:
    if task_type == TaskType.CLASSIFICATION:
        value, label = metrics.get("metrics/accuracy_top1"), "top-1"
    else:
        value, label = metrics.get("metrics/mAP50(B)"), "mAP50"
    return f"{label} {value:.3f}" if isinstance(value, (int, float)) else None


def list_base_models(session: Session, dataset_id: int) -> list[dict]:
    dataset = session.get(Dataset, dataset_id)
    if dataset is None:
        raise DatasetNotFound(f"Dataset {dataset_id} not found")

    options = [
        {
            "kind": "pretrained",
            "weights": model.weights,
            "label": model.weights,
            "family": model.family,
            "size": model.size,
            "note": model.note,
            "model_version_id": None,
        }
        for model in catalog.pretrained_models(ADAPTER_NAME, dataset.task_type)
    ]
    versions = session.scalars(
        select(ModelVersion)
        .join(TrainingRun, ModelVersion.training_run_id == TrainingRun.id)
        .where(
            ModelVersion.task_type == dataset.task_type,
            TrainingRun.adapter == ADAPTER_NAME,
        )
        .order_by(ModelVersion.id.desc())
    )
    for version in versions:
        parts = [
            _headline(version.task_type, version.metrics or {}),
            version.created_at.date().isoformat(),
        ]
        options.append(
            {
                "kind": "model_version",
                "weights": None,
                "label": version.name,
                "family": None,
                "size": None,
                "note": " · ".join(p for p in parts if p),
                "model_version_id": version.id,
            }
        )
    return options


def _clean_text(value: str | None) -> str | None:
    if value is None:
        return None
    value = value.strip()
    return value or None


def get_settings_schema(session: Session, dataset_id: int) -> dict:
    dataset = session.get(Dataset, dataset_id)
    if dataset is None:
        raise DatasetNotFound(f"Dataset {dataset_id} not found")
    return params.settings_schema(ADAPTER_NAME, dataset.task_type)


def update_run_meta(session: Session, run_id: int, fields: dict) -> TrainingRun:
    run = get_run(session, run_id)
    for key in ("name", "note"):
        if key in fields:
            setattr(run, key, _clean_text(fields[key]))
    session.commit()
    session.refresh(run)
    return run


def create_training_run(
    session: Session,
    *,
    dataset_id: int,
    base_model: str | None = None,
    base_model_version_id: int | None = None,
    settings: dict | None = None,
    name: str | None = None,
    note: str | None = None,
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

    parent_id = None
    if base_model_version_id is not None:
        parent = session.get(ModelVersion, base_model_version_id)
        if parent is None:
            raise InvalidBaseModel(f"Model version {base_model_version_id} not found")
        parent_run = session.get(TrainingRun, parent.training_run_id)
        if parent.task_type != dataset.task_type:
            raise InvalidBaseModel(
                f"Model version {parent.id} is a {parent.task_type.value} model; "
                f"this dataset is {dataset.task_type.value}"
            )
        if parent_run is None or parent_run.adapter != ADAPTER_NAME:
            raise InvalidBaseModel(f"Model version {parent.id} was not trained by {ADAPTER_NAME}")
        parent_id = parent.id
        resolved_base = parent.name
    else:
        resolved_base = catalog.resolve_pretrained(ADAPTER_NAME, dataset.task_type, base_model)
        if resolved_base is None:
            raise InvalidBaseModel(
                f"{base_model!r} is not a {dataset.task_type.value} base model for {ADAPTER_NAME}"
            )

    resolved_settings = params.resolve_settings(ADAPTER_NAME, dataset.task_type, settings)

    run = TrainingRun(
        dataset_id=dataset_id,
        adapter=ADAPTER_NAME,
        base_model=resolved_base,
        base_model_version_id=parent_id,
        task_type=dataset.task_type,
        config=resolved_settings,
        total_epochs=int(resolved_settings["epochs"]),
        name=_clean_text(name),
        note=_clean_text(note),
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


class ModelVersionInUse(Exception):
    """A training run was fine-tuned from this version."""


def delete_model_version(session: Session, storage: StorageService, version_id: int) -> None:
    """Delete a model version and every object that names it.

    Objects go before the row, matching delete_dataset: a storage failure
    then leaves a recoverable version rather than orphaned bytes. A
    missing object is logged and skipped rather than blocking the delete
    -- 174 MB of orphaned export archives accumulated exactly this way
    before 857760d.
    """
    version = get_model_version(session, version_id)
    children = session.scalars(
        select(TrainingRun)
        .where(TrainingRun.base_model_version_id == version_id)
        .order_by(TrainingRun.id)
    ).all()
    # Refuse only for a child that is still live: an active run needs the
    # weights, and a child that owns a version is real lineage. Stale
    # children (failed/stopped/never produced a version) must not make the
    # parent -- and through delete_dataset, its dataset -- undeletable,
    # since no endpoint deletes training runs.
    for child in children:
        if child.status in ACTIVE_STATUSES:
            raise ModelVersionInUse(
                f"Model version {version_id} is the starting point of training run "
                f"{child.id}, which is still active; stop it first"
            )
        owned = session.scalars(
            select(ModelVersion)
            .where(ModelVersion.training_run_id == child.id)
            .order_by(ModelVersion.id)
        ).first()
        if owned is not None:
            raise ModelVersionInUse(
                f"Model version {version_id} is the starting point of model version "
                f"'{owned.name}'; delete that version first"
            )
    for key in [*(version.artifact_keys or []), version.storage_key]:
        try:
            storage.delete(key)
        except Exception:  # noqa: BLE001 -- a missing object must not block the delete
            logger.warning("delete_model_version: could not remove %s", key)
    for child in children:
        # The child's base_model string keeps the parent's name as lineage.
        child.base_model_version_id = None
    session.delete(version)
    session.commit()


def get_model_metrics(session: Session, version_id: int) -> dict:
    """Assemble the Info panel's payload. History comes from the run,
    since it belongs to the attempt rather than to the weights."""
    version = get_model_version(session, version_id)
    run = session.get(TrainingRun, version.training_run_id)
    return {
        "metrics": version.metrics or {},
        "history": (run.metrics_history or []) if run else [],
        "per_class": version.per_class_metrics or [],
        "confusion": version.confusion_matrix,
        "artifacts": [
            {"name": key.rsplit("/", 1)[-1], "index": index}
            for index, key in enumerate(version.artifact_keys or [])
        ],
    }


def get_artifact_key(session: Session, version_id: int, index: int) -> str:
    version = get_model_version(session, version_id)
    keys = version.artifact_keys or []
    if index < 0 or index >= len(keys):
        raise ArtifactNotFound(f"Artifact {index} not found on model version {version_id}")
    return keys[index]
