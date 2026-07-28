import io

from fastapi import APIRouter, Depends, Form, HTTPException, UploadFile, status
from PIL import Image, UnidentifiedImageError
from sqlalchemy.orm import Session

from app.auth.dependencies import get_current_user
from app.db import get_session
from app.media.models import Frame, Sequence, Video
from app.media.schemas import (
    FrameRead,
    SequenceCreate,
    SequenceCreateStandalone,
    SequenceRead,
    VideoRead,
)
from app.media.service import compute_checksum, extract_frames, probe_video
from app.storage import StorageService, get_storage_service
from app.taxonomy.models import Procedure

router = APIRouter(prefix="/media", tags=["media"], dependencies=[Depends(get_current_user)])


@router.post("/videos", response_model=VideoRead, status_code=status.HTTP_201_CREATED)
async def upload_video(
    file: UploadFile,
    title: str = Form(...),
    procedure_id: int | None = Form(None),
    session: Session = Depends(get_session),
    storage: StorageService = Depends(get_storage_service),
) -> Video:
    data = await file.read()
    fps, duration = probe_video(data)
    checksum = compute_checksum(data)
    storage_key = f"videos/{checksum}.mp4"
    storage.upload(storage_key, data, content_type="video/mp4")

    video = Video(
        storage_key=storage_key,
        filename=file.filename or "",
        title=title,
        procedure_id=procedure_id,
        fps=fps,
        duration_seconds=duration,
        size_bytes=len(data),
        checksum=checksum,
    )
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


@router.post("/sequences", response_model=SequenceRead, status_code=status.HTTP_201_CREATED)
def create_standalone_sequence(
    payload: SequenceCreateStandalone,
    session: Session = Depends(get_session),
) -> Sequence:
    procedure = session.get(Procedure, payload.procedure_id)
    if procedure is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Procedure not found")

    sequence = Sequence(
        video_id=None,
        procedure_id=payload.procedure_id,
        start_time=payload.start_time,
        duration=payload.duration,
    )
    session.add(sequence)
    session.commit()
    session.refresh(sequence)
    return sequence


@router.post(
    "/sequences/{sequence_id}/frames/upload",
    response_model=FrameRead,
    status_code=status.HTTP_201_CREATED,
)
async def upload_standalone_frame(
    sequence_id: int,
    file: UploadFile,
    session: Session = Depends(get_session),
    storage: StorageService = Depends(get_storage_service),
) -> FrameRead:
    sequence = session.get(Sequence, sequence_id)
    if sequence is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Sequence not found")

    data = await file.read()
    try:
        with Image.open(io.BytesIO(data)) as img:
            width, height = img.size
    except UnidentifiedImageError:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="Uploaded file is not a valid image",
        )

    existing_count = session.query(Frame).filter(Frame.sequence_id == sequence_id).count()
    frame_index = existing_count
    storage_key = f"frames/{sequence_id}/{frame_index}.png"
    storage.upload(storage_key, data, content_type="image/png")

    frame = Frame(
        sequence_id=sequence_id,
        storage_key=storage_key,
        frame_index=frame_index,
        width=width,
        height=height,
    )
    session.add(frame)
    session.commit()
    session.refresh(frame)
    return _frame_read(frame, storage)


def _frame_read(frame: Frame, storage: StorageService) -> FrameRead:
    return FrameRead(
        id=frame.id,
        sequence_id=frame.sequence_id,
        storage_key=frame.storage_key,
        frame_index=frame.frame_index,
        width=frame.width,
        height=frame.height,
        image_url=storage.url_for(frame.storage_key),
    )


@router.get("/sequences/{sequence_id}", response_model=SequenceRead)
def get_sequence(sequence_id: int, session: Session = Depends(get_session)) -> Sequence:
    sequence = session.get(Sequence, sequence_id)
    if sequence is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Sequence not found")
    return sequence


@router.get("/sequences/{sequence_id}/frames", response_model=list[FrameRead])
def list_frames(
    sequence_id: int,
    session: Session = Depends(get_session),
    storage: StorageService = Depends(get_storage_service),
) -> list[FrameRead]:
    frames = session.query(Frame).filter(Frame.sequence_id == sequence_id).order_by(Frame.frame_index).all()
    return [_frame_read(frame, storage) for frame in frames]


@router.get("/videos/{video_id}/sequences", response_model=list[SequenceRead])
def list_sequences_for_video(video_id: int, session: Session = Depends(get_session)) -> list[Sequence]:
    return session.query(Sequence).filter(Sequence.video_id == video_id).all()


@router.get("/procedures/{procedure_id}/sequences", response_model=list[SequenceRead])
def list_sequences_for_procedure(procedure_id: int, session: Session = Depends(get_session)) -> list[Sequence]:
    return session.query(Sequence).filter(Sequence.procedure_id == procedure_id).all()


@router.get("/frames/{frame_id}", response_model=FrameRead)
def get_frame(
    frame_id: int,
    session: Session = Depends(get_session),
    storage: StorageService = Depends(get_storage_service),
) -> FrameRead:
    frame = session.get(Frame, frame_id)
    if frame is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Frame not found")
    return _frame_read(frame, storage)
