import io
from datetime import date

from fastapi import APIRouter, Depends, Form, HTTPException, UploadFile, status
from PIL import Image, UnidentifiedImageError
from sqlalchemy import func
from sqlalchemy.orm import Session

from app.annotation.models import Annotation
from app.auth.dependencies import get_current_user
from app.auth.models import User
from app.db import get_session
from app.jobs.models import Job, JobStatus, JobType
from app.jobs.schemas import JobRead
from app.jobs.service import enqueue_video_transcode
from app.media.models import Frame, Sequence, Video
from app.media.schemas import (
    FrameRead,
    MediaLibraryItem,
    SequenceCreate,
    SequenceCreateStandalone,
    SequenceRead,
    SequenceStats,
    SequenceStatsLabel,
    SequenceUpdate,
    SuggestSequenceNameResponse,
    VideoRead,
)
from app.media.service import (
    compute_checksum,
    extract_frames,
    probe_codec_compatibility,
    probe_video,
    recut_sequence,
    suggest_sequence_name,
)
from app.storage import StorageService, get_storage_service
from app.taxonomy.models import Label, Procedure

router = APIRouter(prefix="/media", tags=["media"], dependencies=[Depends(get_current_user)])


@router.post("/videos", response_model=VideoRead, status_code=status.HTTP_201_CREATED)
async def upload_video(
    file: UploadFile,
    title: str = Form(...),
    procedure_id: int = Form(...),
    session: Session = Depends(get_session),
    storage: StorageService = Depends(get_storage_service),
) -> VideoRead:
    data = await file.read()
    fps, duration = probe_video(data)
    browser_playable, container, video_codec = probe_codec_compatibility(data)
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
        browser_playable=browser_playable,
        container=container,
        video_codec=video_codec,
    )
    session.add(video)
    session.commit()
    session.refresh(video)
    return _video_read(video, storage)


@router.get("/videos", response_model=list[VideoRead])
def list_videos(
    session: Session = Depends(get_session),
    storage: StorageService = Depends(get_storage_service),
) -> list[VideoRead]:
    return [_video_read(v, storage) for v in session.query(Video).all()]


@router.post(
    "/videos/{video_id}/transcode", response_model=JobRead, status_code=status.HTTP_201_CREATED
)
def transcode_video(
    video_id: int,
    current_user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
) -> Job:
    video = session.get(Video, video_id)
    if video is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Video not found")
    if video.browser_playable:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT, detail="Video is already browser-playable"
        )

    existing_pending_or_running = (
        session.query(Job)
        .filter(
            Job.job_type == JobType.VIDEO_TRANSCODE,
            Job.payload["video_id"].as_integer() == video_id,
            Job.status.in_([JobStatus.PENDING, JobStatus.RUNNING]),
        )
        .first()
    )
    if existing_pending_or_running is not None:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="A conversion is already in progress for this video",
        )

    return enqueue_video_transcode(session, video_id, current_user)


@router.get("/videos/{video_id}", response_model=VideoRead)
def get_video(
    video_id: int,
    session: Session = Depends(get_session),
    storage: StorageService = Depends(get_storage_service),
) -> VideoRead:
    video = session.get(Video, video_id)
    if video is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Video not found")
    return _video_read(video, storage)


@router.get("/library", response_model=list[MediaLibraryItem])
def get_media_library(session: Session = Depends(get_session)) -> list[MediaLibraryItem]:
    items: list[MediaLibraryItem] = []

    videos = session.query(Video).all()
    for video in videos:
        linked_count = session.query(Sequence).filter(Sequence.video_id == video.id).count()
        items.append(
            MediaLibraryItem(
                id=video.id,
                kind="video",
                filename=video.filename,
                procedure_id=video.procedure_id,
                uploaded_at=video.created_at,
                size_bytes=video.size_bytes,
                linked_sequence_count=linked_count,
            )
        )

    photo_sequences = session.query(Sequence).filter(Sequence.video_id.is_(None)).all()
    for sequence in photo_sequences:
        total_size = (
            session.query(func.sum(Frame.size_bytes)).filter(Frame.sequence_id == sequence.id).scalar()
            or 0
        )
        items.append(
            MediaLibraryItem(
                id=sequence.id,
                kind="photo",
                filename=sequence.name,
                procedure_id=sequence.procedure_id,
                uploaded_at=sequence.created_at,
                size_bytes=total_size,
                linked_sequence_count=1,
            )
        )

    items.sort(key=lambda item: item.uploaded_at, reverse=True)
    return items


@router.post("/videos/{video_id}/sequences", response_model=SequenceRead, status_code=status.HTTP_201_CREATED)
def create_sequence(
    video_id: int,
    payload: SequenceCreate,
    session: Session = Depends(get_session),
    storage: StorageService = Depends(get_storage_service),
) -> SequenceRead:
    video = session.get(Video, video_id)
    if video is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Video not found")

    sequence = Sequence(
        video_id=video_id,
        procedure_id=payload.procedure_id,
        name=payload.name,
        start_time=payload.start_time,
        duration=payload.duration,
        crop_box=payload.crop.model_dump() if payload.crop else None,
    )
    session.add(sequence)
    session.commit()
    session.refresh(sequence)

    video_bytes = storage.download(video.storage_key)
    extracted = extract_frames(
        video_bytes,
        sample_fps=payload.fps,
        crop=payload.crop,
        start_time=payload.start_time,
        duration=payload.duration,
    )
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
    return _sequence_read(sequence, session)


@router.post("/sequences", response_model=SequenceRead, status_code=status.HTTP_201_CREATED)
def create_standalone_sequence(
    payload: SequenceCreateStandalone,
    session: Session = Depends(get_session),
) -> SequenceRead:
    procedure = session.get(Procedure, payload.procedure_id)
    if procedure is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Procedure not found")

    sequence = Sequence(
        video_id=None,
        procedure_id=payload.procedure_id,
        name=payload.name,
        start_time=payload.start_time,
        duration=payload.duration,
    )
    session.add(sequence)
    session.commit()
    session.refresh(sequence)
    return _sequence_read(sequence, session)


@router.get("/sequences/suggest-name", response_model=SuggestSequenceNameResponse)
def get_suggested_sequence_name(
    procedure_id: int,
    session: Session = Depends(get_session),
) -> SuggestSequenceNameResponse:
    procedure = session.get(Procedure, procedure_id)
    if procedure is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Procedure not found")
    return SuggestSequenceNameResponse(name=suggest_sequence_name(session, procedure, date.today()))


@router.post("/sequences/photos", response_model=SequenceRead, status_code=status.HTTP_201_CREATED)
async def upload_photo_sequence(
    files: list[UploadFile],
    name: str = Form(...),
    procedure_id: int = Form(...),
    session: Session = Depends(get_session),
    storage: StorageService = Depends(get_storage_service),
) -> SequenceRead:
    procedure = session.get(Procedure, procedure_id)
    if procedure is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Procedure not found")

    decoded: list[tuple[bytes, int, int]] = []
    for upload in files:
        data = await upload.read()
        try:
            with Image.open(io.BytesIO(data)) as img:
                width, height = img.size
        except UnidentifiedImageError:
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                detail=f"File '{upload.filename}' is not a valid image",
            )
        decoded.append((data, width, height))

    sequence = Sequence(video_id=None, procedure_id=procedure_id, name=name, start_time=0, duration=0)
    session.add(sequence)
    session.commit()
    session.refresh(sequence)

    for frame_index, (data, width, height) in enumerate(decoded):
        storage_key = f"frames/{sequence.id}/{frame_index}.png"
        storage.upload(storage_key, data, content_type="image/png")
        session.add(
            Frame(
                sequence_id=sequence.id,
                storage_key=storage_key,
                frame_index=frame_index,
                width=width,
                height=height,
                size_bytes=len(data),
            )
        )
    session.commit()
    return _sequence_read(sequence, session)


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


def _video_read(video: Video, storage: StorageService) -> VideoRead:
    return VideoRead(
        id=video.id,
        filename=video.filename,
        title=video.title,
        procedure_id=video.procedure_id,
        fps=video.fps,
        duration_seconds=video.duration_seconds,
        size_bytes=video.size_bytes,
        browser_playable=video.browser_playable,
        container=video.container,
        video_codec=video.video_codec,
        stream_url=storage.url_for(video.storage_key),
    )


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


def _sequence_read(sequence: Sequence, session: Session) -> SequenceRead:
    annotation_count = (
        session.query(Annotation)
        .join(Frame, Annotation.frame_id == Frame.id)
        .filter(Frame.sequence_id == sequence.id)
        .count()
    )
    return SequenceRead(
        id=sequence.id,
        name=sequence.name,
        video_id=sequence.video_id,
        procedure_id=sequence.procedure_id,
        start_time=sequence.start_time,
        duration=sequence.duration,
        annotation_count=annotation_count,
        crop_box=sequence.crop_box,
    )


@router.get("/sequences/{sequence_id}", response_model=SequenceRead)
def get_sequence(sequence_id: int, session: Session = Depends(get_session)) -> SequenceRead:
    sequence = session.get(Sequence, sequence_id)
    if sequence is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Sequence not found")
    return _sequence_read(sequence, session)


@router.get("/sequences/{sequence_id}/stats", response_model=SequenceStats)
def get_sequence_stats(sequence_id: int, session: Session = Depends(get_session)) -> SequenceStats:
    sequence = session.get(Sequence, sequence_id)
    if sequence is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Sequence not found")

    frame_count = session.query(Frame).filter(Frame.sequence_id == sequence_id).count()

    first_frame = (
        session.query(Frame)
        .filter(Frame.sequence_id == sequence_id)
        .order_by(Frame.frame_index.asc())
        .first()
    )

    label_rows = (
        session.query(Label.name, func.count(Annotation.id))
        .join(Annotation, Annotation.label_id == Label.id)
        .join(Frame, Annotation.frame_id == Frame.id)
        .filter(Frame.sequence_id == sequence_id)
        .group_by(Label.name)
        .order_by(func.count(Annotation.id).desc())
        .all()
    )

    return SequenceStats(
        frame_count=frame_count,
        frame_width=first_frame.width if first_frame else None,
        frame_height=first_frame.height if first_frame else None,
        labels=[SequenceStatsLabel(label_name=name, count=count) for name, count in label_rows],
    )


@router.patch("/sequences/{sequence_id}", response_model=SequenceRead)
def update_sequence(
    sequence_id: int,
    payload: SequenceUpdate,
    session: Session = Depends(get_session),
    storage: StorageService = Depends(get_storage_service),
) -> SequenceRead:
    sequence = session.get(Sequence, sequence_id)
    if sequence is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Sequence not found")

    is_recut = payload.start_time is not None
    if not is_recut:
        if payload.name is not None:
            sequence.name = payload.name
        if payload.procedure_id is not None:
            sequence.procedure_id = payload.procedure_id
        session.commit()
        return _sequence_read(sequence, session)

    if sequence.video_id is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="This sequence has no source video to re-cut from",
        )
    video = session.get(Video, sequence.video_id)
    if video is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Video not found")

    if payload.duration <= 0:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="duration must be positive"
        )
    if payload.start_time + payload.duration > video.duration_seconds:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="start_time + duration exceeds the video's duration",
        )

    if payload.name is not None:
        sequence.name = payload.name
    if payload.procedure_id is not None:
        sequence.procedure_id = payload.procedure_id

    recut_sequence(
        session, storage, sequence, video,
        start_time=payload.start_time, duration=payload.duration, fps=payload.fps,
        crop=payload.crop,
    )
    return _sequence_read(sequence, session)


@router.get("/sequences/{sequence_id}/frames", response_model=list[FrameRead])
def list_frames(
    sequence_id: int,
    session: Session = Depends(get_session),
    storage: StorageService = Depends(get_storage_service),
) -> list[FrameRead]:
    frames = session.query(Frame).filter(Frame.sequence_id == sequence_id).order_by(Frame.frame_index).all()
    return [_frame_read(frame, storage) for frame in frames]


@router.get("/videos/{video_id}/sequences", response_model=list[SequenceRead])
def list_sequences_for_video(video_id: int, session: Session = Depends(get_session)) -> list[SequenceRead]:
    sequences = session.query(Sequence).filter(Sequence.video_id == video_id).all()
    return [_sequence_read(sequence, session) for sequence in sequences]


@router.get("/procedures/{procedure_id}/sequences", response_model=list[SequenceRead])
def list_sequences_for_procedure(procedure_id: int, session: Session = Depends(get_session)) -> list[SequenceRead]:
    sequences = session.query(Sequence).filter(Sequence.procedure_id == procedure_id).all()
    return [_sequence_read(sequence, session) for sequence in sequences]


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


@router.delete("/videos/{video_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_video(video_id: int, session: Session = Depends(get_session)) -> None:
    video = session.get(Video, video_id)
    if video is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Video not found")

    linked_count = session.query(Sequence).filter(Sequence.video_id == video_id).count()
    if linked_count > 0:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Delete or reassign this video's sequences before deleting it",
        )

    session.delete(video)
    session.commit()


@router.delete("/sequences/{sequence_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_sequence(sequence_id: int, session: Session = Depends(get_session)) -> None:
    sequence = session.get(Sequence, sequence_id)
    if sequence is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Sequence not found")

    has_annotations = (
        session.query(Annotation)
        .join(Frame, Annotation.frame_id == Frame.id)
        .filter(Frame.sequence_id == sequence_id)
        .first()
        is not None
    )
    if has_annotations:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="This sequence has annotated frames — remove annotations before deleting it",
        )

    session.query(Frame).filter(Frame.sequence_id == sequence_id).delete()
    session.delete(sequence)
    session.commit()
