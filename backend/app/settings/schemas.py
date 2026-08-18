from pydantic import BaseModel, ConfigDict, Field


class SettingsRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    max_track_range_frames: int
    mask_postprocess_strength: float
    min_mask_area_fraction: float


class SettingsUpdate(BaseModel):
    max_track_range_frames: int = Field(ge=1)
    mask_postprocess_strength: float = Field(ge=0.0, le=1.0)
    min_mask_area_fraction: float = Field(ge=0.0, le=1.0)
