from fastapi import APIRouter, Depends, HTTPException, Query, Response, status
from sqlalchemy.orm import Session

from app.auth.dependencies import get_current_user
from app.db import get_session
from app.reference import service
from app.storage import StorageService, get_storage_service
from app.auth.models import User
from app.reference.schemas import (
    EvaluationRead,
    ExposureVideoRead,
    IntervalCreate,
    IntervalUpdate,
    ReferenceIntervalRead,
    ReferenceRead,
)

router = APIRouter(
    prefix="/reference", tags=["reference"], dependencies=[Depends(get_current_user)]
)


@router.get("/videos/{video_id}", response_model=ReferenceRead)
def read_reference(video_id: int, session: Session = Depends(get_session)):
    try:
        return service.get_reference(session, video_id)
    except service.VideoNotFound as exc:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(exc))


def _translate(exc: Exception) -> HTTPException:
    if isinstance(exc, (service.VideoNotFound, service.IntervalNotFound)):
        return HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(exc))
    if isinstance(exc, service.InvalidInterval):
        return HTTPException(status_code=422, detail=str(exc))
    return HTTPException(status_code=status.HTTP_409_CONFLICT, detail=str(exc))


_ERRORS = (
    service.VideoNotFound,
    service.IntervalNotFound,
    service.InvalidInterval,
    service.IntervalOverlap,
    service.NoReference,
)


@router.post(
    "/videos/{video_id}/intervals",
    response_model=ReferenceIntervalRead,
    status_code=status.HTTP_201_CREATED,
)
def create_interval(
    video_id: int,
    payload: IntervalCreate,
    session: Session = Depends(get_session),
    user: User = Depends(get_current_user),
):
    try:
        return service.create_interval(session, video_id, payload, user)
    except _ERRORS as exc:
        raise _translate(exc)


@router.patch("/videos/{video_id}/intervals/{interval_id}", response_model=ReferenceIntervalRead)
def update_interval(
    video_id: int,
    interval_id: int,
    payload: IntervalUpdate,
    session: Session = Depends(get_session),
):
    try:
        return service.update_interval(session, video_id, interval_id, payload)
    except _ERRORS as exc:
        raise _translate(exc)


@router.delete("/videos/{video_id}/intervals/{interval_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_interval(video_id: int, interval_id: int, session: Session = Depends(get_session)):
    try:
        service.delete_interval(session, video_id, interval_id)
    except _ERRORS as exc:
        raise _translate(exc)
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.get("/datasets/{dataset_id}/exposure", response_model=list[ExposureVideoRead])
def dataset_exposure(dataset_id: int, session: Session = Depends(get_session)):
    return service.exposure_for_dataset(session, dataset_id)


@router.post("/videos/{video_id}/restore-clean", status_code=status.HTTP_204_NO_CONTENT)
def restore_clean(video_id: int, session: Session = Depends(get_session)):
    try:
        service.restore_clean(session, video_id)
    except _ERRORS as exc:
        raise _translate(exc)
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.get("/runs/{run_id}/evaluation", response_model=EvaluationRead, response_model_by_alias=True)
def evaluate_run(
    run_id: int,
    boundary_ms: int = Query(2000, ge=0, le=60000),
    session: Session = Depends(get_session),
    storage: StorageService = Depends(get_storage_service),
):
    try:
        return service.evaluate_run(session, storage, run_id, boundary_ms)
    except service.RunNotFound as exc:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(exc))
    except service.RunNotEvaluable as exc:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=str(exc))
