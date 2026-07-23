from datetime import datetime

from pydantic import BaseModel, ConfigDict

from app.jobs.models import JobStatus, JobType


class JobRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    job_type: JobType
    status: JobStatus
    progress: int
    result_ref: str | None
    error: str | None
    created_by_id: int
    started_at: datetime | None
    finished_at: datetime | None
