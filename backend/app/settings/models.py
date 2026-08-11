from sqlalchemy import Integer
from sqlalchemy.orm import Mapped, mapped_column

from app.db import Base


class PlatformSettings(Base):
    __tablename__ = "platform_settings"

    id: Mapped[int] = mapped_column(primary_key=True)
    # See docs/superpowers/specs/2026-08-11-settings-page-design.md: this
    # is a singleton table -- the app only ever reads/writes id=1. 10 is a
    # conservative starting cap while the SAM2 GPU-OOM host-crash root
    # cause remains open (see project_sam2_vram_crash_open_issue memory);
    # the previous hardcoded 20 has reproducibly hard-rebooted the dev
    # host even with every other software mitigation applied.
    max_track_range_frames: Mapped[int] = mapped_column(Integer, default=10)

    def __init__(self, **kwargs):
        if 'max_track_range_frames' not in kwargs:
            kwargs['max_track_range_frames'] = 10
        super().__init__(**kwargs)
