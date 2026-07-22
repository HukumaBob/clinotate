from fastapi import APIRouter, Depends, Form, HTTPException, UploadFile, status
from sqlalchemy.orm import Session

from app.auth.dependencies import get_current_user
from app.db import get_session
from app.media.models import Frame, Sequence, Video
from app.media.schemas import FrameRead, SequenceCreate, SequenceRead, VideoRead
from app.media.service import compute_checksum, extract_frames, probe_video
from app.storage import StorageService, get_storage_service

router = APIRouter(prefix="/media", tags=["media"], dependencies=[Depends(get_current_user)])


@router.post("/videos", response_model=VideoRead, status_code=status.HTTP_201_CREATED)
async def upload_video(
    file: UploadFile,
    title: str = Form(...),
    session: Session = Depends(get_session),
    storage: StorageService = Depends(get_storage_service),
) -> Video:
    data = await file.read()
    fps, duration = probe_video(data)
    checksum = compute_checksum(data)
    storage_key = f"videos/{checksum}.mp4"
    storage.upload(storage_key, data, content_type="video/mp4")

    video = Video(storage_key=storage_key, title=title, fps=fps, duration_seconds=duration, checksum=checksum)
    session.add(video)
    session.commit()
    session.refresh(video)
    return video


@router.get("/videos", response_model=list[VideoRead])
def list_videos(session: Session = Depends(get_session)) -> list[Video]:
    return session.query(Video).all()


@router.post("/videos/{video_id}/sequences", response_model=SequenceRead, status_code=status.HTTP_201_CREATED)
def create_sequence(
    video_id: int,
    payload: SequenceCreate,
    session: Session = Depends(get_session),
    storage: StorageService = Depends(get_storage_service),
) -> Sequence:
    video = session.get(Video, video_id)
    if video is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Video not found")

    sequence = Sequence(video_id=video_id, start_time=payload.start_time, duration=payload.duration)
    session.add(sequence)
    session.commit()
    session.refresh(sequence)

    video_bytes = storage.download(video.storage_key)
    extracted = extract_frames(video_bytes, sample_fps=1.0)
    for frame_index, png_bytes, width, height in extracted:
        storage_key = f"frames/{sequence.id}/{frame_index}.png"
        storage.upload(storage_key, png_bytes, content_type="image/png")
        session.add(
            Frame(
                sequence_id=sequence.id,
                storage_key=storage_key,
                frame_index=frame_index,
                width=width,
                height=height,
            )
        )
    session.commit()
    return sequence


@router.get("/sequences/{sequence_id}/frames", response_model=list[FrameRead])
def list_frames(sequence_id: int, session: Session = Depends(get_session)) -> list[Frame]:
    return session.query(Frame).filter(Frame.sequence_id == sequence_id).order_by(Frame.frame_index).all()
