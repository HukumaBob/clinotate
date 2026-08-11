from pydantic import BaseModel, ConfigDict, Field


class SettingsRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    max_track_range_frames: int


class SettingsUpdate(BaseModel):
    max_track_range_frames: int = Field(ge=1)
