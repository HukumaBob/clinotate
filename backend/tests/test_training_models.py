import app.main  # noqa: F401
import sqlalchemy as sa

from app.datasets.models import TaskType
from app.db import SessionLocal
from app.jobs.models import JobType
from app.training.models import ModelVersion, TrainingRun, TrainingRunStatus


def test_model_train_job_type_exists():
    assert JobType.MODEL_TRAIN.value == "model_train"


def test_training_run_defaults():
    session = SessionLocal()
    try:
        user_id = session.execute(sa.text("SELECT id FROM users ORDER BY id LIMIT 1")).scalar()
        dataset_id = session.execute(sa.text("SELECT id FROM datasets ORDER BY id LIMIT 1")).scalar()

        run = TrainingRun(
            dataset_id=dataset_id,
            job_id=None,
            adapter="ultralytics_yolo",
            base_model="yolo11n.pt",
            task_type=TaskType.DETECTION,
            config={"epochs": 10, "batch": 8},
            total_epochs=10,
            created_by_id=user_id,
        )
        session.add(run)
        session.commit()
        session.refresh(run)

        assert run.status == TrainingRunStatus.PENDING
        assert run.stop_requested is False
        assert run.log_text == ""
        assert run.current_epoch == 0
        assert run.metrics == {}
    finally:
        session.rollback()
        session.close()


def test_model_version_links_to_run():
    session = SessionLocal()
    try:
        user_id = session.execute(sa.text("SELECT id FROM users ORDER BY id LIMIT 1")).scalar()
        dataset_id = session.execute(sa.text("SELECT id FROM datasets ORDER BY id LIMIT 1")).scalar()

        run = TrainingRun(
            dataset_id=dataset_id,
            adapter="ultralytics_yolo",
            base_model="yolo11n.pt",
            task_type=TaskType.DETECTION,
            config={},
            total_epochs=1,
            created_by_id=user_id,
        )
        session.add(run)
        session.commit()

        version = ModelVersion(
            training_run_id=run.id,
            name="run-1-best",
            task_type=TaskType.DETECTION,
            storage_key="models/1/best.pt",
            metrics={"mAP50": 0.71},
        )
        session.add(version)
        session.commit()
        session.refresh(version)

        assert version.is_active is False
        assert version.training_run_id == run.id
    finally:
        session.rollback()
        session.close()
