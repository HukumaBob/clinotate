import app.db as db_module
import app.main  # noqa: F401 -- registers every model on Base.metadata for create_all
import sqlalchemy as sa
from fastapi.testclient import TestClient

from app.datasets.models import Dataset, TaskType
from app.jobs.models import Job, JobStatus, JobType
from app.main import app
from app.training.models import ModelVersion, TrainingRun, TrainingRunStatus


def _session():
    """`app.db.SessionLocal()` via the module, not a name captured by
    `from app.db import SessionLocal` -- conftest.py's autouse fixture
    repoints `db_module.SessionLocal` at the test database by patching the
    module attribute, which only a call through the module object observes.
    An imported name binds once at collection time, before that patch runs,
    and would silently hit the real dev database's engine instead."""
    return db_module.SessionLocal()


client = TestClient(app)


def _register_and_login(email: str) -> dict[str, str]:
    client.post("/auth/register", json={"email": email, "password": "pass1234", "role": "admin"})
    response = client.post("/auth/login", json={"email": email, "password": "pass1234"})
    return {"Authorization": f"Bearer {response.json()['access_token']}"}


def _make_dataset(session, user_id: int) -> Dataset:
    dataset = Dataset(
        name="ds-training-api-test",
        task_type=TaskType.DETECTION,
        taxonomy_version=1,
        split_config={"train": 80, "val": 20},
        grouping_overrides={},
        excluded_label_ids=[],
        balance_metrics={},
        created_by_id=user_id,
    )
    session.add(dataset)
    session.commit()
    session.refresh(dataset)
    return dataset


def _succeeded_export(session, dataset_id: int, user_id: int) -> Job:
    job = Job(
        job_type=JobType.DATASET_EXPORT,
        status=JobStatus.SUCCEEDED,
        payload={"dataset_id": dataset_id},
        result_ref=f"exports/{dataset_id}/dataset.zip",
        created_by_id=user_id,
    )
    session.add(job)
    session.commit()
    return job


def _cleanup(session, dataset_id: int) -> None:
    """The router's endpoints commit internally (via app.training.service),
    so a bare rollback would not undo their writes. ModelVersion is deleted
    before TrainingRun to satisfy the FK, and Job rows filtered by the
    dataset_id embedded in their JSON payload -- mirrors
    test_training_service.py's _cleanup, which exists because a leaked
    PENDING/RUNNING row trips the global "only one active run" guard for
    every later test run against this shared dev database.
    """
    session.rollback()
    run_ids = [
        row[0]
        for row in session.query(TrainingRun.id).filter(TrainingRun.dataset_id == dataset_id).all()
    ]
    if run_ids:
        session.query(ModelVersion).filter(ModelVersion.training_run_id.in_(run_ids)).delete(
            synchronize_session=False
        )
    session.query(TrainingRun).filter(TrainingRun.dataset_id == dataset_id).delete()
    session.query(Job).filter(Job.payload["dataset_id"].as_integer() == dataset_id).delete(
        synchronize_session=False
    )
    session.query(Dataset).filter(Dataset.id == dataset_id).delete()
    session.commit()


def test_create_run_returns_409_without_export():
    headers = _register_and_login("train-api1@example.com")
    session = _session()
    user_id = session.execute(sa.text("SELECT id FROM users ORDER BY id LIMIT 1")).scalar()
    dataset = _make_dataset(session, user_id)
    try:
        response = client.post(
            "/training/runs",
            headers=headers,
            json={
                "dataset_id": dataset.id,
                "base_model": "yolo11n.pt",
                "epochs": 10,
                "batch": 8,
            },
        )
        assert response.status_code == 409
        assert "export" in response.json()["detail"].lower()
    finally:
        _cleanup(session, dataset.id)
        session.close()


def test_create_run_returns_202(monkeypatch):
    monkeypatch.setattr("app.training.service.celery_app.send_task", lambda *a, **kw: None)

    headers = _register_and_login("train-api2@example.com")
    session = _session()
    user_id = session.execute(sa.text("SELECT id FROM users ORDER BY id LIMIT 1")).scalar()
    dataset = _make_dataset(session, user_id)
    _succeeded_export(session, dataset.id, user_id)
    try:
        response = client.post(
            "/training/runs",
            headers=headers,
            json={
                "dataset_id": dataset.id,
                "base_model": "yolo11n.pt",
                "epochs": 10,
                "batch": 8,
            },
        )

        assert response.status_code == 202
        body = response.json()
        assert body["status"] == "pending"
        assert body["total_epochs"] == 10
    finally:
        _cleanup(session, dataset.id)
        session.close()


def test_log_endpoint_returns_tail_past_offset():
    headers = _register_and_login("train-api3@example.com")
    session = _session()
    user_id = session.execute(sa.text("SELECT id FROM users ORDER BY id LIMIT 1")).scalar()
    dataset = _make_dataset(session, user_id)
    try:
        run = TrainingRun(
            dataset_id=dataset.id,
            adapter="ultralytics_yolo",
            base_model="yolo11n.pt",
            task_type=dataset.task_type,
            config={},
            status=TrainingRunStatus.RUNNING,
            log_text="line one\nline two\n",
            total_epochs=3,
            created_by_id=user_id,
        )
        session.add(run)
        session.commit()

        response = client.get(f"/training/runs/{run.id}/log?offset=9", headers=headers)

        assert response.status_code == 200
        body = response.json()
        assert body["text"] == "line two\n"
        assert body["offset"] == 18
    finally:
        _cleanup(session, dataset.id)
        session.close()


def test_stop_returns_409_for_a_finished_run():
    headers = _register_and_login("train-api4@example.com")
    session = _session()
    user_id = session.execute(sa.text("SELECT id FROM users ORDER BY id LIMIT 1")).scalar()
    dataset = _make_dataset(session, user_id)
    try:
        run = TrainingRun(
            dataset_id=dataset.id,
            adapter="ultralytics_yolo",
            base_model="yolo11n.pt",
            task_type=dataset.task_type,
            config={},
            status=TrainingRunStatus.SUCCEEDED,
            total_epochs=3,
            created_by_id=user_id,
        )
        session.add(run)
        session.commit()

        response = client.post(f"/training/runs/{run.id}/stop", headers=headers)

        assert response.status_code == 409
    finally:
        _cleanup(session, dataset.id)
        session.close()


def test_models_list_is_empty_initially():
    headers = _register_and_login("train-api5@example.com")
    response = client.get("/training/models", headers=headers)
    assert response.status_code == 200
    assert isinstance(response.json(), list)


def _make_run(session, dataset, user_id, status=TrainingRunStatus.SUCCEEDED):
    run = TrainingRun(
        dataset_id=dataset.id,
        adapter="ultralytics_yolo",
        base_model="yolo11n.pt",
        task_type=dataset.task_type,
        config={"epochs": 1},
        status=status,
        total_epochs=1,
        created_by_id=user_id,
    )
    session.add(run)
    session.commit()
    session.refresh(run)
    return run


def test_deleting_a_dataset_whose_runs_left_no_model_succeeds():
    """Training alone must not strand a dataset.

    A run that produced no ModelVersion -- it failed, or its weights were
    deleted later -- holds nothing worth protecting. Blocking on the mere
    existence of a run would tell the user to "delete the models first"
    when there are no models to delete, which is exactly the dead end the
    first version of this rule created.
    """
    headers = _register_and_login("del-dataset-norun@example.com")
    session = _session()
    try:
        user_id = session.execute(sa.text("SELECT id FROM users ORDER BY id DESC LIMIT 1")).scalar()
        dataset = _make_dataset(session, user_id)
        run = _make_run(session, dataset, user_id)
        dataset_id, run_id = dataset.id, run.id
    finally:
        session.close()

    response = client.delete(f"/datasets/{dataset_id}", headers=headers)
    assert response.status_code == 204

    session = _session()
    try:
        assert session.get(Dataset, dataset_id) is None
        # The run goes with it -- nothing references it any more.
        assert session.get(TrainingRun, run_id) is None
    finally:
        session.close()


def test_deleting_a_dataset_with_a_trained_model_is_refused():
    headers = _register_and_login("del-dataset-model@example.com")
    session = _session()
    try:
        user_id = session.execute(sa.text("SELECT id FROM users ORDER BY id DESC LIMIT 1")).scalar()
        dataset = _make_dataset(session, user_id)
        run = _make_run(session, dataset, user_id)
        version = ModelVersion(
            training_run_id=run.id,
            name="keep-me",
            task_type=dataset.task_type,
            storage_key=f"models/{run.id}/best.pt",
            metrics={},
        )
        session.add(version)
        session.commit()
        dataset_id, version_id, run_id = dataset.id, version.id, run.id
    finally:
        session.close()

    response = client.delete(f"/datasets/{dataset_id}", headers=headers)
    assert response.status_code == 409
    assert "keep-me" in response.json()["detail"]

    session = _session()
    try:
        assert session.get(Dataset, dataset_id) is not None
        session.query(ModelVersion).filter_by(id=version_id).delete()
        session.query(TrainingRun).filter_by(id=run_id).delete()
        session.query(Dataset).filter_by(id=dataset_id).delete()
        session.commit()
    finally:
        session.close()


def test_deleting_a_dataset_with_an_active_run_is_refused():
    """An active run is reading this dataset's export archive right now."""
    headers = _register_and_login("del-dataset-active@example.com")
    session = _session()
    try:
        user_id = session.execute(sa.text("SELECT id FROM users ORDER BY id DESC LIMIT 1")).scalar()
        dataset = _make_dataset(session, user_id)
        run = _make_run(session, dataset, user_id, status=TrainingRunStatus.RUNNING)
        dataset_id, run_id = dataset.id, run.id
    finally:
        session.close()

    response = client.delete(f"/datasets/{dataset_id}", headers=headers)
    assert response.status_code == 409
    assert "running" in response.json()["detail"].lower()

    session = _session()
    try:
        assert session.get(Dataset, dataset_id) is not None
        session.query(TrainingRun).filter_by(id=run_id).delete()
        session.query(Dataset).filter_by(id=dataset_id).delete()
        session.commit()
    finally:
        session.close()
