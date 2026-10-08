from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy.orm import Session

from app.auth.dependencies import get_current_user
from app.auth.models import User
from app.db import get_session
from app.storage import StorageService, get_storage_service
from app.training import service
from app.training.models import TrainingRunStatus
from app.training.schemas import (
    BaseModelOption,
    ModelDownloadRead,
    ModelMetricsRead,
    ModelVersionRead,
    TrainingLogRead,
    TrainingRunCreate,
    TrainingRunRead,
)

router = APIRouter(prefix="/training", tags=["training"], dependencies=[Depends(get_current_user)])


@router.post("/runs", response_model=TrainingRunRead, status_code=status.HTTP_202_ACCEPTED)
def create_run(
    body: TrainingRunCreate,
    current_user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    config = {
        "epochs": body.epochs,
        "batch": body.batch,
        "imgsz": body.imgsz,
        **body.advanced,
    }
    try:
        return service.create_training_run(
            session,
            dataset_id=body.dataset_id,
            base_model=body.base_model,
            base_model_version_id=body.base_model_version_id,
            config=config,
            created_by=current_user,
        )
    except service.DatasetNotExported as exc:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=str(exc))
    except service.RunAlreadyActive as exc:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=str(exc))
    except service.InvalidBaseModel as exc:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail=str(exc))


@router.get("/base-models", response_model=list[BaseModelOption])
def list_base_models(
    dataset_id: int = Query(),
    session: Session = Depends(get_session),
):
    try:
        return service.list_base_models(session, dataset_id)
    except service.DatasetNotFound as exc:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(exc))


@router.get("/runs", response_model=list[TrainingRunRead])
def list_runs(
    run_status: TrainingRunStatus | None = Query(default=None, alias="status"),
    session: Session = Depends(get_session),
):
    return service.list_runs(session, run_status)


@router.get("/runs/{run_id}", response_model=TrainingRunRead)
def get_run(
    run_id: int,
    session: Session = Depends(get_session),
):
    try:
        return service.get_run(session, run_id)
    except service.TrainingRunNotFound as exc:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(exc))


@router.get("/runs/{run_id}/log", response_model=TrainingLogRead)
def read_log(
    run_id: int,
    offset: int = Query(default=0, ge=0),
    session: Session = Depends(get_session),
):
    try:
        text, new_offset, run_status = service.read_log(session, run_id, offset)
    except service.TrainingRunNotFound as exc:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(exc))
    return {"text": text, "offset": new_offset, "status": run_status}


@router.post("/runs/{run_id}/stop", response_model=TrainingRunRead)
def stop_run(
    run_id: int,
    session: Session = Depends(get_session),
):
    try:
        return service.request_stop(session, run_id)
    except service.TrainingRunNotFound as exc:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(exc))
    except service.RunNotStoppable as exc:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=str(exc))


@router.get("/models", response_model=list[ModelVersionRead])
def list_models(
    session: Session = Depends(get_session),
):
    return service.list_model_versions(session)


@router.get("/models/{version_id}/download", response_model=ModelDownloadRead)
def download_model(
    version_id: int,
    session: Session = Depends(get_session),
    storage: StorageService = Depends(get_storage_service),
):
    try:
        version = service.get_model_version(session, version_id)
    except service.ModelVersionNotFound as exc:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(exc))
    return {"download_url": storage.url_for(version.storage_key)}


@router.get("/models/{version_id}/metrics", response_model=ModelMetricsRead)
def read_model_metrics(
    version_id: int,
    session: Session = Depends(get_session),
):
    try:
        return service.get_model_metrics(session, version_id)
    except service.ModelVersionNotFound as exc:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(exc))


@router.get("/models/{version_id}/artifacts/{index}", response_model=ModelDownloadRead)
def download_artifact(
    version_id: int,
    index: int,
    session: Session = Depends(get_session),
    storage: StorageService = Depends(get_storage_service),
):
    try:
        key = service.get_artifact_key(session, version_id, index)
    except (service.ModelVersionNotFound, service.ArtifactNotFound) as exc:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(exc))
    return {"download_url": storage.url_for(key)}


@router.delete("/models/{version_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_model(
    version_id: int,
    session: Session = Depends(get_session),
    storage: StorageService = Depends(get_storage_service),
):
    try:
        service.delete_model_version(session, storage, version_id)
    except service.ModelVersionNotFound as exc:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(exc))
