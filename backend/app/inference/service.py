"""Create, inspect and delete inference runs.

A run is a Job like every other long operation, executed by ml-worker. The
predictions live in object storage as one JSON document; this module only
ever hands out a presigned link to it.
"""

import json
import logging
import math
from datetime import date, datetime, timezone

from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.auth.models import User
from app.celery_app import celery_app
from app.datasets.models import TaskType
from app.inference.compare import disagreements
from app.inference.models import InferenceRun, InferenceRunStatus, QcFlag, QcFlagKind
from app.inference.schemas import InferenceRunRead
from app.jobs.models import Job, JobStatus, JobType
from app.media.models import Frame, Sequence, Video
from app.media.service import FramesOutOfRange, extract_frames_at
from app.storage import StorageService
from app.training import service as training_service

logger = logging.getLogger(__name__)

SUPPORTED_TASK_TYPES = (TaskType.DETECTION, TaskType.SEGMENTATION)
ACTIVE_STATUSES = (InferenceRunStatus.PENDING, InferenceRunStatus.RUNNING)


class VideoNotFound(Exception):
    """No such video."""


class VideoNotPlayable(Exception):
    """The video cannot be played in a browser, so its result could not be viewed."""


class UnsupportedModelType(Exception):
    """Only detection and segmentation models can be run."""


class InferenceRunNotFound(Exception):
    """No such run."""


class RunStillActive(Exception):
    """The run is pending or running and cannot be deleted yet."""


class EnqueueFailed(Exception):
    """The job could not be handed to the broker; the run was marked failed."""


class PredictionsNotReady(Exception):
    """The run has not succeeded, so there is nothing to download."""


def create_inference_run(
    session: Session,
    *,
    video_id: int,
    model_version_id: int,
    frame_stride: int,
    created_by: User,
    perturbation: dict | None = None,
) -> InferenceRun:
    video = session.get(Video, video_id)
    if video is None:
        raise VideoNotFound(f"Video {video_id} not found")
    # `is False`, not falsy: None means "not probed yet", which the player
    # also treats as playable.
    if video.browser_playable is False:
        raise VideoNotPlayable(
            f"Video {video_id} is not browser-playable; convert it in Media first"
        )

    version = training_service.get_model_version(session, model_version_id)
    if version.task_type not in SUPPORTED_TASK_TYPES:
        raise UnsupportedModelType(
            f"A {version.task_type.value} model cannot be run yet; "
            "only detection and segmentation models are supported"
        )

    run = InferenceRun(
        video_id=video_id,
        model_version_id=version.id,
        model_name=version.name,
        frame_stride=frame_stride,
        perturbation=perturbation,
        created_by_id=created_by.id,
    )
    session.add(run)
    session.commit()
    session.refresh(run)

    job = Job(
        job_type=JobType.INFERENCE_RUN,
        status=JobStatus.PENDING,
        payload={
            "inference_run_id": run.id,
            "video_id": video_id,
            "model_version_id": version.id,
            "model_name": version.name,
            "weights_key": version.storage_key,
            "task_type": version.task_type.value,
            "frame_stride": frame_stride,
            "perturbation": perturbation,
        },
        created_by_id=created_by.id,
    )
    session.add(job)
    session.commit()
    session.refresh(job)

    run.job_id = job.id
    session.commit()
    session.refresh(run)

    # Default "celery" queue -- ml-worker consumes it.
    try:
        celery_app.send_task("inference_run", args=[job.id])
    except Exception as exc:  # noqa: BLE001 -- recorded on the run, then surfaced as 503
        message = f"Could not enqueue the job: {exc}"[:2000]
        now = datetime.now(timezone.utc)
        run.status = InferenceRunStatus.FAILED
        run.error = message
        run.finished_at = now
        job.status = JobStatus.FAILED
        job.error = message
        job.finished_at = now
        session.commit()
        raise EnqueueFailed(message) from exc
    return run


def get_run(session: Session, run_id: int) -> InferenceRun:
    run = session.get(InferenceRun, run_id)
    if run is None:
        raise InferenceRunNotFound(f"Inference run {run_id} not found")
    return run


def list_runs(session: Session) -> list[InferenceRun]:
    return list(session.scalars(select(InferenceRun).order_by(InferenceRun.id.desc())))


class RunsNotComparable(Exception):
    """The two runs cannot be put side by side."""


def compare_runs(
    session: Session,
    storage: StorageService,
    run_a_id: int,
    run_b_id: int,
    conf_a: float,
    conf_b: float,
) -> dict:
    if run_a_id == run_b_id:
        raise RunsNotComparable("Pick two different runs to compare")
    run_a, run_b = get_run(session, run_a_id), get_run(session, run_b_id)
    for run in (run_a, run_b):
        if run.status != InferenceRunStatus.SUCCEEDED or not run.predictions_key:
            raise RunsNotComparable(f"Run {run.id} is {run.status.value}, not finished")
    if run_a.video_id != run_b.video_id:
        raise RunsNotComparable("The runs are of different videos")
    if run_a.frame_stride != run_b.frame_stride:
        raise RunsNotComparable("The runs used different frame strides")
    doc_a = json.loads(storage.download(run_a.predictions_key))
    doc_b = json.loads(storage.download(run_b.predictions_key))
    frames = disagreements(doc_a, doc_b, conf_a, conf_b)
    total = len(set(doc_a["frames"]) & set(doc_b["frames"]))
    return {"frames": frames, "total": total, "disagreements": len(frames)}


def get_predictions_url(session: Session, storage: StorageService, run_id: int) -> str:
    run = get_run(session, run_id)
    if run.status != InferenceRunStatus.SUCCEEDED or not run.predictions_key:
        raise PredictionsNotReady(f"Inference run {run_id} is {run.status.value}")
    return storage.url_for(run.predictions_key)


def delete_run(
    session: Session, storage: StorageService, run_id: int, *, force: bool = False
) -> None:
    """Delete a run, the object that holds its predictions, and its job row.

    The object goes before the row, matching delete_model_version: a
    storage failure then leaves a recoverable run rather than orphaned
    bytes. An active run is refused unless `force` is set; forcing marks
    its job failed first so the worker, if it is still alive, ends in its
    tolerant failure path instead of finishing a vanished run.
    """
    run = get_run(session, run_id)
    if run.status in ACTIVE_STATUSES and not force:
        raise RunStillActive(f"Inference run {run_id} is still {run.status.value}")
    job = session.get(Job, run.job_id) if run.job_id is not None else None
    if run.status in ACTIVE_STATUSES and job is not None:
        if job.status in (JobStatus.PENDING, JobStatus.RUNNING):
            job.status = JobStatus.FAILED
            job.error = "Force-deleted by the user"
            job.finished_at = datetime.now(timezone.utc)
            session.commit()
    if run.predictions_key:
        try:
            storage.delete(run.predictions_key)
        except Exception:  # noqa: BLE001 -- a missing object must not block the delete
            logger.warning("delete_run: could not remove %s", run.predictions_key)
    session.delete(run)
    session.flush()
    if job is not None:
        session.delete(job)
    session.commit()


class RunNotSucceeded(Exception):
    """Flags and commits need a finished run."""


class NotAProcessedFrame(Exception):
    """The frame number is not one the model processed (not a multiple of the stride)."""


class FlagNotFound(Exception):
    """No such flag on this run."""


class FlagAlreadyCommitted(Exception):
    """The flag was already sent to training and can no longer change."""


def _require_flaggable_run(session: Session, run_id: int) -> InferenceRun:
    run = get_run(session, run_id)
    if run.status != InferenceRunStatus.SUCCEEDED:
        raise RunNotSucceeded(f"Inference run {run_id} is {run.status.value}")
    return run


class _KeepNote:
    """Sentinel: leave the stored note as it is."""


KEEP_NOTE = _KeepNote()


def put_flag(
    session: Session,
    run_id: int,
    *,
    frame_index: int,
    timestamp_ms: int,
    kind: QcFlagKind,
    note: str | None | _KeepNote = KEEP_NOTE,
    user: User,
) -> QcFlag:
    """Create the flag for this frame, or change a pending one.

    A partial update: an omitted note keeps the stored one; an explicit
    None or empty string clears it.

    The frame must be one the model processed: a "missed object" on a frame
    it never saw would be a false statistic. The check uses the stride, so
    the (large) predictions document is not downloaded per flag.
    """
    run = _require_flaggable_run(session, run_id)
    if frame_index % run.frame_stride != 0:
        raise NotAProcessedFrame(
            f"Frame {frame_index} was not processed by this run (stride {run.frame_stride})"
        )

    def _existing() -> QcFlag | None:
        return session.scalars(
            select(QcFlag)
            .where(QcFlag.run_id == run_id, QcFlag.frame_index == frame_index)
            .with_for_update()
        ).first()

    flag = _existing()
    if flag is not None and flag.committed_at is not None:
        raise FlagAlreadyCommitted(f"Frame {frame_index} was already sent to training")
    if flag is None:
        flag = QcFlag(
            run_id=run_id,
            frame_index=frame_index,
            timestamp_ms=timestamp_ms,
            kind=kind,
            note=None if isinstance(note, _KeepNote) else note,
            created_by_id=user.id,
        )
        session.add(flag)
        try:
            session.commit()
        except IntegrityError:
            # A concurrent request created it first: fall through to a change.
            session.rollback()
            flag = _existing()
            if flag is None:
                raise
        else:
            session.refresh(flag)
            return flag
    if flag.committed_at is not None:
        raise FlagAlreadyCommitted(f"Frame {frame_index} was already sent to training")
    flag.kind = kind
    if not isinstance(note, _KeepNote):
        flag.note = note
    flag.timestamp_ms = timestamp_ms
    session.commit()
    session.refresh(flag)
    return flag


def list_flags(session: Session, run_id: int) -> list[tuple[QcFlag, int | None]]:
    """The run's flags by frame, each with the sequence of its committed frame."""
    get_run(session, run_id)
    rows = session.execute(
        select(QcFlag, Frame.sequence_id)
        .outerjoin(Frame, QcFlag.frame_id == Frame.id)
        .where(QcFlag.run_id == run_id)
        .order_by(QcFlag.frame_index)
    ).all()
    return [(flag, sequence_id) for flag, sequence_id in rows]


def delete_flag(session: Session, run_id: int, flag_id: int) -> None:
    get_run(session, run_id)
    # Locked like put_flag and commit_flags, so a DELETE cannot race a commit.
    flag = session.scalars(select(QcFlag).where(QcFlag.id == flag_id).with_for_update()).first()
    if flag is None or flag.run_id != run_id:
        raise FlagNotFound(f"Flag {flag_id} not found on run {run_id}")
    if flag.committed_at is not None:
        raise FlagAlreadyCommitted("A flag already sent to training cannot be removed")
    session.delete(flag)
    session.commit()


def _flag_counts(session: Session, run_ids: list[int]) -> dict[int, tuple[int, int]]:
    if not run_ids:
        return {}
    rows = session.execute(
        select(
            QcFlag.run_id,
            func.count().filter(QcFlag.committed_at.is_(None)),
            func.count().filter(QcFlag.committed_at.is_not(None)),
        )
        .where(QcFlag.run_id.in_(run_ids))
        .group_by(QcFlag.run_id)
    ).all()
    return {run_id: (pending, committed) for run_id, pending, committed in rows}


def runs_read(session: Session, runs: list[InferenceRun]) -> list[InferenceRunRead]:
    counts = _flag_counts(session, [run.id for run in runs])
    result = []
    for run in runs:
        pending, committed = counts.get(run.id, (0, 0))
        read = InferenceRunRead.model_validate(run)
        read.flags_pending = pending
        read.flags_committed = committed
        result.append(read)
    return result


def run_read(session: Session, run: InferenceRun) -> InferenceRunRead:
    return runs_read(session, [run])[0]


class NoPendingFlags(Exception):
    """Nothing is waiting to be sent."""


class FramesPastEnd(Exception):
    def __init__(self, indices: list[int]) -> None:
        self.indices = indices
        super().__init__(f"Frames past the end of the video: {indices}")


class VideoUnreadable(Exception):
    """The stored video could not be opened or decoded."""


def _default_sequence_name(video: Video, run: InferenceRun) -> str:
    return f"QC · {video.title} · run #{run.id} · {date.today().isoformat()}"[:255]


def commit_flags(
    session: Session,
    storage: StorageService,
    run_id: int,
    *,
    name: str | None,
    user: User,
) -> Sequence:
    """Send the pending flags to training as one new Sequence (all or nothing).

    The pending flags are locked (FOR UPDATE) so two commits cannot send the
    same frame twice: the second finds nothing pending. Frames are cut in
    one pass by exact number; objects are uploaded and the rows written
    only after that succeeds, and a failure after uploading deletes what
    was uploaded and rolls the database back.
    """
    run = _require_flaggable_run(session, run_id)
    flags = list(
        session.scalars(
            select(QcFlag)
            .where(QcFlag.run_id == run_id, QcFlag.committed_at.is_(None))
            .order_by(QcFlag.frame_index)
            .with_for_update()
        )
    )
    if not flags:
        session.rollback()
        raise NoPendingFlags(f"Inference run {run_id} has no pending flags")

    video = session.get(Video, run.video_id)
    try:
        extracted = extract_frames_at(
            storage.download(video.storage_key), [flag.frame_index for flag in flags]
        )
    except FramesOutOfRange as exc:
        session.rollback()
        raise FramesPastEnd(exc.indices) from exc
    except ValueError as exc:
        session.rollback()
        raise VideoUnreadable(str(exc)) from exc
    if [index for index, *_ in extracted] != [flag.frame_index for flag in flags]:
        session.rollback()
        raise RuntimeError(
            "Extracted frames do not match the flagged frame numbers; nothing was changed"
        )

    now = datetime.now(timezone.utc)
    first_ms = min(flag.timestamp_ms for flag in flags)
    last_ms = max(flag.timestamp_ms for flag in flags)
    start_time = first_ms // 1000
    uploaded: list[str] = []
    try:
        sequence = Sequence(
            video_id=video.id,
            procedure_id=video.procedure_id,
            name=name or _default_sequence_name(video, run),
            start_time=start_time,
            duration=max(1, math.ceil(last_ms / 1000) - start_time),
            origin_qc_run_id=run.id,
        )
        session.add(sequence)
        session.flush()

        created: list[tuple[QcFlag, Frame]] = []
        for position, (flag, (_, png, width, height)) in enumerate(zip(flags, extracted, strict=True)):
            key = f"frames/{sequence.id}/{position}.png"
            storage.upload(key, png, content_type="image/png")
            uploaded.append(key)
            frame = Frame(
                sequence_id=sequence.id,
                storage_key=key,
                frame_index=position,
                width=width,
                height=height,
                size_bytes=len(png),
            )
            if flag.kind == QcFlagKind.FP:
                frame.no_findings_reviewed = True
                frame.no_findings_reviewed_by_id = user.id
                frame.no_findings_reviewed_at = now
            session.add(frame)
            created.append((flag, frame))
        session.flush()
        for flag, frame in created:
            flag.committed_at = now
            flag.frame_id = frame.id
        session.commit()
    except Exception:
        try:
            session.rollback()
        finally:
            # Runs even if the rollback itself fails.
            for key in uploaded:
                try:
                    storage.delete(key)
                except Exception:  # noqa: BLE001 -- best effort
                    logger.warning("commit_flags: could not remove %s", key)
        raise
    session.refresh(sequence)
    return sequence


def video_sent(session: Session, video_id: int) -> tuple[int, int]:
    """How many sequences and frames of this video were already sent to training."""
    if session.get(Video, video_id) is None:
        raise VideoNotFound(f"Video {video_id} not found")
    sequence_ids = [
        row[0]
        for row in session.query(Sequence.id)
        .filter(Sequence.video_id == video_id, Sequence.origin_qc_run_id.is_not(None))
        .all()
    ]
    if not sequence_ids:
        return 0, 0
    frames = session.query(Frame).filter(Frame.sequence_id.in_(sequence_ids)).count()
    return len(sequence_ids), frames
