from fastapi import HTTPException, status
from sqlalchemy.orm import Session

from app.auth.models import User
from app.celery_app import celery_app
from app.jobs.models import Job, JobStatus, JobType
from app.taxonomy.models import Label


def _require_label(session: Session, label_id: int) -> Label:
    label = session.get(Label, label_id)
    if label is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Label not found")
    return label


def enqueue_sam3_predict(
    session: Session, frame_id: int, label_id: int, prompts: list[dict], created_by: User
) -> Job:
    _require_label(session, label_id)

    job = Job(
        job_type=JobType.SAM3_PREDICT,
        status=JobStatus.PENDING,
        payload={"frame_id": frame_id, "label_id": label_id, "prompts": prompts},
        created_by_id=created_by.id,
    )
    session.add(job)
    session.commit()
    session.refresh(job)

    celery_app.send_task("sam3_predict", args=[job.id])
    return job


def enqueue_sam3_track(
    session: Session, sequence_id: int, label_id: int, prompts: list[dict], created_by: User
) -> Job:
    _require_label(session, label_id)

    job = Job(
        job_type=JobType.SAM3_TRACK,
        status=JobStatus.PENDING,
        payload={"sequence_id": sequence_id, "label_id": label_id, "prompts": prompts},
        created_by_id=created_by.id,
    )
    session.add(job)
    session.commit()
    session.refresh(job)

    celery_app.send_task("sam3_track", args=[job.id])
    return job
