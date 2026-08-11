from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session

from app.annotation.service import apply_default_postprocess_for_job
from app.auth.dependencies import get_current_user
from app.auth.models import User
from app.db import get_session
from app.jobs.models import Job, JobStatus
from app.jobs.schemas import (
    JobRead,
    Sam2PredictRequest,
    Sam2TrackRequest,
    Sam3PredictRequest,
    Sam3TrackRequest,
)
from app.jobs.service import (
    enqueue_sam2_predict,
    enqueue_sam2_track,
    enqueue_sam3_predict,
    enqueue_sam3_track,
)
from app.storage import StorageService, get_storage_service

router = APIRouter(prefix="/jobs", tags=["jobs"], dependencies=[Depends(get_current_user)])


@router.post("/sam3/predict", response_model=JobRead, status_code=status.HTTP_201_CREATED)
def create_sam3_predict_job(
    payload: Sam3PredictRequest,
    current_user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
) -> Job:
    prompts = [p.model_dump() for p in payload.prompts]
    return enqueue_sam3_predict(session, payload.frame_id, payload.label_id, prompts, current_user)


@router.post("/sam3/track", response_model=JobRead, status_code=status.HTTP_201_CREATED)
def create_sam3_track_job(
    payload: Sam3TrackRequest,
    current_user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
) -> Job:
    prompts = [p.model_dump() for p in payload.prompts]
    return enqueue_sam3_track(session, payload.sequence_id, payload.label_id, prompts, current_user)


@router.post("/sam2/predict", response_model=JobRead, status_code=status.HTTP_201_CREATED)
def create_sam2_predict_job(
    payload: Sam2PredictRequest,
    current_user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
) -> Job:
    prompts = [p.model_dump() for p in payload.prompts]
    return enqueue_sam2_predict(
        session, payload.frame_id, payload.label_id, prompts, current_user,
        mask_postprocess_strength=payload.mask_postprocess_strength,
    )


@router.post("/sam2/track", response_model=JobRead, status_code=status.HTTP_201_CREATED)
def create_sam2_track_job(
    payload: Sam2TrackRequest,
    current_user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
) -> Job:
    prompts = [p.model_dump() for p in payload.prompts]
    return enqueue_sam2_track(
        session,
        payload.sequence_id,
        payload.label_id,
        prompts,
        payload.anchor_frame_id,
        payload.backward,
        payload.forward,
        current_user,
        mask_postprocess_strength=payload.mask_postprocess_strength,
    )


@router.get("/{job_id}", response_model=JobRead)
def get_job(
    job_id: int,
    session: Session = Depends(get_session),
    storage: StorageService = Depends(get_storage_service),
) -> Job:
    job = session.get(Job, job_id)
    if job is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Job not found")
    if job.status == JobStatus.SUCCEEDED:
        apply_default_postprocess_for_job(session, job, storage)
    return job
