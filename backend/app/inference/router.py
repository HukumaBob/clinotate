import math

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy.orm import Session

from app.auth.dependencies import get_current_user
from app.auth.models import User
from app.db import get_session
from app.inference import service
from app.inference.schemas import (
    InferenceRunCreate,
    InferenceRunRead,
    PredictionsRead,
    QcCompareRead,
    QcFlagPut,
    QcCommitRequest,
    QcFlagRead,
    VideoSentRead,
)
from app.media.schemas import SequenceRead
from app.storage import StorageService, get_storage_service
from app.training.service import ModelVersionNotFound

router = APIRouter(
    prefix="/inference", tags=["inference"], dependencies=[Depends(get_current_user)]
)


@router.post("/runs", response_model=InferenceRunRead, status_code=status.HTTP_202_ACCEPTED)
def create_run(
    body: InferenceRunCreate,
    current_user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    try:
        return service.create_inference_run(
            session,
            video_id=body.video_id,
            model_version_id=body.model_version_id,
            frame_stride=body.frame_stride,
            perturbation=body.perturbation.model_dump() if body.perturbation else None,
            created_by=current_user,
        )
    except (service.VideoNotFound, ModelVersionNotFound) as exc:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(exc))
    except service.VideoNotPlayable as exc:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=str(exc))
    except service.UnsupportedModelType as exc:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail=str(exc))
    except service.EnqueueFailed as exc:
        raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail=str(exc))


@router.get("/runs", response_model=list[InferenceRunRead])
def list_runs(session: Session = Depends(get_session)):
    return service.runs_read(session, service.list_runs(session))


@router.get("/compare", response_model=QcCompareRead)
def compare(
    run_a: int,
    run_b: int,
    conf_a: float = Query(0.25, ge=0, le=1),
    conf_b: float = Query(0.25, ge=0, le=1),
    session: Session = Depends(get_session),
    storage: StorageService = Depends(get_storage_service),
):
    # ge/le let NaN through (every comparison with it is false).
    if math.isnan(conf_a) or math.isnan(conf_b):
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="Confidence must be a number")
    try:
        return service.compare_runs(session, storage, run_a, run_b, conf_a, conf_b)
    except service.InferenceRunNotFound as exc:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(exc))
    except service.RunsNotComparable as exc:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=str(exc))


@router.get("/runs/{run_id}", response_model=InferenceRunRead)
def get_run(run_id: int, session: Session = Depends(get_session)):
    try:
        return service.run_read(session, service.get_run(session, run_id))
    except service.InferenceRunNotFound as exc:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(exc))


def _flag_read(flag, sequence_id: int | None) -> QcFlagRead:
    read = QcFlagRead.model_validate(flag)
    read.sequence_id = sequence_id
    return read


@router.put("/runs/{run_id}/flags", response_model=QcFlagRead)
def put_flag(
    run_id: int,
    body: QcFlagPut,
    current_user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    try:
        flag = service.put_flag(
            session,
            run_id,
            frame_index=body.frame_index,
            timestamp_ms=body.timestamp_ms,
            kind=body.kind,
            # Omitted note keeps the stored one; an explicit null/"" clears it.
            note=body.note if "note" in body.model_fields_set else service.KEEP_NOTE,
            user=current_user,
        )
    except service.InferenceRunNotFound as exc:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(exc))
    except (service.RunNotSucceeded, service.FlagAlreadyCommitted) as exc:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=str(exc))
    except service.NotAProcessedFrame as exc:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail=str(exc))
    return _flag_read(flag, None)


@router.get("/runs/{run_id}/flags", response_model=list[QcFlagRead])
def list_flags(run_id: int, session: Session = Depends(get_session)):
    try:
        return [_flag_read(flag, seq) for flag, seq in service.list_flags(session, run_id)]
    except service.InferenceRunNotFound as exc:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(exc))


@router.delete("/runs/{run_id}/flags/{flag_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_flag(run_id: int, flag_id: int, session: Session = Depends(get_session)):
    try:
        service.delete_flag(session, run_id, flag_id)
    except (service.InferenceRunNotFound, service.FlagNotFound) as exc:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(exc))
    except service.FlagAlreadyCommitted as exc:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=str(exc))


@router.get("/runs/{run_id}/predictions", response_model=PredictionsRead)
def get_predictions(
    run_id: int,
    session: Session = Depends(get_session),
    storage: StorageService = Depends(get_storage_service),
):
    try:
        return PredictionsRead(
            download_url=service.get_predictions_url(session, storage, run_id)
        )
    except service.InferenceRunNotFound as exc:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(exc))
    except service.PredictionsNotReady as exc:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=str(exc))


@router.delete("/runs/{run_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_run(
    run_id: int,
    force: bool = False,
    session: Session = Depends(get_session),
    storage: StorageService = Depends(get_storage_service),
):
    try:
        service.delete_run(session, storage, run_id, force=force)
    except service.InferenceRunNotFound as exc:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(exc))
    except service.RunStillActive as exc:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=str(exc))


@router.post("/runs/{run_id}/commit", response_model=SequenceRead, status_code=status.HTTP_201_CREATED)
def commit_flags(
    run_id: int,
    body: QcCommitRequest,
    current_user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
    storage: StorageService = Depends(get_storage_service),
):
    try:
        sequence = service.commit_flags(
            session, storage, run_id, name=body.name, user=current_user
        )
    except service.InferenceRunNotFound as exc:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(exc))
    except (service.RunNotSucceeded, service.NoPendingFlags) as exc:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=str(exc))
    except (service.FramesPastEnd, service.VideoUnreadable) as exc:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail=str(exc))
    return SequenceRead(
        id=sequence.id,
        name=sequence.name,
        video_id=sequence.video_id,
        procedure_id=sequence.procedure_id,
        start_time=sequence.start_time,
        duration=sequence.duration,
        annotation_count=0,
        crop_box=None,
        origin_qc_run_id=sequence.origin_qc_run_id,
    )


@router.get("/videos/{video_id}/sent", response_model=VideoSentRead)
def video_sent(video_id: int, session: Session = Depends(get_session)):
    try:
        sequences, frames = service.video_sent(session, video_id)
    except service.VideoNotFound as exc:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(exc))
    return VideoSentRead(sequences=sequences, frames=frames)
