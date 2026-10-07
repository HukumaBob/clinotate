import tempfile

import app.db as db_module
import app.main  # noqa: F401 -- registers every model on Base.metadata
import cv2
import numpy as np
import pytest
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


from app.media.models import Frame, Sequence


def make_video(frames: int = 30, fps: int = 10, size=(64, 48)) -> bytes:
    """Frame i is a flat gray of value i * 8, so a frame's content names its number."""
    with tempfile.NamedTemporaryFile(suffix=".avi") as tmp:
        writer = cv2.VideoWriter(tmp.name, cv2.VideoWriter_fourcc(*"MJPG"), fps, size)
        for i in range(frames):
            writer.write(np.full((size[1], size[0], 3), i * 8, dtype=np.uint8))
        writer.release()
        return open(tmp.name, "rb").read()


class FakeStorage:
    def __init__(self, objects=None, fail_on_upload=None):
        self.objects = dict(objects or {})
        self.fail_on_upload = fail_on_upload
        self.uploads = 0

    def download(self, key):
        return self.objects[key]

    def upload(self, key, data, content_type):
        self.uploads += 1
        if self.fail_on_upload == self.uploads:
            raise RuntimeError("storage down")
        self.objects[key] = data

    def delete(self, key):
        self.objects.pop(key, None)

    def url_for(self, key):
        return f"http://example/{key}"


@pytest.fixture
def fake_storage(committed_inference_rows):
    storage = FakeStorage({"videos/inference-playable.mp4": make_video()})
    app.dependency_overrides[get_storage_service] = lambda: storage
    yield storage
    app.dependency_overrides.pop(get_storage_service, None)


def _commit(headers, run_id, **body):
    return client.post(f"/inference/runs/{run_id}/commit", headers=headers, json=body)


def _flag_three(headers, run_id):
    _put(headers, run_id, frame_index=0, kind="fp")
    _put(headers, run_id, frame_index=10, kind="fn")
    _put(headers, run_id, frame_index=25, kind="fp")


def _my_id(headers) -> int:
    return client.get("/auth/me", headers=headers).json()["id"]


def test_commit_creates_a_sequence_with_the_flagged_frames(committed_inference_rows, fake_storage):
    headers = _register_and_login("commit-happy@example.com")
    rows = committed_inference_rows
    run_id = _make_run(rows)
    _flag_three(headers, run_id)

    response = _commit(headers, run_id)

    assert response.status_code == 201
    sequence = response.json()
    assert sequence["video_id"] == rows.video_id
    assert sequence["origin_qc_run_id"] == run_id
    assert sequence["name"].startswith("QC · inference-playable · run #")
    assert sequence["annotation_count"] == 0

    session = db_module.SessionLocal()
    try:
        frames = (
            session.query(Frame).filter_by(sequence_id=sequence["id"]).order_by(Frame.frame_index).all()
        )
        assert [f.frame_index for f in frames] == [0, 1, 2]
        assert [f.no_findings_reviewed for f in frames] == [True, False, True]  # fp, fn, fp
        assert frames[0].no_findings_reviewed_by_id == _my_id(headers)
        assert frames[1].no_findings_reviewed_by_id is None
        assert (frames[0].width, frames[0].height) == (64, 48)
        # the frame is the one asked for: flat gray of value index * 8
        for frame, source_index in zip(frames, (0, 10, 25)):
            decoded = cv2.imdecode(
                np.frombuffer(fake_storage.objects[frame.storage_key], np.uint8), cv2.IMREAD_COLOR
            )
            assert float(decoded.mean()) == pytest.approx(source_index * 8, abs=6)
        stored = session.query(QcFlag).filter_by(run_id=run_id).order_by(QcFlag.frame_index).all()
        assert all(flag.committed_at is not None for flag in stored)
        assert [flag.frame_id for flag in stored] == [f.id for f in frames]
        seq_row = session.get(Sequence, sequence["id"])
        assert seq_row.start_time == 0
        assert seq_row.duration == 3  # 0 ms to 2500 ms, rounded up
    finally:
        session.close()


def test_the_flag_list_then_points_at_the_sequence(committed_inference_rows, fake_storage):
    headers = _register_and_login("commit-listing@example.com")
    run_id = _make_run(committed_inference_rows)
    _flag_three(headers, run_id)
    sequence_id = _commit(headers, run_id).json()["id"]

    listed = client.get(f"/inference/runs/{run_id}/flags", headers=headers).json()

    assert {flag["sequence_id"] for flag in listed} == {sequence_id}
    assert all(flag["committed_at"] is not None for flag in listed)
    run = client.get(f"/inference/runs/{run_id}", headers=headers).json()
    assert (run["flags_pending"], run["flags_committed"]) == (0, 3)


def test_a_second_commit_finds_nothing_pending(committed_inference_rows, fake_storage):
    headers = _register_and_login("commit-twice@example.com")
    run_id = _make_run(committed_inference_rows)
    _flag_three(headers, run_id)
    assert _commit(headers, run_id).status_code == 201
    uploads_after_first = fake_storage.uploads

    second = _commit(headers, run_id)

    assert second.status_code == 409
    assert "pending" in second.json()["detail"].lower()
    assert fake_storage.uploads == uploads_after_first


def test_commit_without_flags_is_409(committed_inference_rows, fake_storage):
    headers = _register_and_login("commit-empty@example.com")
    assert _commit(headers, _make_run(committed_inference_rows)).status_code == 409


def test_commit_on_a_run_that_has_not_succeeded_is_409(committed_inference_rows, fake_storage):
    headers = _register_and_login("commit-notready@example.com")
    run_id = _make_run(committed_inference_rows, status=InferenceRunStatus.FAILED)
    assert _commit(headers, run_id).status_code == 409


def test_commit_on_an_unknown_run_is_404(committed_inference_rows, fake_storage):
    headers = _register_and_login("commit-404@example.com")
    assert _commit(headers, 999999).status_code == 404


def test_a_custom_name_is_used(committed_inference_rows, fake_storage):
    headers = _register_and_login("commit-name@example.com")
    run_id = _make_run(committed_inference_rows)
    _put(headers, run_id, frame_index=5)

    response = _commit(headers, run_id, name="Hard negatives, May")

    assert response.json()["name"] == "Hard negatives, May"


def test_a_name_longer_than_255_characters_is_rejected(committed_inference_rows, fake_storage):
    headers = _register_and_login("commit-longname@example.com")
    run_id = _make_run(committed_inference_rows)
    _put(headers, run_id, frame_index=5)
    assert _commit(headers, run_id, name="x" * 256).status_code == 422


def test_a_frame_past_the_end_of_the_video_creates_nothing(committed_inference_rows, fake_storage):
    headers = _register_and_login("commit-pastend@example.com")
    rows = committed_inference_rows
    run_id = _make_run(rows)  # the video has 30 frames
    _put(headers, run_id, frame_index=5)
    _put(headers, run_id, frame_index=100)
    objects_before = dict(fake_storage.objects)

    response = _commit(headers, run_id)

    assert response.status_code == 422
    assert "100" in response.json()["detail"]
    session = db_module.SessionLocal()
    try:
        assert session.query(Sequence).filter_by(video_id=rows.video_id).count() == 0
        assert all(f.committed_at is None for f in session.query(QcFlag).filter_by(run_id=run_id))
    finally:
        session.close()
    assert fake_storage.objects == objects_before


def test_a_storage_failure_midway_rolls_everything_back(committed_inference_rows):
    headers = _register_and_login("commit-storagefail@example.com")
    rows = committed_inference_rows
    storage = FakeStorage({"videos/inference-playable.mp4": make_video()}, fail_on_upload=2)
    app.dependency_overrides[get_storage_service] = lambda: storage
    failing_client = TestClient(app, raise_server_exceptions=False)
    try:
        run_id = _make_run(rows)
        _flag_three(headers, run_id)
        objects_before = dict(storage.objects)

        response = failing_client.post(
            f"/inference/runs/{run_id}/commit", headers=headers, json={}
        )

        assert response.status_code == 500
        # the first upload succeeded before the second failed: it must be gone again
        assert storage.objects == objects_before
        session = db_module.SessionLocal()
        try:
            assert session.query(Sequence).filter_by(video_id=rows.video_id).count() == 0
            flags = session.query(QcFlag).filter_by(run_id=run_id).all()
            assert len(flags) == 3
            assert all(f.committed_at is None and f.frame_id is None for f in flags)
        finally:
            session.close()
    finally:
        app.dependency_overrides.pop(get_storage_service, None)


def test_a_commit_after_a_failed_one_succeeds(committed_inference_rows):
    headers = _register_and_login("commit-retry@example.com")
    rows = committed_inference_rows
    storage = FakeStorage({"videos/inference-playable.mp4": make_video()}, fail_on_upload=1)
    app.dependency_overrides[get_storage_service] = lambda: storage
    failing_client = TestClient(app, raise_server_exceptions=False)
    try:
        run_id = _make_run(rows)
        _flag_three(headers, run_id)
        assert (
            failing_client.post(f"/inference/runs/{run_id}/commit", headers=headers, json={}).status_code
            == 500
        )
        assert _commit(headers, run_id).status_code == 201  # later uploads no longer fail
    finally:
        app.dependency_overrides.pop(get_storage_service, None)


def test_the_video_reports_what_was_sent_to_training(committed_inference_rows, fake_storage):
    headers = _register_and_login("commit-sent@example.com")
    rows = committed_inference_rows
    run_id = _make_run(rows)
    before = client.get(f"/inference/videos/{rows.video_id}/sent", headers=headers).json()
    _flag_three(headers, run_id)
    _commit(headers, run_id)

    after = client.get(f"/inference/videos/{rows.video_id}/sent", headers=headers).json()

    assert before == {"sequences": 0, "frames": 0}
    assert after == {"sequences": 1, "frames": 3}
    assert client.get("/inference/videos/999999/sent", headers=headers).status_code == 404


def test_a_sequence_keeps_its_origin_when_its_run_is_deleted(committed_inference_rows, fake_storage):
    headers = _register_and_login("commit-rundelete@example.com")
    rows = committed_inference_rows
    run_id = _make_run(rows)
    _flag_three(headers, run_id)
    sequence_id = _commit(headers, run_id).json()["id"]
    _put(headers, run_id, frame_index=15)  # a pending flag too

    assert client.delete(f"/inference/runs/{run_id}", headers=headers).status_code == 204

    session = db_module.SessionLocal()
    try:
        assert session.get(Sequence, sequence_id).origin_qc_run_id == run_id
        assert session.query(QcFlag).filter_by(run_id=run_id).count() == 0
        assert session.query(Frame).filter_by(sequence_id=sequence_id).count() == 3
    finally:
        session.close()
    sent = client.get(f"/inference/videos/{rows.video_id}/sent", headers=headers).json()
    assert sent == {"sequences": 1, "frames": 3}  # the note survives the run


def test_a_second_run_of_the_same_video_can_flag_the_same_frame(committed_inference_rows, fake_storage):
    """Uniqueness is per run: another run is a different QC session."""
    headers = _register_and_login("commit-tworuns@example.com")
    rows = committed_inference_rows
    run_a, run_b = _make_run(rows), _make_run(rows)
    assert _put(headers, run_a, frame_index=5).status_code == 200
    assert _put(headers, run_b, frame_index=5).status_code == 200


def test_put_flag_falls_back_to_a_change_when_a_concurrent_insert_wins(
    committed_inference_rows, monkeypatch
):
    """The first lookup misses (as if another request had not committed yet), so the
    insert hits the unique constraint and put_flag must change the existing flag."""
    from sqlalchemy.orm import Session

    headers = _register_and_login("flag-race@example.com")
    run_id = _make_run(committed_inference_rows)
    assert _put(headers, run_id, frame_index=5, kind="fp").status_code == 200

    real_scalars = Session.scalars
    calls = {"n": 0}

    class _Empty:
        def first(self):
            return None

    def scalars(self, *args, **kwargs):
        calls["n"] += 1
        if calls["n"] == 1:
            return _Empty()
        return real_scalars(self, *args, **kwargs)

    monkeypatch.setattr(Session, "scalars", scalars)
    response = _put(headers, run_id, frame_index=5, kind="fn", note="changed")
    monkeypatch.undo()

    assert response.status_code == 200
    assert response.json()["kind"] == "fn"
    listed = client.get(f"/inference/runs/{run_id}/flags", headers=headers).json()
    assert [(f["frame_index"], f["kind"]) for f in listed] == [(5, "fn")]

