from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session

from app.auth.dependencies import get_current_user
from app.db import get_session
from app.reference import service
from app.reference.schemas import ReferenceRead

router = APIRouter(
    prefix="/reference", tags=["reference"], dependencies=[Depends(get_current_user)]
)


@router.get("/videos/{video_id}", response_model=ReferenceRead)
def read_reference(video_id: int, session: Session = Depends(get_session)):
    try:
        return service.get_reference(session, video_id)
    except service.VideoNotFound as exc:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(exc))
