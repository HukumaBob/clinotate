from fastapi import HTTPException, status
from sqlalchemy.orm import Session

from app.auth.models import User, UserRole
from app.settings.models import PlatformSettings

SETTINGS_ROW_ID = 1


def get_platform_settings(session: Session) -> PlatformSettings:
    settings_row = session.get(PlatformSettings, SETTINGS_ROW_ID)
    if settings_row is None:
        raise RuntimeError(
            "platform_settings row (id=1) is missing -- the seed migration "
            "should have created it, see "
            "docs/superpowers/plans/2026-08-11-settings-page.md Task 1"
        )
    return settings_row


def require_admin(user: User) -> None:
    if user.role != UserRole.ADMIN:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Admin role required")


def update_settings(session: Session, max_track_range_frames: int, user: User) -> PlatformSettings:
    require_admin(user)
    settings_row = get_platform_settings(session)
    settings_row.max_track_range_frames = max_track_range_frames
    session.commit()
    session.refresh(settings_row)
    return settings_row
