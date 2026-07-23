from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session

from app.auth.dependencies import get_current_user
from app.auth.models import User
from app.db import get_session
from app.jobs.models import Job
from app.jobs.schemas import JobRead, Sam3PredictRequest, Sam3TrackRequest
from app.jobs.service import enqueue_sam3_predict, enqueue_sam3_track

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


@router.get("/{job_id}", response_model=JobRead)
def get_job(job_id: int, session: Session = Depends(get_session)) -> Job:
    job = session.get(Job, job_id)
    if job is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Job not found")
    return job
