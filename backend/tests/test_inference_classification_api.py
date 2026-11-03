import pytest
import app.db as db_module
import app.main  # noqa: F401 -- registers every model on Base.metadata
from fastapi.testclient import TestClient

from app.inference.models import InferenceRun
from app.jobs.models import Job
from app.main import app
from app.taxonomy.models import AnnotationScope, Category, EvaluationType, Label, Procedure
from app.training.models import ModelVersion, TrainingRun

client = TestClient(app)


@pytest.fixture(autouse=True)
def _no_celery(monkeypatch):
    sent: list[tuple] = []
    monkeypatch.setattr(
        "app.inference.service.celery_app.send_task",
        lambda name, args=None, **kwargs: sent.append((name, args)),
    )
    return sent


def _headers(email: str) -> dict[str, str]:
    client.post("/auth/register", json={"email": email, "password": "pass1234", "role": "admin"})
    response = client.post("/auth/login", json={"email": email, "password": "pass1234"})
    return {"Authorization": f"Bearer {response.json()['access_token']}"}


@pytest.fixture
def classifiers(committed_inference_rows):
    """Two YOLO classification versions with class names, plus a taxonomy for one."""
    rows = committed_inference_rows
    session = db_module.SessionLocal()
    base_run = session.get(
        ModelVersion, rows.classify_version_id
    ).training_run
    created_runs: list[int] = []
    versions: list[int] = []

    def _version(name: str, class_names: list[str], adapter: str = "ultralytics_yolo") -> int:
        run = TrainingRun(
            dataset_id=base_run.dataset_id,
            adapter=adapter,
            base_model="yolo11n-cls.pt",
            task_type=base_run.task_type,
            config={},
            total_epochs=1,
            created_by_id=rows.user_id,
        )
        session.add(run)
        session.commit()
        created_runs.append(run.id)
        version = ModelVersion(
            training_run_id=run.id,
            name=name,
            task_type=base_run.task_type,
            storage_key=f"models/{run.id}/best.pt",
            class_names=class_names,
        )
        session.add(version)
        session.commit()
        versions.append(version.id)
        return version.id

    procedure = Procedure(name="qcc-proc")
    evaluation_type = EvaluationType(name="qcc-eval", annotation_scope=AnnotationScope.FRAME)
    session.add_all([procedure, evaluation_type])
    session.flush()
    category = Category(name="QccQuality", procedure_id=procedure.id)
    session.add(category)
    session.flush()
    for label in ("qcc_good", "qcc_bad"):
        session.add(
            Label(name=label, category_id=category.id, evaluation_type_id=evaluation_type.id)
        )
    session.commit()
    ids = (procedure.id, evaluation_type.id, category.id)

    from types import SimpleNamespace

    ns = SimpleNamespace(
        quality=_version("qcc-quality", ["qcc_good", "qcc_bad"]),
        other=_version("qcc-other", ["qcc_x", "qcc_y"]),
        empty=_version("qcc-empty", []),
        dino=_version("qcc-dino", ["qcc_a", "qcc_b"], adapter="dinov3_classifier"),
        category_id=category.id,
        make=_version,
    )
    yield ns

    session.rollback()
    run_ids = [r.id for r in session.query(InferenceRun).filter(
        InferenceRun.video_id.in_([rows.playable_video_id, rows.unplayable_video_id])).all()]
    job_ids = [r.job_id for r in session.query(InferenceRun).filter(
        InferenceRun.id.in_(run_ids)).all() if r.job_id]
    session.query(InferenceRun).filter(InferenceRun.id.in_(run_ids)).delete(
        synchronize_session=False
    )
    if job_ids:
        session.query(Job).filter(Job.id.in_(job_ids)).delete(synchronize_session=False)
    session.query(ModelVersion).filter(ModelVersion.id.in_(versions)).delete(
        synchronize_session=False
    )
    session.query(TrainingRun).filter(TrainingRun.id.in_(created_runs)).delete(
        synchronize_session=False
    )
    session.query(Label).filter(Label.category_id == ids[2]).delete(synchronize_session=False)
    session.query(Category).filter(Category.id == ids[2]).delete(synchronize_session=False)
    session.query(EvaluationType).filter(EvaluationType.id == ids[1]).delete(
        synchronize_session=False
    )
    session.query(Procedure).filter(Procedure.id == ids[0]).delete(synchronize_session=False)
    session.commit()
    session.close()


def _post(headers, rows, **body):
    return client.post(
        "/inference/runs",
        headers=headers,
        json={"video_id": rows.video_id, "frame_stride": 5, **body},
    )


def test_two_axes_create_a_classification_run(committed_inference_rows, classifiers):
    headers = _headers("qcc-happy@example.com")
    response = _post(
        headers,
        committed_inference_rows,
        classifiers=[
            {"model_version_id": classifiers.quality},
            {"model_version_id": classifiers.other, "name": "Other axis"},
        ],
    )
    assert response.status_code == 202, response.text
    body = response.json()
    assert body["task_type"] == "classification"
    assert body["model_version_id"] is None
    assert body["model_name"] == "QccQuality, Other axis"
    assert body["axes"][0] == {
        "model_version_id": classifiers.quality,
        "model_name": "qcc-quality",
        "name": "QccQuality",
        "category_id": classifiers.category_id,
        "classes": ["qcc_good", "qcc_bad"],
    }
    assert body["axes"][1]["name"] == "Other axis"
    assert body["axes"][1]["category_id"] is None
    session = db_module.SessionLocal()
    try:
        payload = session.get(Job, body["job_id"]).payload
    finally:
        session.close()
    assert payload["task_type"] == "classification"
    assert payload["inference_run_id"] == body["id"]
    assert payload["frame_stride"] == 5
    assert payload["perturbation"] is None
    assert payload["model_name"] == body["model_name"]
    assert [a["name"] for a in payload["axes"]] == ["QccQuality", "Other axis"]
    assert payload["axes"][0]["weights_key"].endswith("/best.pt")
    assert payload["axes"][0]["classes"] == ["qcc_good", "qcc_bad"]


def test_both_or_neither_of_model_and_classifiers_is_422(committed_inference_rows, classifiers):
    headers = _headers("qcc-xor@example.com")
    both = _post(
        headers, committed_inference_rows,
        model_version_id=committed_inference_rows.detect_version_id,
        classifiers=[{"model_version_id": classifiers.quality}],
    )
    neither = _post(headers, committed_inference_rows)
    empty = _post(headers, committed_inference_rows, classifiers=[])
    too_many = _post(
        headers, committed_inference_rows,
        classifiers=[{"model_version_id": classifiers.quality, "name": f"a{i}"} for i in range(7)],
    )
    assert [both.status_code, neither.status_code, empty.status_code, too_many.status_code] == [422] * 4


def test_a_detection_model_is_refused(committed_inference_rows, classifiers):
    response = _post(
        _headers("qcc-det@example.com"), committed_inference_rows,
        classifiers=[{"model_version_id": committed_inference_rows.detect_version_id, "name": "x"}],
    )
    assert response.status_code == 422


def test_a_dinov3_version_is_refused(committed_inference_rows, classifiers):
    response = _post(
        _headers("qcc-dino@example.com"), committed_inference_rows,
        classifiers=[{"model_version_id": classifiers.dino, "name": "x"}],
    )
    assert response.status_code == 422
    assert "dinov3_classifier" in response.json()["detail"]


def test_a_version_without_class_names_is_refused(committed_inference_rows, classifiers):
    response = _post(
        _headers("qcc-empty@example.com"), committed_inference_rows,
        classifiers=[{"model_version_id": classifiers.empty, "name": "x"}],
    )
    assert response.status_code == 422
    assert "class" in response.json()["detail"].lower()


def test_duplicate_axis_names_are_refused(committed_inference_rows, classifiers):
    response = _post(
        _headers("qcc-dup@example.com"), committed_inference_rows,
        classifiers=[
            {"model_version_id": classifiers.quality, "name": "Same"},
            {"model_version_id": classifiers.other, "name": "Same"},
        ],
    )
    assert response.status_code == 422
    assert "Same" in response.json()["detail"]


def test_an_uninferable_name_needs_an_explicit_one(committed_inference_rows, classifiers):
    response = _post(
        _headers("qcc-noname@example.com"), committed_inference_rows,
        classifiers=[{"model_version_id": classifiers.other}],
    )
    assert response.status_code == 422
    assert "name" in response.json()["detail"].lower()


def test_an_explicit_name_wins_over_inference(committed_inference_rows, classifiers):
    response = _post(
        _headers("qcc-explicit@example.com"), committed_inference_rows,
        classifiers=[{"model_version_id": classifiers.quality, "name": "Mine"}],
    )
    assert response.status_code == 202
    assert response.json()["axes"][0]["name"] == "Mine"


def test_an_explicit_category_id_is_kept(committed_inference_rows, classifiers):
    response = _post(
        _headers("qcc-cat@example.com"), committed_inference_rows,
        classifiers=[{"model_version_id": classifiers.other, "name": "Z", "category_id": 4242}],
    )
    assert response.status_code == 202
    assert response.json()["axes"][0]["category_id"] == 4242


def test_unknown_model_is_404_and_unplayable_video_is_409(committed_inference_rows, classifiers):
    headers = _headers("qcc-errors@example.com")
    unknown = _post(
        headers, committed_inference_rows,
        classifiers=[{"model_version_id": 999999, "name": "x"}],
    )
    unplayable = _post(
        headers, committed_inference_rows,
        video_id=committed_inference_rows.unplayable_video_id,
        classifiers=[{"model_version_id": classifiers.quality}],
    )
    assert unknown.status_code == 404
    assert unplayable.status_code == 409


def test_deleting_an_axis_model_version_keeps_the_axes_snapshot(
    committed_inference_rows, classifiers
):
    headers = _headers("qcc-survive@example.com")
    run_id = _post(
        headers, committed_inference_rows,
        classifiers=[{"model_version_id": classifiers.quality}],
    ).json()["id"]
    session = db_module.SessionLocal()
    try:
        session.query(ModelVersion).filter(ModelVersion.id == classifiers.quality).delete()
        session.commit()
    finally:
        session.close()

    body = client.get(f"/inference/runs/{run_id}", headers=headers).json()
    assert body["task_type"] == "classification"
    assert body["axes"][0]["name"] == "QccQuality"
    assert body["axes"][0]["classes"] == ["qcc_good", "qcc_bad"]
