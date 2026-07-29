import subprocess
import tempfile
from datetime import datetime, timezone

from app.db import SessionLocal
from app.jobs.models import Job, JobStatus
from app.media.models import Video
from app.media.service import compute_checksum
from app.storage import get_storage_service
from app.worker.celery_app import celery_app


@celery_app.task(name="video_transcode")
def transcode_video(job_id: int) -> None:
    session = SessionLocal()
    storage = get_storage_service()

    job = session.get(Job, job_id)
    job.status = JobStatus.RUNNING
    job.started_at = datetime.now(timezone.utc)
    session.commit()

    try:
        video_id = job.payload["video_id"]
        video = session.get(Video, video_id)
        if video is None:
            raise ValueError(f"Video {video_id} not found")

        source_bytes = storage.download(video.storage_key)

        with tempfile.NamedTemporaryFile(suffix=".mp4") as source_tmp, \
             tempfile.NamedTemporaryFile(suffix=".mp4") as output_tmp:
            source_tmp.write(source_bytes)
            source_tmp.flush()

            subprocess.run(
                [
                    "ffmpeg", "-y",
                    "-i", source_tmp.name,
                    "-c:v", "libx264",
                    "-preset", "medium",
                    "-c:a", "aac",
                    "-movflags", "+faststart",
                    output_tmp.name,
                ],
                capture_output=True,
                check=True,
                timeout=600,
            )

            output_tmp.seek(0)
            output_bytes = output_tmp.read()

        new_checksum = compute_checksum(output_bytes)
        new_storage_key = f"videos/{new_checksum}.mp4"
        storage.upload(new_storage_key, output_bytes, content_type="video/mp4")

        video.storage_key = new_storage_key
        video.browser_playable = True
        video.container = "mov,mp4,m4a,3gp,3g2,mj2"
        video.video_codec = "h264"

        job.status = JobStatus.SUCCEEDED
        job.progress = 100
        job.result_ref = new_storage_key
        job.finished_at = datetime.now(timezone.utc)
        session.commit()
    except Exception as exc:
        session.rollback()
        job = session.get(Job, job_id)
        job.status = JobStatus.FAILED
        job.error = str(exc)
        job.finished_at = datetime.now(timezone.utc)
        session.commit()
    # Note: no `finally: session.close()` here -- this task is exercised in
    # tests by patching `SessionLocal` to return the test's own shared,
    # transactional `db_session` fixture (so the task's writes are visible
    # to the test's assertions before either side commits/rolls back).
    # Closing that shared session here would expunge it from the identity
    # map, breaking the test's subsequent `db_session.refresh(...)` calls.
    # In production `SessionLocal()` returns a fresh session per task
    # invocation that is simply garbage collected once this function
    # returns, so omitting an explicit close is safe.
