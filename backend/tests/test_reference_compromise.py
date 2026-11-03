import uuid
from datetime import datetime, timezone

import app.db as db_module
import pytest
from fastapi.testclient import TestClient

from app.auth.models import User, UserRole
from app.datasets.models import Dataset, DatasetItem, SplitName, TaskType
from app.jobs.models import Job, JobStatus, JobType
from app.main import app
from app.media.models import Frame, Sequence
from app.reference import service
from app.reference.models import ReferenceInterval, VideoReference
from app.training.models import TrainingRun
from app.training.service import create_training_run

from tests.test_reference_read import _headers, world  # noqa: F401

client = TestClient(app)
EMAIL = "ref-compromise@example.com"


_BASE = {TaskType.CLASSIFICATION: "yolo11n-cls.pt", TaskType.DETECTION: "yolo11n.pt"}


class Env:
    pass


@pytest.fixture
def env(world, monkeypatch):  # noqa: F811
    monkeypatch.setattr("app.training.service.celery_app.send_task", lambda *a, **kw: None)
    session = world.session
    e = Env()
    e.world = world
    e.session = session
    e.headers = _headers(EMAIL)
    e.user = session.query(User).filter(User.email == EMAIL).one()
    e.procedure_id, e.labels = world.make_procedure("ref-comp", {"Anatomy": 2})
    e.datasets: list[int] = []
    e.sequences: list[int] = []

    def make_video(with_intervals: bool, frames: int = 2):
        video_id = world.make_video(e.procedure_id)
        if with_intervals:
            session.add(VideoReference(video_id=video_id))
            session.add(
                ReferenceInterval(
                    video_id=video_id, category_id=e.labels["Anatomy"][0],
                    label_id=e.labels["Anatomy"][1], taxonomy_version=1,
                    start_ms=0, end_ms=500, created_by_id=e.user.id,
                )
            )
        seq = Sequence(video_id=video_id, procedure_id=e.procedure_id, name="s")
        session.add(seq)
        session.flush()
        e.sequences.append(seq.id)
        frame_ids = []
        for i in range(frames):
            frame = Frame(sequence_id=seq.id, storage_key=f"ref/{uuid.uuid4()}", frame_index=i,
                          width=1, height=1)
            session.add(frame)
            session.flush()
            frame_ids.append(frame.id)
        session.commit()
        return video_id, seq.id, frame_ids

    def make_dataset(task_type: TaskType, frame_ids: list[int]) -> int:
        dataset = Dataset(
            name="ds-ref-compromise", task_type=task_type, taxonomy_version=1,
            split_config={"train": 80, "val": 20}, grouping_overrides={},
            excluded_label_ids=[], balance_metrics={}, created_by_id=e.user.id,
        )
        session.add(dataset)
        session.flush()
        for fid in frame_ids:
            session.add(DatasetItem(dataset_id=dataset.id, frame_id=fid, split=SplitName.TRAIN))
        session.add(
            Job(job_type=JobType.DATASET_EXPORT, status=JobStatus.SUCCEEDED,
                payload={"dataset_id": dataset.id}, result_ref=f"exports/{dataset.id}/d.zip",
                created_by_id=e.user.id)
        )
        session.commit()
        e.datasets.append(dataset.id)
        return dataset.id

    def task_of(dataset_id: int) -> TaskType:
        return session.get(Dataset, dataset_id).task_type

    def train(dataset_id: int) -> TrainingRun:
        run = create_training_run(
            session, dataset_id=dataset_id, base_model=_BASE[task_of(dataset_id)], created_by=e.user
        )
        run.status = "failed"  # free the global one-active-run guard
        session.commit()
        return run

    e.make_video, e.make_dataset, e.train = make_video, make_dataset, train
    yield e

    session.rollback()
    runs = [r.id for r in session.query(TrainingRun).filter(TrainingRun.dataset_id.in_(e.datasets))]
    session.query(TrainingRun).filter(TrainingRun.dataset_id.in_(e.datasets)).delete(
        synchronize_session=False
    )
    session.query(Job).filter(
        Job.job_type == JobType.MODEL_TRAIN,
        Job.payload["training_run_id"].as_integer().in_(runs),
    ).delete(synchronize_session=False)
    session.query(Job).filter(
        Job.payload["dataset_id"].as_integer().in_(e.datasets)
    ).delete(synchronize_session=False)
    session.query(DatasetItem).filter(DatasetItem.dataset_id.in_(e.datasets)).delete(
        synchronize_session=False
    )
    session.query(Dataset).filter(Dataset.id.in_(e.datasets)).delete(synchronize_session=False)
    session.query(Frame).filter(Frame.sequence_id.in_(e.sequences)).delete(synchronize_session=False)
    session.query(Sequence).filter(Sequence.id.in_(e.sequences)).delete(synchronize_session=False)
    session.query(ReferenceInterval).filter(ReferenceInterval.created_by_id == e.user.id).delete(
        synchronize_session=False
    )
    session.commit()
    session.query(User).filter(User.id == e.user.id).delete(synchronize_session=False)
    session.commit()


def test_classification_run_compromises_reference_video(env):
    video_id, _, frames = env.make_video(True)
    run = env.train(env.make_dataset(TaskType.CLASSIFICATION, frames))
    env.session.expire_all()
    ref = env.session.get(VideoReference, video_id)
    assert ref.compromised_at is not None
    assert ref.compromised_by_training_run_id == run.id
    body = client.get(f"/reference/videos/{video_id}", headers=env.headers).json()
    assert body["status"] == "compromised"
    assert body["compromised_by_training_run_id"] == run.id


def test_detection_run_leaves_reference_clean(env):
    video_id, _, frames = env.make_video(True)
    env.train(env.make_dataset(TaskType.DETECTION, frames))
    env.session.expire_all()
    assert env.session.get(VideoReference, video_id).compromised_at is None


def test_video_without_intervals_is_not_marked(env):
    video_id, _, frames = env.make_video(False)
    env.train(env.make_dataset(TaskType.CLASSIFICATION, frames))
    env.session.expire_all()
    assert env.session.get(VideoReference, video_id) is None


def test_second_run_keeps_first_compromise(env):
    video_id, _, frames = env.make_video(True)
    ds = env.make_dataset(TaskType.CLASSIFICATION, frames)
    first = env.train(ds)
    env.session.expire_all()
    stamp = env.session.get(VideoReference, video_id).compromised_at
    env.train(ds)
    env.session.expire_all()
    ref = env.session.get(VideoReference, video_id)
    assert ref.compromised_at == stamp
    assert ref.compromised_by_training_run_id == first.id


def test_mark_compromised_returns_newly_marked_ids(env):
    video_id, _, frames = env.make_video(True)
    ds = env.make_dataset(TaskType.CLASSIFICATION, frames)
    run = env.train(ds)
    assert service.mark_compromised(env.session, ds, run.id) == []


def test_hook_failure_does_not_fail_run_creation(env, monkeypatch):
    video_id, _, frames = env.make_video(True)
    ds = env.make_dataset(TaskType.CLASSIFICATION, frames)

    def boom(*a, **kw):
        raise RuntimeError("boom")

    monkeypatch.setattr("app.reference.service.mark_compromised", boom)
    run = create_training_run(
        env.session, dataset_id=ds, base_model="yolo11n-cls.pt", created_by=env.user
    )
    assert run.id is not None and run.job_id is not None


def test_exposure_for_dataset_lists_clean_reference_videos_only(env):
    clean, _, f1 = env.make_video(True, frames=3)
    _, _, f2 = env.make_video(False, frames=2)
    done, _, f3 = env.make_video(True, frames=1)
    env.session.get(VideoReference, done).compromised_at = datetime.now(timezone.utc)
    env.session.commit()
    ds = env.make_dataset(TaskType.CLASSIFICATION, f1 + f2 + f3)
    result = service.exposure_for_dataset(env.session, ds)
    assert [(r.video_id, r.frames) for r in result] == [(clean, 3)]
    assert result[0].title == "ref"
    got = client.get(f"/reference/datasets/{ds}/exposure", headers=env.headers)
    assert got.status_code == 200
    assert got.json() == [{"video_id": clean, "title": "ref", "frames": 3}]
    det = env.make_dataset(TaskType.DETECTION, f1)
    assert service.exposure_for_dataset(env.session, det) == []


def test_exposure_for_sequences_gated_by_task_type(env):
    video_id, seq_id, _ = env.make_video(True, frames=2)
    result = service.exposure_for_sequences(env.session, [seq_id], TaskType.CLASSIFICATION)
    assert [(r.video_id, r.frames) for r in result] == [(video_id, 2)]
    assert service.exposure_for_sequences(env.session, [seq_id], TaskType.DETECTION) == []
    assert service.exposure_for_sequences(env.session, [], TaskType.CLASSIFICATION) == []


def test_restore_clean(env):
    video_id, _, frames = env.make_video(True)
    env.train(env.make_dataset(TaskType.CLASSIFICATION, frames))
    r = client.post(f"/reference/videos/{video_id}/restore-clean", headers=env.headers)
    assert r.status_code == 204
    env.session.expire_all()
    ref = env.session.get(VideoReference, video_id)
    assert ref.compromised_at is None and ref.compromised_by_training_run_id is None


def test_restore_clean_without_reference_is_409_and_unknown_video_404(env):
    video_id, _, _ = env.make_video(False)
    assert client.post(
        f"/reference/videos/{video_id}/restore-clean", headers=env.headers
    ).status_code == 409
    assert client.post(
        "/reference/videos/99999999/restore-clean", headers=env.headers
    ).status_code == 404


def _first_interval(env, video_id):
    return client.post(
        f"/reference/videos/{video_id}/intervals",
        json={"label_id": env.labels["Anatomy"][1], "start_ms": 0, "end_ms": 500},
        headers=env.headers,
    )


def test_first_interval_on_already_trained_video_is_compromised(env):
    video_id, _, frames = env.make_video(False)
    ds = env.make_dataset(TaskType.CLASSIFICATION, frames)
    env.train(ds)
    latest = env.train(ds)
    assert _first_interval(env, video_id).status_code == 201
    body = client.get(f"/reference/videos/{video_id}", headers=env.headers).json()
    assert body["status"] == "compromised"
    assert body["compromised_at"] is not None
    assert body["compromised_by_training_run_id"] == latest.id


def test_first_interval_after_detection_run_stays_clean(env):
    video_id, _, frames = env.make_video(False)
    env.train(env.make_dataset(TaskType.DETECTION, frames))
    assert _first_interval(env, video_id).status_code == 201
    body = client.get(f"/reference/videos/{video_id}", headers=env.headers).json()
    assert body["status"] == "clean"
    assert body["compromised_by_training_run_id"] is None


def test_first_interval_on_video_in_no_dataset_stays_clean(env):
    video_id, _, _ = env.make_video(False)
    assert _first_interval(env, video_id).status_code == 201
    body = client.get(f"/reference/videos/{video_id}", headers=env.headers).json()
    assert body["status"] == "clean"
