from datetime import datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator


class VideoRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: int
    filename: str
    title: str
    procedure_id: int | None
    fps: float
    duration_seconds: float
    size_bytes: int
    browser_playable: bool | None
    container: str | None
    video_codec: str | None
    stream_url: str


class VideoUpdate(BaseModel):
    """Rename a video's display title. The stored `filename` is the storage
    object's identity and is deliberately not editable."""

    title: str = Field(min_length=1)

    @model_validator(mode="after")
    def _title_is_not_blank(self) -> "VideoUpdate":
        self.title = self.title.strip()
        if not self.title:
            raise ValueError("title must not be blank")
        return self


class CropBox(BaseModel):
    left: float = Field(default=0, ge=0, le=100)
    right: float = Field(default=0, ge=0, le=100)
    top: float = Field(default=0, ge=0, le=100)
    bottom: float = Field(default=0, ge=0, le=100)

    @model_validator(mode="after")
    def _check_insets_leave_a_positive_area(self) -> "CropBox":
        if self.left + self.right >= 100:
            raise ValueError("left + right crop insets must be less than 100")
        if self.top + self.bottom >= 100:
            raise ValueError("top + bottom crop insets must be less than 100")
        return self


class SequenceCreate(BaseModel):
    name: str
    procedure_id: int | None = None
    start_time: int
    duration: int
    fps: float = Field(default=1.0, gt=0)
    crop: CropBox | None = None


class SequenceCreateStandalone(BaseModel):
    name: str
    procedure_id: int
    start_time: int = 0
    duration: int = 0


class SequenceUpdate(BaseModel):
    name: str | None = None
    procedure_id: int | None = None
    start_time: int | None = None
    duration: int | None = None
    fps: float | None = Field(default=None, gt=0)
    crop: CropBox | None = None

    @model_validator(mode="after")
    def _check_temporal_fields_are_all_or_nothing(self) -> "SequenceUpdate":
        temporal = (self.start_time, self.duration, self.fps)
        provided = sum(1 for value in temporal if value is not None)
        if provided not in (0, 3):
            raise ValueError(
                "start_time, duration, and fps must all be provided together (a re-cut) "
                "or all omitted (a rename) — partial temporal updates are not allowed"
            )
        return self


class SequenceRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: int
    name: str
    video_id: int | None
    procedure_id: int | None
    start_time: int
    duration: int
    annotation_count: int
    crop_box: dict | None = None


class SequenceStatsLabel(BaseModel):
    label_name: str
    count: int


class SequenceStats(BaseModel):
    frame_count: int
    frame_width: int | None
    frame_height: int | None
    labels: list[SequenceStatsLabel]


class SuggestSequenceNameResponse(BaseModel):
    name: str


class SequencePreviewAnnotation(BaseModel):
    label_id: int
    mask_url: str | None


class SequencePreviewFrame(BaseModel):
    frame_id: int
    image_url: str
    annotations: list[SequencePreviewAnnotation]


class SequenceListItem(BaseModel):
    id: int
    name: str
    video_id: int | None
    procedure_id: int | None
    frame_count: int
    labeled_frame_count: int
    region_annotation_count: int = 0
    frame_annotation_count: int = 0
    preview_frames: list[SequencePreviewFrame]


class SequenceListPage(BaseModel):
    items: list[SequenceListItem]
    total: int
    page: int
    page_size: int


class SequencesStats(BaseModel):
    total_sequences: int
    total_frames: int
    labeled_sequences: int
    unlabeled_sequences: int


class MediaLibraryItem(BaseModel):
    id: int
    kind: Literal["video", "photo"]
    filename: str
    title: str | None
    procedure_id: int | None
    uploaded_at: datetime
    last_edited_at: datetime
    size_bytes: int
    linked_sequence_count: int


class MediaLibraryPage(BaseModel):
    items: list[MediaLibraryItem]
    total: int
    page: int
    page_size: int


class FrameRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: int
    sequence_id: int
    storage_key: str
    frame_index: int
    width: int
    height: int
    image_url: str
    no_findings_reviewed: bool


class FrameBulkDelete(BaseModel):
    frame_ids: list[int]


class FrameBulkDeleteResult(BaseModel):
    deleted_ids: list[int]


class RankQualityRequest(BaseModel):
    percent: int = Field(default=20, ge=1, le=99)


class FindSimilarRequest(BaseModel):
    percent: int = Field(default=85, ge=1, le=99)
