from pydantic import BaseModel, ConfigDict


class VideoRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: int
    title: str
    fps: float
    duration_seconds: float


class SequenceCreate(BaseModel):
    start_time: int
    duration: int


class SequenceRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: int
    video_id: int
    start_time: int
    duration: int


class FrameRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: int
    sequence_id: int
    storage_key: str
    frame_index: int
    width: int
    height: int
