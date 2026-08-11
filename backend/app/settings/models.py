from sqlalchemy import Float, Integer
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
    # Default strength applied by jobs/router.py's get_job the first time a
    # SAM2 predict/track job succeeds, when the job's own request didn't
    # specify one. See docs/superpowers/specs/2026-08-11-mask-postprocessing-design.md.
    mask_postprocess_strength: Mapped[float] = mapped_column(Float, default=0.3)

    def __init__(self, **kwargs):
        if "max_track_range_frames" not in kwargs:
            kwargs["max_track_range_frames"] = 10
        if "mask_postprocess_strength" not in kwargs:
            kwargs["mask_postprocess_strength"] = 0.3
        super().__init__(**kwargs)
