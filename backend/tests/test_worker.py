from unittest.mock import MagicMock, patch

import app.main  # noqa: F401 -- registers every model on Base.metadata for test_engine's create_all/drop_all
from app.auth.models import User
from app.auth.service import hash_password
from app.jobs.models import Job, JobStatus, JobType
from app.media.models import Video


def _make_user(db_session, email: str) -> User:
    user = User(email=email, hashed_password=hash_password("pass1234"))
    db_session.add(user)
    db_session.commit()
    db_session.refresh(user)
    return user


def test_transcode_video_success_updates_job_and_video(db_session):
    from app.worker.tasks import transcode_video

    user = _make_user(db_session, "worker-transcode-success@example.com")

    video = Video(
        storage_key="videos/source.mp4",
        filename="source.mp4",
        title="t",
        fps=1.0,
        duration_seconds=1.0,
        size_bytes=970,
        checksum="abc",
        browser_playable=False,
        container="mov,mp4,m4a,3gp,3g2,mj2",
        video_codec="mpeg4",
    )
    db_session.add(video)
    db_session.commit()
    db_session.refresh(video)

    job = Job(
        job_type=JobType.VIDEO_TRANSCODE,
        status=JobStatus.PENDING,
        payload={"video_id": video.id},
        created_by_id=user.id,
    )
    db_session.add(job)
    db_session.commit()
    db_session.refresh(job)

    with open("tests/fixtures/tiny.mp4", "rb") as f:
        source_bytes = f.read()

    mock_storage = MagicMock()
    mock_storage.download.return_value = source_bytes

    with patch("app.worker.tasks.SessionLocal", return_value=db_session), \
         patch("app.worker.tasks.get_storage_service", return_value=mock_storage):
        transcode_video(job.id)

    db_session.refresh(job)
    db_session.refresh(video)
    assert job.status == JobStatus.SUCCEEDED
    assert job.result_ref is not None
    assert video.browser_playable is True
    assert video.storage_key == job.result_ref
    mock_storage.upload.assert_called_once()


def test_transcode_video_failure_marks_job_failed(db_session):
    from app.worker.tasks import transcode_video

    user = _make_user(db_session, "worker-transcode-failure@example.com")

    job = Job(
        job_type=JobType.VIDEO_TRANSCODE,
        status=JobStatus.PENDING,
        payload={"video_id": 999999999},  # nonexistent video
        created_by_id=user.id,
    )
    db_session.add(job)
    db_session.commit()
    db_session.refresh(job)

    with patch("app.worker.tasks.SessionLocal", return_value=db_session):
        transcode_video(job.id)

    db_session.refresh(job)
    assert job.status == JobStatus.FAILED
    assert job.error is not None


def test_transcode_video_skips_missing_job_without_raising(db_session):
    from app.worker.tasks import transcode_video

    with patch("app.worker.tasks.SessionLocal", return_value=db_session):
        transcode_video(999999999)  # nonexistent job_id -- must not raise
