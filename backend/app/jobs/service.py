from sqlalchemy.orm import Session

from app.auth.models import User
from app.celery_app import celery_app
from app.jobs.models import Job, JobStatus, JobType


def enqueue_sam3_predict(session: Session, frame_id: int, prompts: list[dict], created_by: User) -> Job:
    job = Job(
        job_type=JobType.SAM3_PREDICT,
        status=JobStatus.PENDING,
        payload={"frame_id": frame_id, "prompts": prompts},
        created_by_id=created_by.id,
    )
    session.add(job)
    session.commit()
    session.refresh(job)

    celery_app.send_task("sam3_predict", args=[job.id])
    return job


def enqueue_sam3_track(session: Session, sequence_id: int, prompts: list[dict], created_by: User) -> Job:
    job = Job(
        job_type=JobType.SAM3_TRACK,
        status=JobStatus.PENDING,
        payload={"sequence_id": sequence_id, "prompts": prompts},
        created_by_id=created_by.id,
    )
    session.add(job)
    session.commit()
    session.refresh(job)

    celery_app.send_task("sam3_track", args=[job.id])
    return job
