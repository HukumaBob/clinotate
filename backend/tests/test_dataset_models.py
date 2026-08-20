import app.main  # noqa: F401 -- registers every model on Base.metadata for create_all
from app.datasets.models import Dataset, DatasetItem, SplitName, TaskType
import app.db as db_module


def test_dataset_round_trips_its_jsonb_fields():
    session = db_module.SessionLocal()
    try:
        user_id = session.execute(
            __import__("sqlalchemy").text("SELECT id FROM users ORDER BY id LIMIT 1")
        ).scalar()
        dataset = Dataset(
            name="ds-model-test",
            task_type=TaskType.DETECTION,
            taxonomy_version=1,
            split_config={"train": 70, "val": 20},
            grouping_overrides={"collapse": [1], "expand": [2]},
            excluded_label_ids=[3, 4],
            balance_metrics={"severity": "severe_imbalance"},
            created_by_id=user_id,
        )
        session.add(dataset)
        session.commit()
        session.refresh(dataset)

        assert dataset.task_type is TaskType.DETECTION
        assert dataset.split_config == {"train": 70, "val": 20}
        assert dataset.grouping_overrides == {"collapse": [1], "expand": [2]}
        assert dataset.excluded_label_ids == [3, 4]
        assert dataset.balance_metrics == {"severity": "severe_imbalance"}
        assert dataset.created_at is not None
    finally:
        session.rollback()
        session.close()


def test_dataset_item_records_its_frame_split_and_annotations():
    session = db_module.SessionLocal()
    try:
        import sqlalchemy as sa

        user_id = session.execute(sa.text("SELECT id FROM users ORDER BY id LIMIT 1")).scalar()
        frame_id = session.execute(sa.text("SELECT id FROM frames ORDER BY id LIMIT 1")).scalar()
        dataset = Dataset(
            name="ds-item-test",
            task_type=TaskType.CLASSIFICATION,
            taxonomy_version=1,
            split_config={"train": 80, "val": 20},
            grouping_overrides={},
            excluded_label_ids=[],
            balance_metrics={},
            created_by_id=user_id,
        )
        session.add(dataset)
        session.flush()

        item = DatasetItem(
            dataset_id=dataset.id,
            frame_id=frame_id,
            annotation_ids=[10, 11],
            split=SplitName.TRAIN,
        )
        session.add(item)
        session.commit()
        session.refresh(item)

        assert item.split is SplitName.TRAIN
        assert item.annotation_ids == [10, 11]
        assert item.dataset_id == dataset.id
    finally:
        session.rollback()
        session.close()
