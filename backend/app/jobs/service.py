from fastapi import HTTPException, status
from sqlalchemy.orm import Session

from app.auth.models import User
from app.celery_app import celery_app
from app.jobs.models import Job, JobStatus, JobType
from app.settings.service import get_platform_settings
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


def enqueue_sam2_predict(
    session: Session,
    frame_id: int,
    label_id: int,
    prompts: list[dict],
    created_by: User,
    mask_postprocess_strength: float | None = None,
) -> Job:
    _require_label(session, label_id)

    job = Job(
        job_type=JobType.SAM2_PREDICT,
        status=JobStatus.PENDING,
        payload={
            "frame_id": frame_id,
            "label_id": label_id,
            "prompts": prompts,
            "mask_postprocess_strength": mask_postprocess_strength,
        },
        created_by_id=created_by.id,
    )
    session.add(job)
    session.commit()
    session.refresh(job)

    celery_app.send_task("sam2_predict", args=[job.id])
    return job


def enqueue_sam2_track(
    session: Session,
    sequence_id: int,
    label_id: int,
    prompts: list[dict],
    anchor_frame_id: int,
    backward: int,
    forward: int,
    created_by: User,
    mask_postprocess_strength: float | None = None,
) -> Job:
    _require_label(session, label_id)

    max_range = get_platform_settings(session).max_track_range_frames
    if backward + forward > max_range:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
            detail=(
                f"backward + forward must not exceed {max_range} frames "
                f"(got {backward + forward}) -- see Settings page"
            ),
        )

    job = Job(
        job_type=JobType.SAM2_TRACK,
        status=JobStatus.PENDING,
        payload={
            "sequence_id": sequence_id,
            "label_id": label_id,
            "prompts": prompts,
            "anchor_frame_id": anchor_frame_id,
            "backward": backward,
            "forward": forward,
            "mask_postprocess_strength": mask_postprocess_strength,
        },
        created_by_id=created_by.id,
    )
    session.add(job)
    session.commit()
    session.refresh(job)

    celery_app.send_task("sam2_track", args=[job.id])
    return job


def enqueue_video_transcode(session: Session, video_id: int, created_by: User) -> Job:
    job = Job(
        job_type=JobType.VIDEO_TRANSCODE,
        status=JobStatus.PENDING,
        payload={"video_id": video_id},
        created_by_id=created_by.id,
    )
    session.add(job)
    session.commit()
    session.refresh(job)

    # Routed to its own queue, not the default "celery" queue that the
    # ml-worker's Celery app also consumes from (same Redis broker) -- ml-worker
    # has no `video_transcode` task registered, so a message landing there first
    # is dropped with a NotRegistered/KeyError and never reaches the transcode
    # worker. See app/worker/celery_app.py's matching queue declaration.
    celery_app.send_task("video_transcode", args=[job.id], queue="video_transcode")
    return job


def enqueue_rank_quality(session: Session, sequence_id: int, percent: int, created_by: User) -> Job:
    job = Job(
        job_type=JobType.RANK_QUALITY,
        status=JobStatus.PENDING,
        payload={"sequence_id": sequence_id, "percent": percent},
        created_by_id=created_by.id,
    )
    session.add(job)
    session.commit()
    session.refresh(job)

    celery_app.send_task("rank_quality", args=[job.id])
    return job


def enqueue_find_similar(session: Session, sequence_id: int, percent: int, created_by: User) -> Job:
    job = Job(
        job_type=JobType.FIND_SIMILAR,
        status=JobStatus.PENDING,
        payload={"sequence_id": sequence_id, "percent": percent},
        created_by_id=created_by.id,
    )
    session.add(job)
    session.commit()
    session.refresh(job)

    celery_app.send_task("find_similar", args=[job.id])
    return job
