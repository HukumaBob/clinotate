from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from app.auth.dependencies import get_current_user
from app.auth.models import User
from app.db import get_session
from app.settings.schemas import SettingsRead, SettingsUpdate
from app.settings.service import get_platform_settings, update_settings

router = APIRouter(prefix="/settings", tags=["settings"], dependencies=[Depends(get_current_user)])


@router.get("", response_model=SettingsRead)
def read_settings(session: Session = Depends(get_session)) -> SettingsRead:
    return get_platform_settings(session)


@router.patch("", response_model=SettingsRead)
def patch_settings(
    payload: SettingsUpdate,
    current_user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
) -> SettingsRead:
    return update_settings(
        session, payload.max_track_range_frames, payload.mask_postprocess_strength, current_user
    )
