import app.db as db_module
import app.main  # noqa: F401 -- registers every model on Base.metadata
from fastapi.testclient import TestClient

from app.inference.models import InferenceRun, InferenceRunStatus, QcFlag
from app.main import app
from app.storage import get_storage_service

client = TestClient(app)


def _register_and_login(email: str) -> dict[str, str]:
    client.post("/auth/register", json={"email": email, "password": "pass1234", "role": "admin"})
    response = client.post("/auth/login", json={"email": email, "password": "pass1234"})
    return {"Authorization": f"Bearer {response.json()['access_token']}"}


def _make_run(rows, *, status=InferenceRunStatus.SUCCEEDED, frame_stride=5, video_id=None) -> int:
    session = db_module.SessionLocal()
    try:
        run = InferenceRun(
            video_id=video_id or rows.video_id,
            model_version_id=rows.detect_version_id,
            model_name="seed-detection",
            frame_stride=frame_stride,
            status=status,
            created_by_id=rows.user_id,
        )
        session.add(run)
        session.commit()
        return run.id
    finally:
        session.close()


def _put(headers, run_id, frame_index=5, kind="fp", note=None, timestamp_ms=None):
    body = {
        "frame_index": frame_index,
        "timestamp_ms": frame_index * 100 if timestamp_ms is None else timestamp_ms,
        "kind": kind,
    }
    if note is not None:
        body["note"] = note
    return client.put(f"/inference/runs/{run_id}/flags", headers=headers, json=body)


def test_putting_a_flag_creates_it(committed_inference_rows):
    headers = _register_and_login("flag-create@example.com")
    run_id = _make_run(committed_inference_rows)

    response = _put(headers, run_id, frame_index=10, kind="fn", note="missed polyp")

    assert response.status_code == 200
    body = response.json()
    assert body["run_id"] == run_id
    assert body["kind"] == "fn"
    assert body["frame_index"] == 10
    assert body["timestamp_ms"] == 1000
    assert body["note"] == "missed polyp"
    assert body["committed_at"] is None
    assert body["frame_id"] is None
    assert body["sequence_id"] is None


def test_putting_the_same_frame_again_changes_the_kind_and_note(committed_inference_rows):
    headers = _register_and_login("flag-change@example.com")
    run_id = _make_run(committed_inference_rows)
    first = _put(headers, run_id, kind="fp").json()

    second = _put(headers, run_id, kind="fn", note="actually a miss").json()

    assert second["id"] == first["id"]
    assert second["kind"] == "fn"
    assert second["note"] == "actually a miss"
    assert len(client.get(f"/inference/runs/{run_id}/flags", headers=headers).json()) == 1


def test_a_frame_the_model_never_processed_is_refused(committed_inference_rows):
    headers = _register_and_login("flag-stride@example.com")
    run_id = _make_run(committed_inference_rows, frame_stride=5)

    response = _put(headers, run_id, frame_index=7)

    assert response.status_code == 422
    assert "processed" in response.json()["detail"].lower()
    assert client.get(f"/inference/runs/{run_id}/flags", headers=headers).json() == []


def test_stride_one_accepts_every_frame(committed_inference_rows):
    headers = _register_and_login("flag-stride1@example.com")
    run_id = _make_run(committed_inference_rows, frame_stride=1)
    assert _put(headers, run_id, frame_index=7).status_code == 200


def test_a_run_that_has_not_succeeded_cannot_be_flagged(committed_inference_rows):
    headers = _register_and_login("flag-notready@example.com")
    run_id = _make_run(committed_inference_rows, status=InferenceRunStatus.RUNNING)
    assert _put(headers, run_id).status_code == 409


def test_an_unknown_run_is_404(committed_inference_rows):
    headers = _register_and_login("flag-norun@example.com")
    assert _put(headers, 999999).status_code == 404
    assert client.get("/inference/runs/999999/flags", headers=headers).status_code == 404


def test_a_negative_frame_index_is_rejected(committed_inference_rows):
    headers = _register_and_login("flag-negative@example.com")
    run_id = _make_run(committed_inference_rows)
    assert _put(headers, run_id, frame_index=-5).status_code == 422


def test_a_note_longer_than_500_characters_is_rejected(committed_inference_rows):
    headers = _register_and_login("flag-longnote@example.com")
    run_id = _make_run(committed_inference_rows)
    assert _put(headers, run_id, note="x" * 501).status_code == 422
    assert _put(headers, run_id, note="x" * 500).status_code == 200


def test_listing_is_ordered_by_frame(committed_inference_rows):
    headers = _register_and_login("flag-list@example.com")
    run_id = _make_run(committed_inference_rows)
    for frame_index in (20, 0, 10):
        _put(headers, run_id, frame_index=frame_index)

    listed = client.get(f"/inference/runs/{run_id}/flags", headers=headers).json()

    assert [flag["frame_index"] for flag in listed] == [0, 10, 20]


def test_a_pending_flag_can_be_removed(committed_inference_rows):
    headers = _register_and_login("flag-remove@example.com")
    run_id = _make_run(committed_inference_rows)
    flag_id = _put(headers, run_id).json()["id"]

    assert client.delete(f"/inference/runs/{run_id}/flags/{flag_id}", headers=headers).status_code == 204
    assert client.get(f"/inference/runs/{run_id}/flags", headers=headers).json() == []


def test_removing_an_unknown_flag_or_one_of_another_run_is_404(committed_inference_rows):
    headers = _register_and_login("flag-remove404@example.com")
    run_a = _make_run(committed_inference_rows)
    run_b = _make_run(committed_inference_rows)
    flag_id = _put(headers, run_a).json()["id"]

    assert client.delete(f"/inference/runs/{run_a}/flags/999999", headers=headers).status_code == 404
    assert client.delete(f"/inference/runs/{run_b}/flags/{flag_id}", headers=headers).status_code == 404


def _commit_a_flag_directly(run_id: int, frame_index: int = 5) -> int:
    """Mark a flag as already sent, without going through the commit endpoint."""
    from datetime import datetime, timezone

    session = db_module.SessionLocal()
    try:
        flag = session.query(QcFlag).filter_by(run_id=run_id, frame_index=frame_index).one()
        flag.committed_at = datetime.now(timezone.utc)
        session.commit()
        return flag.id
    finally:
        session.close()


def test_a_sent_flag_can_neither_be_changed_nor_removed(committed_inference_rows):
    headers = _register_and_login("flag-sent@example.com")
    run_id = _make_run(committed_inference_rows)
    flag_id = _put(headers, run_id, frame_index=5).json()["id"]
    _commit_a_flag_directly(run_id, 5)

    again = _put(headers, run_id, frame_index=5, kind="fn")
    removed = client.delete(f"/inference/runs/{run_id}/flags/{flag_id}", headers=headers)

    assert again.status_code == 409
    assert "sent" in again.json()["detail"].lower()
    assert removed.status_code == 409


def test_the_run_reports_how_many_flags_are_pending_and_sent(committed_inference_rows):
    headers = _register_and_login("flag-counts@example.com")
    run_id = _make_run(committed_inference_rows)
    _put(headers, run_id, frame_index=0)
    _put(headers, run_id, frame_index=5)
    _put(headers, run_id, frame_index=10)
    _commit_a_flag_directly(run_id, 0)

    as_list = [r for r in client.get("/inference/runs", headers=headers).json() if r["id"] == run_id][0]
    as_one = client.get(f"/inference/runs/{run_id}", headers=headers).json()

    assert (as_list["flags_pending"], as_list["flags_committed"]) == (2, 1)
    assert (as_one["flags_pending"], as_one["flags_committed"]) == (2, 1)


def test_a_run_with_no_flags_reports_zero(committed_inference_rows):
    headers = _register_and_login("flag-zero@example.com")
    run_id = _make_run(committed_inference_rows)
    body = client.get(f"/inference/runs/{run_id}", headers=headers).json()
    assert (body["flags_pending"], body["flags_committed"]) == (0, 0)


def test_deleting_a_run_deletes_its_pending_flags(committed_inference_rows):
    headers = _register_and_login("flag-rundelete@example.com")
    run_id = _make_run(committed_inference_rows)
    _put(headers, run_id)

    class _NoStorage:
        def delete(self, key):  # a run with no predictions has nothing to delete
            raise AssertionError("nothing should be deleted from storage")

    app.dependency_overrides[get_storage_service] = lambda: _NoStorage()
    try:
        assert client.delete(f"/inference/runs/{run_id}", headers=headers).status_code == 204
    finally:
        app.dependency_overrides.pop(get_storage_service, None)

    session = db_module.SessionLocal()
    try:
        assert session.query(QcFlag).filter_by(run_id=run_id).count() == 0
    finally:
        session.close()
