import io
from datetime import date
from typing import Literal

from fastapi import APIRouter, Depends, Form, HTTPException, UploadFile, status
from PIL import Image, UnidentifiedImageError
from sqlalchemy import func
from sqlalchemy.orm import Session

from app.annotation.models import Annotation
from app.auth.dependencies import get_current_user
from app.auth.models import User
from app.db import get_session
from app.inference.models import InferenceRun
from app.jobs.models import Job, JobStatus, JobType
from app.jobs.schemas import JobRead
from app.jobs.service import enqueue_find_similar, enqueue_rank_quality, enqueue_video_transcode
from app.media.models import Frame, Sequence, Video
from app.taxonomy.models import AnnotationScope, EvaluationType, Label
from app.media.schemas import (
    FindSimilarRequest,
    FrameBulkDelete,
    FrameBulkDeleteResult,
    FrameRead,
    MediaLibraryItem,
    MediaLibraryPage,
    RankQualityRequest,
    SequenceCreate,
    SequenceCreateStandalone,
    SequenceListItem,
    SequenceListPage,
    SequencePreviewAnnotation,
    SequencePreviewFrame,
    SequenceRead,
    SequencesStats,
    SequenceStats,
    SequenceStatsLabel,
    SequenceUpdate,
    SuggestSequenceNameResponse,
    VideoRead,
    VideoUpdate,
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


@router.patch("/videos/{video_id}", response_model=VideoRead)
def update_video(
    video_id: int,
    payload: VideoUpdate,
    session: Session = Depends(get_session),
    storage: StorageService = Depends(get_storage_service),
) -> VideoRead:
    video = session.get(Video, video_id)
    if video is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Video not found")
    video.title = payload.title
    session.commit()
    return _video_read(video, storage)


@router.get("/library", response_model=MediaLibraryPage)
def get_media_library(
    search: str | None = None,
    type: Literal["video", "photo"] | None = None,
    procedure_id: int | None = None,
    sort: Literal["uploaded_at", "last_edited_at", "size_bytes", "linked_sequence_count"] = "uploaded_at",
    order: Literal["asc", "desc"] = "desc",
    page: int = 1,
    page_size: int = 25,
    session: Session = Depends(get_session),
) -> MediaLibraryPage:
    items: list[MediaLibraryItem] = []

    videos = session.query(Video).all()
    for video in videos:
        sequences = session.query(Sequence).filter(Sequence.video_id == video.id).all()
        linked_count = len(sequences)
        sequence_ids = [s.id for s in sequences]
        annotation_max = (
            session.query(func.max(Annotation.created_at))
            .join(Frame, Annotation.frame_id == Frame.id)
            .filter(Frame.sequence_id.in_(sequence_ids))
            .scalar()
            if sequence_ids
            else None
        )
        candidates = [video.created_at] + [s.created_at for s in sequences]
        if annotation_max is not None:
            candidates.append(annotation_max)
        last_edited_at = max(candidates)
        items.append(
            MediaLibraryItem(
                id=video.id,
                kind="video",
                filename=video.filename,
                title=video.title,
                procedure_id=video.procedure_id,
                uploaded_at=video.created_at,
                last_edited_at=last_edited_at,
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
        annotation_max = (
            session.query(func.max(Annotation.created_at))
            .join(Frame, Annotation.frame_id == Frame.id)
            .filter(Frame.sequence_id == sequence.id)
            .scalar()
        )
        last_edited_at = max(sequence.created_at, annotation_max) if annotation_max is not None else sequence.created_at
        items.append(
            MediaLibraryItem(
                id=sequence.id,
                kind="photo",
                filename=sequence.name,
                title=None,
                procedure_id=sequence.procedure_id,
                uploaded_at=sequence.created_at,
                last_edited_at=last_edited_at,
                size_bytes=total_size,
                linked_sequence_count=1,
            )
        )

    if search:
        needle = search.lower()
        items = [
            item
            for item in items
            if needle in item.filename.lower() or (item.title is not None and needle in item.title.lower())
        ]
    if type is not None:
        items = [item for item in items if item.kind == type]
    if procedure_id is not None:
        items = [item for item in items if item.procedure_id == procedure_id]

    items.sort(key=lambda item: getattr(item, sort), reverse=(order == "desc"))

    total = len(items)
    start = (page - 1) * page_size
    page_items = items[start : start + page_size]

    return MediaLibraryPage(items=page_items, total=total, page=page, page_size=page_size)


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


def _sequences_base_query(
    session: Session,
    procedure_id: int | None,
    video_id: int | None,
    search: str | None,
):
    query = session.query(Sequence)
    if procedure_id is not None:
        query = query.filter(Sequence.procedure_id == procedure_id)
    if video_id is not None:
        query = query.filter(Sequence.video_id == video_id)
    if search:
        query = query.filter(Sequence.name.ilike(f"%{search}%"))
    return query


def _labeled_frame_ids_subquery(session: Session, sequence_ids: list[int]) -> set[int]:
    if not sequence_ids:
        return set()
    rows = (
        session.query(Frame.id)
        .join(Annotation, Annotation.frame_id == Frame.id)
        .filter(Frame.sequence_id.in_(sequence_ids))
        .distinct()
        .all()
    )
    return {row[0] for row in rows}


@router.get("/sequences/stats", response_model=SequencesStats)
def get_sequences_stats(
    procedure_id: int | None = None,
    video_id: int | None = None,
    search: str | None = None,
    session: Session = Depends(get_session),
) -> SequencesStats:
    sequences = _sequences_base_query(session, procedure_id, video_id, search).all()
    sequence_ids = [s.id for s in sequences]

    total_frames = (
        session.query(func.count(Frame.id)).filter(Frame.sequence_id.in_(sequence_ids)).scalar()
        if sequence_ids
        else 0
    )
    labeled_frame_ids_by_sequence: dict[int, int] = {}
    if sequence_ids:
        rows = (
            session.query(Frame.sequence_id, func.count(func.distinct(Frame.id)))
            .join(Annotation, Annotation.frame_id == Frame.id)
            .filter(Frame.sequence_id.in_(sequence_ids))
            .group_by(Frame.sequence_id)
            .all()
        )
        labeled_frame_ids_by_sequence = dict(rows)

    labeled_sequences = sum(1 for sid in sequence_ids if labeled_frame_ids_by_sequence.get(sid, 0) > 0)

    return SequencesStats(
        total_sequences=len(sequence_ids),
        total_frames=total_frames or 0,
        labeled_sequences=labeled_sequences,
        unlabeled_sequences=len(sequence_ids) - labeled_sequences,
    )


@router.get("/sequences", response_model=SequenceListPage)
def list_sequences(
    procedure_id: int | None = None,
    video_id: int | None = None,
    labeled: Literal["all", "labeled", "unlabeled"] = "all",
    search: str | None = None,
    page: int = 1,
    page_size: int = 25,
    session: Session = Depends(get_session),
    storage: StorageService = Depends(get_storage_service),
) -> SequenceListPage:
    sequences = (
        _sequences_base_query(session, procedure_id, video_id, search).order_by(Sequence.created_at.desc()).all()
    )
    sequence_ids = [s.id for s in sequences]

    frame_counts_by_sequence: dict[int, int] = {}
    labeled_counts_by_sequence: dict[int, int] = {}
    if sequence_ids:
        frame_count_rows = (
            session.query(Frame.sequence_id, func.count(Frame.id))
            .filter(Frame.sequence_id.in_(sequence_ids))
            .group_by(Frame.sequence_id)
            .all()
        )
        frame_counts_by_sequence = dict(frame_count_rows)

        labeled_count_rows = (
            session.query(Frame.sequence_id, func.count(func.distinct(Frame.id)))
            .join(Annotation, Annotation.frame_id == Frame.id)
            .filter(Frame.sequence_id.in_(sequence_ids))
            .group_by(Frame.sequence_id)
            .all()
        )
        labeled_counts_by_sequence = dict(labeled_count_rows)

    region_counts: dict[int, int] = {}
    frame_counts: dict[int, int] = {}
    if sequence_ids:
        scope_rows = (
            session.query(
                Frame.sequence_id,
                EvaluationType.annotation_scope,
                func.count(Annotation.id),
            )
            .join(Annotation, Annotation.frame_id == Frame.id)
            .join(Label, Label.id == Annotation.label_id)
            .join(EvaluationType, EvaluationType.id == Label.evaluation_type_id)
            .filter(Frame.sequence_id.in_(sequence_ids))
            .group_by(Frame.sequence_id, EvaluationType.annotation_scope)
            .all()
        )
        for sequence_id, scope, count in scope_rows:
            target = region_counts if scope == AnnotationScope.REGION else frame_counts
            target[sequence_id] = count

    if labeled == "labeled":
        sequences = [s for s in sequences if labeled_counts_by_sequence.get(s.id, 0) > 0]
    elif labeled == "unlabeled":
        sequences = [s for s in sequences if labeled_counts_by_sequence.get(s.id, 0) == 0]

    total = len(sequences)
    start = (page - 1) * page_size
    page_sequences = sequences[start : start + page_size]

    items: list[SequenceListItem] = []
    for sequence in page_sequences:
        preview_frames_orm = (
            session.query(Frame)
            .filter(Frame.sequence_id == sequence.id)
            .order_by(Frame.frame_index.asc())
            .limit(4)
            .all()
        )
        preview_frame_ids = [f.id for f in preview_frames_orm]
        annotations_by_frame: dict[int, list[Annotation]] = {fid: [] for fid in preview_frame_ids}
        if preview_frame_ids:
            for annotation in (
                session.query(Annotation).filter(Annotation.frame_id.in_(preview_frame_ids)).all()
            ):
                annotations_by_frame[annotation.frame_id].append(annotation)

        preview_frames = [
            SequencePreviewFrame(
                frame_id=frame.id,
                image_url=storage.url_for(frame.storage_key),
                annotations=[
                    SequencePreviewAnnotation(
                        label_id=annotation.label_id,
                        mask_url=storage.url_for(annotation.storage_key) if annotation.storage_key else None,
                    )
                    for annotation in annotations_by_frame[frame.id]
                ],
            )
            for frame in preview_frames_orm
        ]

        items.append(
            SequenceListItem(
                id=sequence.id,
                name=sequence.name,
                video_id=sequence.video_id,
                procedure_id=sequence.procedure_id,
                frame_count=frame_counts_by_sequence.get(sequence.id, 0),
                labeled_frame_count=labeled_counts_by_sequence.get(sequence.id, 0),
                region_annotation_count=region_counts.get(sequence.id, 0),
                frame_annotation_count=frame_counts.get(sequence.id, 0),
                preview_frames=preview_frames,
            )
        )

    return SequenceListPage(items=items, total=total, page=page, page_size=page_size)


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
        no_findings_reviewed=frame.no_findings_reviewed,
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
        origin_qc_run_id=sequence.origin_qc_run_id,
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

    if sequence.origin_qc_run_id is not None:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="This sequence was made from QC flags; re-cutting it would replace the flagged frames",
        )
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

    has_runs = session.query(InferenceRun.id).filter(InferenceRun.video_id == video_id).first()
    if has_runs is not None:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Delete this video's QC runs before deleting it",
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


@router.delete("/sequences/{sequence_id}/frames", response_model=FrameBulkDeleteResult)
def bulk_delete_frames(
    sequence_id: int,
    payload: FrameBulkDelete,
    session: Session = Depends(get_session),
    storage: StorageService = Depends(get_storage_service),
) -> FrameBulkDeleteResult:
    frames = (
        session.query(Frame)
        .filter(Frame.id.in_(payload.frame_ids), Frame.sequence_id == sequence_id)
        .all()
    )
    deleted_ids: list[int] = []
    for frame in frames:
        annotations = session.query(Annotation).filter(Annotation.frame_id == frame.id).all()
        for annotation in annotations:
            if annotation.storage_key:
                storage.delete(annotation.storage_key)
            session.delete(annotation)
        storage.delete(frame.storage_key)
        session.delete(frame)
        deleted_ids.append(frame.id)
    session.commit()
    return FrameBulkDeleteResult(deleted_ids=deleted_ids)


@router.post(
    "/sequences/{sequence_id}/rank-quality", response_model=JobRead, status_code=status.HTTP_201_CREATED
)
def rank_sequence_quality(
    sequence_id: int,
    payload: RankQualityRequest,
    current_user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
) -> Job:
    sequence = session.get(Sequence, sequence_id)
    if sequence is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Sequence not found")

    existing_pending_or_running = (
        session.query(Job)
        .filter(
            Job.job_type == JobType.RANK_QUALITY,
            Job.payload["sequence_id"].as_integer() == sequence_id,
            Job.status.in_([JobStatus.PENDING, JobStatus.RUNNING]),
        )
        .first()
    )
    if existing_pending_or_running is not None:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="A quality ranking job is already in progress for this sequence",
        )

    return enqueue_rank_quality(session, sequence_id, payload.percent, current_user)


@router.post(
    "/sequences/{sequence_id}/find-similar", response_model=JobRead, status_code=status.HTTP_201_CREATED
)
def find_similar_sequence_frames(
    sequence_id: int,
    payload: FindSimilarRequest,
    current_user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
) -> Job:
    sequence = session.get(Sequence, sequence_id)
    if sequence is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Sequence not found")

    existing_pending_or_running = (
        session.query(Job)
        .filter(
            Job.job_type == JobType.FIND_SIMILAR,
            Job.payload["sequence_id"].as_integer() == sequence_id,
            Job.status.in_([JobStatus.PENDING, JobStatus.RUNNING]),
        )
        .first()
    )
    if existing_pending_or_running is not None:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="A similarity search job is already in progress for this sequence",
        )

    return enqueue_find_similar(session, sequence_id, payload.percent, current_user)
