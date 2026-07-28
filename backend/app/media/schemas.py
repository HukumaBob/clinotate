from datetime import datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict


class VideoRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: int
    filename: str
    title: str
    procedure_id: int | None
    fps: float
    duration_seconds: float
    size_bytes: int


class CropBox(BaseModel):
    left: float = 0
    right: float = 0
    top: float = 0
    bottom: float = 0


class SequenceCreate(BaseModel):
    name: str
    start_time: int
    duration: int
    fps: float = 1.0
    crop: CropBox | None = None


class SequenceCreateStandalone(BaseModel):
    name: str
    procedure_id: int
    start_time: int = 0
    duration: int = 0


class SequenceRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: int
    name: str
    video_id: int | None
    procedure_id: int | None
    start_time: int
    duration: int


class SuggestSequenceNameResponse(BaseModel):
    name: str


class MediaLibraryItem(BaseModel):
    id: int
    kind: Literal["video", "photo"]
    filename: str
    procedure_id: int | None
    uploaded_at: datetime
    size_bytes: int
    linked_sequence_count: int


class FrameRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: int
    sequence_id: int
    storage_key: str
    frame_index: int
    width: int
    height: int
    image_url: str
