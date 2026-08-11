from datetime import datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator

from app.jobs.models import JobStatus, JobType

# Base64 has ~4/3 size overhead; this bounds the *encoded* string length to
# roughly 10 MiB of decoded PNG bytes -- generous for a rough hand-drawn
# mask (which SAM2ImagePredictor.predict() will resize down to 256x256
# regardless), while rejecting a pathologically large payload before it's
# ever decoded/rasterized in the ml-worker.
MAX_MASK_PNG_BASE64_LENGTH = 10 * 1024 * 1024


class JobRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    job_type: JobType
    status: JobStatus
    progress: int
    vram_used_bytes: int | None
    vram_total_bytes: int | None
    result_ref: str | None
    error: str | None
    created_by_id: int
    started_at: datetime | None
    finished_at: datetime | None


class PromptIn(BaseModel):
    type: Literal["point", "box", "mask"]
    coords: list[float] = []
    label: bool = True
    mask_png: str | None = None

    @model_validator(mode="after")
    def _validate_mask_png(self) -> "PromptIn":
        if self.type == "mask":
            if not self.mask_png:
                raise ValueError("mask_png is required when type is 'mask'")
            if len(self.mask_png) > MAX_MASK_PNG_BASE64_LENGTH:
                raise ValueError(
                    f"mask_png exceeds the maximum allowed length of {MAX_MASK_PNG_BASE64_LENGTH} characters"
                )
        return self


class Sam3PredictRequest(BaseModel):
    frame_id: int
    label_id: int
    prompts: list[PromptIn]


class Sam3TrackRequest(BaseModel):
    sequence_id: int
    label_id: int
    prompts: list[PromptIn]


class Sam2PredictRequest(BaseModel):
    frame_id: int
    label_id: int
    prompts: list[PromptIn]
    mask_postprocess_strength: float | None = Field(default=None, ge=0.0, le=1.0)


class Sam2TrackRequest(BaseModel):
    sequence_id: int
    label_id: int
    prompts: list[PromptIn]
    anchor_frame_id: int
    backward: int = Field(ge=0)
    forward: int = Field(ge=0)
    mask_postprocess_strength: float | None = Field(default=None, ge=0.0, le=1.0)
