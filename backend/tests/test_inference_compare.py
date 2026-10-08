import json

import pytest

import app.db as db_module
import app.main  # noqa: F401
from app.inference.compare import disagreements
from app.inference.models import InferenceRun, InferenceRunStatus
from app.main import app
from app.storage import get_storage_service
from fastapi.testclient import TestClient

client = TestClient(app)


def _doc(classes, frames):
    return {
        "classes": classes,
        "frames": {
            str(i): {"timestamp_ms": i * 40, "detections": dets}
            for i, dets in frames.items()
        },
    }


def _d(class_id, confidence):
    return {"class_id": class_id, "confidence": confidence, "bbox": [0, 0, 1, 1]}


def test_frames_with_equal_class_sets_do_not_disagree():
    a = _doc(["polyp"], {0: [_d(0, 0.9)], 1: []})
    b = _doc(["polyp"], {0: [_d(0, 0.5)], 1: []})
    assert disagreements(a, b, 0.25, 0.25) == []


def test_only_a_and_only_b_are_reported_by_name():
    a = _doc(["polyp", "foam"], {0: [_d(0, 0.9)], 1: []})
    b = _doc(["polyp", "foam"], {0: [], 1: [_d(1, 0.8)]})
    assert disagreements(a, b, 0.25, 0.25) == [
        {"frame": 0, "timestamp_ms": 0, "only_a": ["polyp"], "only_b": []},
        {"frame": 1, "timestamp_ms": 40, "only_a": [], "only_b": ["foam"]},
    ]


def test_classes_are_compared_by_name_not_id():
    a = _doc(["polyp", "foam"], {0: [_d(0, 0.9)]})
    b = _doc(["foam", "polyp"], {0: [_d(1, 0.9)]})
    assert disagreements(a, b, 0.25, 0.25) == []


def test_each_side_uses_its_own_confidence_threshold():
    a = _doc(["polyp"], {0: [_d(0, 0.4)]})
    b = _doc(["polyp"], {0: [_d(0, 0.4)]})
    assert disagreements(a, b, 0.3, 0.5) == [
        {"frame": 0, "timestamp_ms": 0, "only_a": ["polyp"], "only_b": []}
    ]


def test_frame_missing_from_b_is_skipped_and_empty_docs_give_nothing():
    a = _doc(["polyp"], {0: [_d(0, 0.9)], 5: [_d(0, 0.9)]})
    b = _doc(["polyp"], {0: [_d(0, 0.9)]})
    assert disagreements(a, b, 0.25, 0.25) == []
    assert disagreements(_doc([], {}), _doc([], {}), 0.25, 0.25) == []


# --- endpoint ---------------------------------------------------------------

def _login(email):
    client.post("/auth/register", json={"email": email, "password": "pass1234", "role": "admin"})
    token = client.post("/auth/login", json={"email": email, "password": "pass1234"}).json()["access_token"]
    return {"Authorization": f"Bearer {token}"}


class _Storage:
    def __init__(self, docs):
        self.docs = docs

    def download(self, key):
        return json.dumps(self.docs[key]).encode()


def _make_run(rows, *, key, stride=1, status=InferenceRunStatus.SUCCEEDED, video_id=None):
    session = db_module.SessionLocal()
    try:
        run = InferenceRun(
            video_id=video_id or rows.video_id,
            model_version_id=rows.detect_version_id,
            model_name="m",
            frame_stride=stride,
            status=status,
            predictions_key=key,
            created_by_id=rows.user_id,
        )
        session.add(run)
        session.commit()
        return run.id
    finally:
        session.close()


@pytest.fixture
def storage():
    docs = {
        "cmp/a.json": _doc(["polyp"], {0: [_d(0, 0.9)], 1: []}),
        "cmp/b.json": _doc(["polyp"], {0: [], 1: []}),
    }
    app.dependency_overrides[get_storage_service] = lambda: _Storage(docs)
    yield docs
    app.dependency_overrides.pop(get_storage_service, None)


def _compare(headers, a, b, **params):
    return client.get("/inference/compare", params={"run_a": a, "run_b": b, **params}, headers=headers)


def test_compare_returns_the_disagreeing_frames(committed_inference_rows, storage):
    headers = _login("cmp1@example.com")
    a = _make_run(committed_inference_rows, key="cmp/a.json")
    b = _make_run(committed_inference_rows, key="cmp/b.json")
    response = _compare(headers, a, b)
    assert response.status_code == 200
    assert response.json() == {
        "frames": [{"frame": 0, "timestamp_ms": 0, "only_a": ["polyp"], "only_b": []}],
        "total": 2,
        "disagreements": 1,
    }


def test_compare_refuses_the_same_run_twice(committed_inference_rows, storage):
    headers = _login("cmp2@example.com")
    a = _make_run(committed_inference_rows, key="cmp/a.json")
    assert _compare(headers, a, a).status_code == 409


def test_compare_refuses_different_strides_and_unfinished_runs(committed_inference_rows, storage):
    headers = _login("cmp3@example.com")
    a = _make_run(committed_inference_rows, key="cmp/a.json")
    strided = _make_run(committed_inference_rows, key="cmp/b.json", stride=5)
    running = _make_run(committed_inference_rows, key=None, status=InferenceRunStatus.RUNNING)
    assert _compare(headers, a, strided).status_code == 409
    assert _compare(headers, a, running).status_code == 409


def test_compare_refuses_runs_of_different_videos(committed_inference_rows, storage):
    from app.media.models import Video

    headers = _login("cmp4@example.com")
    rows = committed_inference_rows
    session = db_module.SessionLocal()
    try:
        other = session.get(Video, rows.video_id)
        clone = Video(
            storage_key="videos/cmp-other.mp4", filename="cmp-other.mp4", title="cmp other",
            fps=10, duration_seconds=1, size_bytes=1, checksum="cmp-other",
        )
        session.add(clone)
        session.commit()
        clone_id = clone.id
    finally:
        session.close()
    try:
        a = _make_run(rows, key="cmp/a.json")
        b = _make_run(rows, key="cmp/b.json", video_id=clone_id)
        assert _compare(headers, a, b).status_code == 409
    finally:
        session = db_module.SessionLocal()
        try:
            session.query(InferenceRun).filter(InferenceRun.video_id == clone_id).delete()
            session.query(Video).filter(Video.id == clone_id).delete()
            session.commit()
        finally:
            session.close()


def test_compare_unknown_run_is_404_and_bad_confidence_is_422(committed_inference_rows, storage):
    headers = _login("cmp5@example.com")
    a = _make_run(committed_inference_rows, key="cmp/a.json")
    assert _compare(headers, a, 99999999).status_code == 404
    assert _compare(headers, a, a, conf_a=1.5).status_code == 422
    assert _compare(headers, a, a, conf_a="nan").status_code == 422
