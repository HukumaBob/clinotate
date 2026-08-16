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
)
from app.datasets.service import compute_balance, create_dataset
from app.db import get_session
from app.media.models import Frame
from app.taxonomy.hierarchy import GroupingRules

router = APIRouter(prefix="/datasets", tags=["datasets"], dependencies=[Depends(get_current_user)])


def _empty_split_counts() -> dict:
    return {"train": 0, "val": 0, "test": 0}


def _serialize_summary(dataset: Dataset, split_counts: dict) -> dict:
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

    result = _serialize_summary(dataset, split_counts)

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
            {"label_id": c.label_id, "name": c.name, "instances": c.instances, "frames": c.frames}
            for c in report.classes
        ],
        "total_frames": report.total_frames,
        "negative_frames": report.negative_frames,
        "below_threshold": report.below_threshold,
        "threshold": report.threshold,
        "metrics": report.metrics,
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

    return [
        _serialize_summary(dataset, split_counts_by_dataset[dataset.id])
        for dataset in datasets
    ]


@router.get("/{dataset_id}", response_model=DatasetRead)
def get_dataset(dataset_id: int, session: Session = Depends(get_session)) -> dict:
    dataset = session.get(Dataset, dataset_id)
    if dataset is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Dataset not found")
    return _serialize_one(session, dataset, include_items=True)


@router.delete("/{dataset_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_dataset(dataset_id: int, session: Session = Depends(get_session)) -> None:
    dataset = session.get(Dataset, dataset_id)
    if dataset is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Dataset not found")
    session.query(DatasetItem).filter(DatasetItem.dataset_id == dataset_id).delete()
    session.delete(dataset)
    session.commit()
