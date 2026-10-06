from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session

from app.auth.dependencies import get_current_user
from app.auth.models import User
from app.db import get_session
from app.inference import service
from app.inference.schemas import InferenceRunCreate, InferenceRunRead, PredictionsRead
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
    return service.list_runs(session)


@router.get("/runs/{run_id}", response_model=InferenceRunRead)
def get_run(run_id: int, session: Session = Depends(get_session)):
    try:
        return service.get_run(session, run_id)
    except service.InferenceRunNotFound as exc:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(exc))


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
