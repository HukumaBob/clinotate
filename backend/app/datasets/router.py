from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import func
from sqlalchemy.orm import Session

from app.auth.dependencies import get_current_user
from app.auth.models import User
from app.datasets.models import Dataset, DatasetItem
from app.datasets.schemas import (
    BalanceReportRead,
    BalanceRequest,
    DatasetCreate,
    DatasetRead,
    ExportDownloadRead,
    ExportRequest,
)
from app.datasets.service import compute_balance, create_dataset
from app.db import get_session
from app.jobs.models import Job, JobStatus, JobType
from app.jobs.schemas import JobRead
from app.media.models import Frame
from app.storage import StorageService, get_storage_service
from app.taxonomy.hierarchy import GroupingRules
from app.worker.export_task import dataset_export

router = APIRouter(prefix="/datasets", tags=["datasets"], dependencies=[Depends(get_current_user)])


def _empty_split_counts() -> dict:
    return {"train": 0, "val": 0, "test": 0}


def _dataset_has_succeeded_export(session: Session, dataset_id: int) -> bool:
    """Single-dataset version of the exported check, used where an extra
    per-dataset query is unavoidable anyway (create, and the detail
    endpoint)."""
    return (
        session.query(Job.id)
        .filter(
            Job.job_type == JobType.DATASET_EXPORT,
            Job.status == JobStatus.SUCCEEDED,
            Job.result_ref.isnot(None),
            Job.payload["dataset_id"].as_integer() == dataset_id,
        )
        .first()
        is not None
    )


def _serialize_summary(dataset: Dataset, split_counts: dict, exported: bool = False) -> dict:
    """Shared summary fields for both the list and detail representations."""
    return {
        "id": dataset.id,
        "name": dataset.name,
        "task_type": dataset.task_type,
        "taxonomy_version": dataset.taxonomy_version,
        "split_config": dataset.split_config,
        "grouping_overrides": dataset.grouping_overrides,
        "excluded_label_ids": dataset.excluded_label_ids,
        "class_limits": dataset.class_limits,
        "balance_metrics": dataset.balance_metrics,
        "created_at": dataset.created_at,
        "item_count": sum(split_counts.values()),
        "split_counts": split_counts,
        "exported": exported,
        "items": [],
    }


def _serialize_one(session: Session, dataset: Dataset, include_items: bool) -> dict:
    """Serialize a single dataset. Used where an extra per-dataset query is
    unavoidable anyway (create, and the detail endpoint which needs the
    actual item rows)."""
    items = session.query(DatasetItem).filter(DatasetItem.dataset_id == dataset.id).all()
    split_counts = _empty_split_counts()
    for item in items:
        split_counts[item.split.value] += 1

    exported = _dataset_has_succeeded_export(session, dataset.id)
    result = _serialize_summary(dataset, split_counts, exported)

    if include_items and items:
        sequence_by_frame = dict(
            session.query(Frame.id, Frame.sequence_id)
            .filter(Frame.id.in_([i.frame_id for i in items]))
            .all()
        )
        result["items"] = [
            {
                "frame_id": item.frame_id,
                "sequence_id": sequence_by_frame.get(item.frame_id, 0),
                "split": item.split,
            }
            for item in items
        ]

    return result


@router.post("/balance", response_model=BalanceReportRead)
def dataset_balance(payload: BalanceRequest, session: Session = Depends(get_session)) -> dict:
    """Live recompute for the panel. Writes nothing -- that is its contract."""
    rules = GroupingRules(
        collapse=frozenset(payload.grouping_overrides.collapse),
        expand=frozenset(payload.grouping_overrides.expand),
    )
    report = compute_balance(
        session, payload.sequence_ids, payload.task_type, rules,
        set(payload.excluded_label_ids), payload.threshold,
        class_limits=dict(payload.class_limits),
    )
    return {
        "classes": [
            {"label_id": c.label_id, "name": c.name, "instances": c.instances,
             "frames": c.frames, "max_instances": c.max_instances,
             "max_frames": c.max_frames}
            for c in report.classes
        ],
        "total_frames": report.total_frames,
        "negative_frames": report.negative_frames,
        "below_threshold": report.below_threshold,
        "threshold": report.threshold,
        "metrics": report.metrics,
        "recommendations": [
            {"kind": r.kind, "message": r.message} for r in report.recommendations
        ],
    }


@router.post("", response_model=DatasetRead, status_code=status.HTTP_201_CREATED)
def create(
    payload: DatasetCreate,
    current_user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
) -> dict:
    dataset = create_dataset(session, payload, current_user)
    return _serialize_one(session, dataset, include_items=False)


@router.get("", response_model=list[DatasetRead])
def list_datasets(session: Session = Depends(get_session)) -> list[dict]:
    datasets = session.query(Dataset).order_by(Dataset.created_at.desc()).all()
    if not datasets:
        return []

    # One grouped query for every dataset's split counts instead of a
    # per-dataset DatasetItem query (N+1) -- item_count/split_counts are the
    # only thing the list view needs, so the item rows themselves are never
    # fetched here.
    dataset_ids = [d.id for d in datasets]
    rows = (
        session.query(DatasetItem.dataset_id, DatasetItem.split, func.count())
        .filter(DatasetItem.dataset_id.in_(dataset_ids))
        .group_by(DatasetItem.dataset_id, DatasetItem.split)
        .all()
    )
    split_counts_by_dataset: dict[int, dict] = {d.id: _empty_split_counts() for d in datasets}
    for dataset_id, split, count in rows:
        split_counts_by_dataset[dataset_id][split.value] = count

    # Same shape as the split-counts query above: one grouped query for
    # every dataset's exported flag instead of a per-dataset Job lookup
    # (N+1). A dataset counts as exported when a DATASET_EXPORT job
    # succeeded for it with a stored result_ref.
    exported_dataset_ids = {
        dataset_id
        for (dataset_id,) in session.query(Job.payload["dataset_id"].as_integer())
        .filter(
            Job.job_type == JobType.DATASET_EXPORT,
            Job.status == JobStatus.SUCCEEDED,
            Job.result_ref.isnot(None),
            Job.payload["dataset_id"].as_integer().in_(dataset_ids),
        )
        .distinct()
        .all()
    }

    return [
        _serialize_summary(
            dataset,
            split_counts_by_dataset[dataset.id],
            dataset.id in exported_dataset_ids,
        )
        for dataset in datasets
    ]


@router.get("/{dataset_id}", response_model=DatasetRead)
def get_dataset(dataset_id: int, session: Session = Depends(get_session)) -> dict:
    dataset = session.get(Dataset, dataset_id)
    if dataset is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Dataset not found")
    return _serialize_one(session, dataset, include_items=True)


@router.post("/{dataset_id}/export", response_model=JobRead, status_code=status.HTTP_202_ACCEPTED)
def export_dataset(
    dataset_id: int,
    payload: ExportRequest,
    current_user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
) -> Job:
    dataset = session.get(Dataset, dataset_id)
    if dataset is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Dataset not found")

    job = Job(
        job_type=JobType.DATASET_EXPORT,
        status=JobStatus.PENDING,
        payload={"dataset_id": dataset_id, "include_images": payload.include_images},
        created_by_id=current_user.id,
    )
    session.add(job)
    session.commit()
    session.refresh(job)

    dataset_export.delay(job.id)

    return job


@router.get("/{dataset_id}/export/{job_id}/download", response_model=ExportDownloadRead)
def download_export(
    dataset_id: int,
    job_id: int,
    session: Session = Depends(get_session),
    storage: StorageService = Depends(get_storage_service),
) -> dict:
    job = session.get(Job, job_id)
    if (
        job is None
        or job.job_type != JobType.DATASET_EXPORT
        or job.payload.get("dataset_id") != dataset_id
    ):
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Export job not found")

    if job.status != JobStatus.SUCCEEDED or not job.result_ref:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Export job has not succeeded",
        )

    return {"download_url": storage.url_for(job.result_ref)}


@router.delete("/{dataset_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_dataset(dataset_id: int, session: Session = Depends(get_session)) -> None:
    dataset = session.get(Dataset, dataset_id)
    if dataset is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Dataset not found")
    session.query(DatasetItem).filter(DatasetItem.dataset_id == dataset_id).delete()
    session.delete(dataset)
    session.commit()
