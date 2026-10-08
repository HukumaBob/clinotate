import app.db as db_module
import app.main  # noqa: F401 -- registers every model on Base.metadata for create_all
import sqlalchemy as sa
from fastapi.testclient import TestClient

from app.datasets.models import Dataset, TaskType
from app.jobs.models import Job, JobStatus, JobType
from app.main import app
from app.storage import get_storage_service
from app.training import service
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
    session.query(TrainingRun).filter(TrainingRun.dataset_id == dataset_id).update(
        {TrainingRun.base_model_version_id: None}, synchronize_session=False
    )
    session.commit()
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


def test_deleting_a_dataset_removes_its_export_archives():
    """Export archives outlive their dataset unless the delete removes them.

    Each export uploads a zip under datasets/<id>/, and nothing ever
    deleted them: 174 MB of archives belonging to datasets that no longer
    existed had accumulated in object storage, unreachable through the UI
    because the dataset row they hang off is gone.
    """
    headers = _register_and_login("del-dataset-archive@example.com")
    deleted_keys: list[str] = []

    class _RecordingStorage:
        def delete(self, key: str) -> None:
            deleted_keys.append(key)

        def url_for(self, key: str) -> str:
            return f"http://example/{key}"

    session = _session()
    try:
        user_id = session.execute(sa.text("SELECT id FROM users ORDER BY id DESC LIMIT 1")).scalar()
        dataset = _make_dataset(session, user_id)
        for suffix in ("a", "b"):
            session.add(
                Job(
                    job_type=JobType.DATASET_EXPORT,
                    status=JobStatus.SUCCEEDED,
                    payload={"dataset_id": dataset.id},
                    result_ref=f"datasets/{dataset.id}/export-{suffix}.zip",
                    created_by_id=user_id,
                )
            )
        session.commit()
        dataset_id = dataset.id
    finally:
        session.close()

    app.dependency_overrides[get_storage_service] = lambda: _RecordingStorage()
    try:
        response = client.delete(f"/datasets/{dataset_id}", headers=headers)
    finally:
        app.dependency_overrides.pop(get_storage_service, None)

    assert response.status_code == 204
    assert sorted(deleted_keys) == [
        f"datasets/{dataset_id}/export-a.zip",
        f"datasets/{dataset_id}/export-b.zip",
    ]


class _FakeStorage:
    def __init__(self, objects):
        self.objects = dict(objects)

    def delete(self, key):
        del self.objects[key]

    def url_for(self, key):
        return f"https://example.invalid/{key}"


def _make_version(
    session,
    storage_key: str,
    artifact_keys: list[str] | None = None,
    per_class_metrics: list[dict] | None = None,
    confusion_matrix: dict | None = None,
    history: list[dict] | None = None,
) -> ModelVersion:
    """Build a ModelVersion with the parent Dataset/TrainingRun/User rows it
    needs to satisfy real foreign keys, following the pattern established
    by _make_dataset/_make_run above. The dataset id is stashed on the
    returned object so callers can clean up the parent rows, since
    delete_model_version only removes the ModelVersion itself.

    `history` is written onto the parent TrainingRun.metrics_history, not
    onto the version, since per-epoch history belongs to the attempt
    rather than to the weights it produced.
    """
    headers = _register_and_login(f"artifact-delete-{storage_key}@example.com".replace("/", "-"))
    assert headers
    user_id = session.execute(sa.text("SELECT id FROM users ORDER BY id DESC LIMIT 1")).scalar()
    dataset = _make_dataset(session, user_id)
    run = _make_run(session, dataset, user_id)
    if history is not None:
        run.metrics_history = history
        session.add(run)
        session.commit()
        session.refresh(run)
    version = ModelVersion(
        training_run_id=run.id,
        name="artifact-delete-test",
        task_type=dataset.task_type,
        storage_key=storage_key,
        metrics={},
        artifact_keys=artifact_keys or [],
        per_class_metrics=per_class_metrics or [],
        confusion_matrix=confusion_matrix,
    )
    session.add(version)
    session.commit()
    session.refresh(version)
    version._test_dataset_id = dataset.id  # noqa: SLF001 -- test-only bookkeeping
    version._test_headers = headers  # noqa: SLF001 -- test-only bookkeeping
    return version


def test_deleting_a_model_version_removes_its_artifacts():
    session = _session()
    storage = _FakeStorage(objects={
        "models/9/best.pt": b"w",
        "models/9/artifacts/results.csv": b"epoch,loss\n",
        "models/9/artifacts/confusion_matrix.png": b"png",
    })
    version = _make_version(
        session,
        storage_key="models/9/best.pt",
        artifact_keys=[
            "models/9/artifacts/results.csv",
            "models/9/artifacts/confusion_matrix.png",
        ],
    )
    dataset_id = version._test_dataset_id  # noqa: SLF001

    service.delete_model_version(session, storage, version.id)

    assert storage.objects == {}
    assert session.get(ModelVersion, version.id) is None
    _cleanup(session, dataset_id)
    session.close()


def test_a_missing_artifact_does_not_block_the_delete():
    session = _session()
    storage = _FakeStorage(objects={"models/9/best.pt": b"w"})
    version = _make_version(
        session,
        storage_key="models/9/best.pt",
        artifact_keys=["models/9/artifacts/gone.csv"],
    )
    dataset_id = version._test_dataset_id  # noqa: SLF001

    service.delete_model_version(session, storage, version.id)

    assert session.get(ModelVersion, version.id) is None
    _cleanup(session, dataset_id)
    session.close()


def test_metrics_endpoint_returns_every_collection():
    session = _session()
    version = _make_version(
        session,
        storage_key="models/11/best.pt",
        artifact_keys=["models/11/artifacts/results.csv"],
        per_class_metrics=[{"class": "polyp", "mAP50": 0.7}],
        confusion_matrix={"labels": ["polyp", "background"], "matrix": [[4, 1], [0, 2]]},
        history=[{"epoch": 1, "train/loss": 0.5}],
    )
    version_id = version.id
    headers = version._test_headers  # noqa: SLF001
    dataset_id = version._test_dataset_id  # noqa: SLF001
    session.close()

    try:
        body = client.get(f"/training/models/{version_id}/metrics", headers=headers).json()

        assert body["history"] == [{"epoch": 1, "train/loss": 0.5}]
        assert body["per_class"][0]["class"] == "polyp"
        assert body["confusion"]["labels"][-1] == "background"
        assert body["artifacts"] == [{"name": "results.csv", "index": 0}]
    finally:
        cleanup_session = _session()
        _cleanup(cleanup_session, dataset_id)
        cleanup_session.close()


def test_metrics_endpoint_returns_empty_collections_not_404():
    session = _session()
    version = _make_version(session, storage_key="models/12/best.pt")
    version_id = version.id
    headers = version._test_headers  # noqa: SLF001
    dataset_id = version._test_dataset_id  # noqa: SLF001
    session.close()

    try:
        response = client.get(f"/training/models/{version_id}/metrics", headers=headers)

        assert response.status_code == 200
        assert response.json()["per_class"] == []
        assert response.json()["confusion"] is None
    finally:
        cleanup_session = _session()
        _cleanup(cleanup_session, dataset_id)
        cleanup_session.close()


def test_artifact_download_returns_a_url():
    session = _session()
    version = _make_version(
        session,
        storage_key="models/13/best.pt",
        artifact_keys=["models/13/artifacts/results.csv"],
    )
    version_id = version.id
    headers = version._test_headers  # noqa: SLF001
    dataset_id = version._test_dataset_id  # noqa: SLF001
    session.close()

    app.dependency_overrides[get_storage_service] = lambda: _FakeStorage(objects={})
    try:
        body = client.get(f"/training/models/{version_id}/artifacts/0", headers=headers).json()

        assert "results.csv" in body["download_url"]
    finally:
        app.dependency_overrides.pop(get_storage_service, None)
        cleanup_session = _session()
        _cleanup(cleanup_session, dataset_id)
        cleanup_session.close()


def test_an_out_of_range_artifact_index_is_404():
    session = _session()
    version = _make_version(session, storage_key="models/14/best.pt")
    version_id = version.id
    headers = version._test_headers  # noqa: SLF001
    dataset_id = version._test_dataset_id  # noqa: SLF001
    session.close()

    try:
        assert (
            client.get(f"/training/models/{version_id}/artifacts/7", headers=headers).status_code
            == 404
        )
    finally:
        cleanup_session = _session()
        _cleanup(cleanup_session, dataset_id)
        cleanup_session.close()


def _user_id(session, email: str) -> int:
    from app.auth.models import User

    return session.query(User).filter(User.email == email).one().id


def _make_parent_version(session, dataset: Dataset, user_id: int, name: str, task_type=TaskType.DETECTION):
    run = TrainingRun(
        dataset_id=dataset.id,
        adapter="ultralytics_yolo",
        base_model="yolo11n.pt",
        task_type=task_type,
        config={},
        status=TrainingRunStatus.SUCCEEDED,
        total_epochs=1,
        created_by_id=user_id,
    )
    session.add(run)
    session.commit()
    version = ModelVersion(
        training_run_id=run.id,
        name=name,
        task_type=task_type,
        storage_key=f"models/{run.id}/best.pt",
        metrics={"metrics/mAP50(B)": 0.61},
    )
    session.add(version)
    session.commit()
    session.refresh(version)
    return version


def _stub_send_task(monkeypatch):
    sent = []
    monkeypatch.setattr(service.celery_app, "send_task", lambda *a, **k: sent.append(a))
    return sent


def test_base_models_lists_five_pretrained_for_the_datasets_task_type():
    email = "train-bm1@example.com"
    headers = _register_and_login(email)
    session = _session()
    dataset = _make_dataset(session, _user_id(session, email))
    try:
        response = client.get(f"/training/base-models?dataset_id={dataset.id}", headers=headers)

        assert response.status_code == 200
        pretrained = [o for o in response.json() if o["kind"] == "pretrained"]
        assert [o["weights"] for o in pretrained] == [
            f"yolo11{s}.pt" for s in ("n", "s", "m", "l", "x")
        ]
        assert [o["note"] for o in pretrained][3:] == ["may not fit in 8 GB"] * 2
    finally:
        _cleanup(session, dataset.id)
        session.close()


def test_base_models_adds_only_versions_of_the_same_task_type():
    email = "train-bm2@example.com"
    headers = _register_and_login(email)
    session = _session()
    user_id = _user_id(session, email)
    dataset = _make_dataset(session, user_id)
    other = _make_dataset(session, user_id)
    try:
        mine = _make_parent_version(session, dataset, user_id, "det-v1", TaskType.DETECTION)
        _make_parent_version(session, other, user_id, "seg-v1", TaskType.SEGMENTATION)

        response = client.get(f"/training/base-models?dataset_id={dataset.id}", headers=headers)

        versions = [o for o in response.json() if o["kind"] == "model_version"]
        assert [(v["model_version_id"], v["label"]) for v in versions] == [(mine.id, "det-v1")]
        assert versions[0]["weights"] is None
        assert "mAP50 0.610" in versions[0]["note"]
    finally:
        _cleanup(session, dataset.id)
        _cleanup(session, other.id)
        session.close()


def test_base_models_unknown_dataset_is_404():
    headers = _register_and_login("train-bm3@example.com")

    assert client.get("/training/base-models?dataset_id=99999999", headers=headers).status_code == 404


def _create(headers, dataset_id, **overrides):
    body = {"dataset_id": dataset_id, "epochs": 1, "batch": 2, **overrides}
    return client.post("/training/runs", json=body, headers=headers)


def test_create_run_requires_exactly_one_base(monkeypatch):
    email = "train-bm4@example.com"
    headers = _register_and_login(email)
    session = _session()
    user_id = _user_id(session, email)
    dataset = _make_dataset(session, user_id)
    _succeeded_export(session, dataset.id, user_id)
    _stub_send_task(monkeypatch)
    try:
        neither = _create(headers, dataset.id)
        both = _create(headers, dataset.id, base_model="yolo11n.pt", base_model_version_id=1)

        assert neither.status_code == 422
        assert both.status_code == 422
    finally:
        _cleanup(session, dataset.id)
        session.close()


def test_create_run_rejects_a_name_not_in_the_catalog(monkeypatch):
    email = "train-bm5@example.com"
    headers = _register_and_login(email)
    session = _session()
    user_id = _user_id(session, email)
    dataset = _make_dataset(session, user_id)
    _succeeded_export(session, dataset.id, user_id)
    _stub_send_task(monkeypatch)
    try:
        response = _create(headers, dataset.id, base_model="yolo11n-cls.pt")  # wrong task

        assert response.status_code == 422
    finally:
        _cleanup(session, dataset.id)
        session.close()


def test_create_run_normalises_the_legacy_name_for_segmentation(monkeypatch):
    email = "train-bm6@example.com"
    headers = _register_and_login(email)
    session = _session()
    user_id = _user_id(session, email)
    dataset = _make_dataset(session, user_id)
    dataset.task_type = TaskType.SEGMENTATION
    session.commit()
    _succeeded_export(session, dataset.id, user_id)
    _stub_send_task(monkeypatch)
    try:
        response = _create(headers, dataset.id, base_model="yolo11s.pt")

        assert response.status_code == 202
        assert response.json()["base_model"] == "yolo11s-seg.pt"
        assert response.json()["base_model_version_id"] is None
    finally:
        _cleanup(session, dataset.id)
        session.close()


def test_create_run_from_a_version_records_the_parent(monkeypatch):
    email = "train-bm7@example.com"
    headers = _register_and_login(email)
    session = _session()
    user_id = _user_id(session, email)
    dataset = _make_dataset(session, user_id)
    _succeeded_export(session, dataset.id, user_id)
    parent = _make_parent_version(session, dataset, user_id, "det-parent")
    _stub_send_task(monkeypatch)
    try:
        response = _create(headers, dataset.id, base_model_version_id=parent.id)

        assert response.status_code == 202
        assert response.json()["base_model_version_id"] == parent.id
        assert response.json()["base_model"] == "det-parent"
    finally:
        _cleanup(session, dataset.id)
        session.close()


def test_create_run_rejects_a_version_of_another_task_type(monkeypatch):
    email = "train-bm8@example.com"
    headers = _register_and_login(email)
    session = _session()
    user_id = _user_id(session, email)
    dataset = _make_dataset(session, user_id)
    _succeeded_export(session, dataset.id, user_id)
    seg_parent = _make_parent_version(session, dataset, user_id, "seg-parent", TaskType.SEGMENTATION)
    _stub_send_task(monkeypatch)
    try:
        response = _create(headers, dataset.id, base_model_version_id=seg_parent.id)

        assert response.status_code == 422
        assert "segmentation" in response.json()["detail"].lower()
    finally:
        _cleanup(session, dataset.id)
        session.close()


def test_create_run_rejects_an_unknown_version(monkeypatch):
    email = "train-bm9@example.com"
    headers = _register_and_login(email)
    session = _session()
    user_id = _user_id(session, email)
    dataset = _make_dataset(session, user_id)
    _succeeded_export(session, dataset.id, user_id)
    _stub_send_task(monkeypatch)
    try:
        assert _create(headers, dataset.id, base_model_version_id=99999999).status_code == 422
    finally:
        _cleanup(session, dataset.id)
        session.close()
