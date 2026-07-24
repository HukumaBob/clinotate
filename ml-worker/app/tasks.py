import os
import sys
from datetime import datetime, timezone

from app.celery_app import celery_app
from app.db import SessionLocal
from app.models import Annotation, AnnotationStatus, AnnotationType, Frame, Job, JobStatus, Label
from app.sam2_adapter import Sam2Adapter
from app.sam3_adapter import Sam3Adapter
from app.storage import get_storage_service


def _load_label(session, label_id: int) -> Label:
    """Look up the real Label row so `taxonomy_version` can be copied off
    it at annotation-creation time, per CLAUDE.md's binding provenance
    rule — never hardcoded or re-derived. `label_id` is validated to exist
    by the backend's enqueue endpoint (404 fail-fast), so a missing Label
    here indicates the row was deleted between enqueue and task execution;
    surfacing that as a task failure (via the caller's try/except) is the
    correct behavior rather than silently guessing a taxonomy_version."""
    label = session.get(Label, label_id)
    if label is None:
        raise ValueError(f"Label {label_id} not found")
    return label


_sam3_adapter_singleton: Sam3Adapter | None = None
_sam2_adapter_singleton: Sam2Adapter | None = None


def _get_default_sam3_adapter() -> Sam3Adapter:
    global _sam3_adapter_singleton
    if _sam3_adapter_singleton is None:
        _sam3_adapter_singleton = Sam3Adapter()
    return _sam3_adapter_singleton


def _get_default_sam2_adapter() -> Sam2Adapter:
    global _sam2_adapter_singleton
    if _sam2_adapter_singleton is None:
        _sam2_adapter_singleton = Sam2Adapter()
    return _sam2_adapter_singleton


def _evict_sam3_models() -> None:
    """Releases both of the SAM-3 singleton's lazily-loaded models
    (image processor and video predictor) if resident. Called before any
    SAM 2.1 task runs its adapter's predict()/track(), since a prior
    sam3_predict/sam3_track task in this same worker process may have left
    one of them loaded -- with two adapter families now sharing this
    process's ~7.6 GiB VRAM budget, eviction must span both families, not
    just within one (each adapter already evicts its own sibling model,
    see Sam3Adapter.__init__'s docstring; this function is the missing
    cross-family half)."""
    adapter = _get_default_sam3_adapter()
    adapter._release_processor()
    adapter._release_video_predictor()


def _evict_sam2_models() -> None:
    """Mirror of _evict_sam3_models: releases the SAM 2.1 singleton's
    image predictor and video predictor if resident. Called before any
    SAM-3 task runs, for the same cross-family VRAM-sharing reason."""
    adapter = _get_default_sam2_adapter()
    adapter._release_image_predictor()
    adapter._release_video_predictor()


@celery_app.task(name="sam3_predict")
def run_sam3_predict(job_id: int, adapter: Sam3Adapter | None = None) -> None:
    """`adapter` is injectable for tests; production calls always resolve
    the real singleton lazily so the (slow) model load happens once per
    worker process, not once per plan-writing decision."""
    session = SessionLocal()
    storage = get_storage_service()
    _evict_sam2_models()
    resolved_adapter = adapter if adapter is not None else _get_default_sam3_adapter()

    job = session.get(Job, job_id)
    job.status = JobStatus.RUNNING
    job.started_at = datetime.now(timezone.utc)
    session.commit()

    try:
        frame_id = job.payload["frame_id"]
        label_id = job.payload["label_id"]
        prompts = job.payload["prompts"]
        frame = session.get(Frame, frame_id)
        label = _load_label(session, label_id)

        frame_bytes = storage.download(frame.storage_key)
        result = resolved_adapter.predict(frame_bytes, prompts)

        mask_key = f"masks/{frame_id}/{job_id}.png"
        storage.upload(mask_key, result.mask_png, content_type="image/png")

        annotation = Annotation(
            frame_id=frame_id,
            label_id=label.id,
            taxonomy_version=label.taxonomy_version,
            annotation_type=AnnotationType.MASK,
            payload={"prompts": prompts, "score": result.score},
            status=AnnotationStatus.DRAFT,
            created_by_id=job.created_by_id,
            storage_key=mask_key,
            job_id=job_id,
        )
        session.add(annotation)

        job.status = JobStatus.SUCCEEDED
        job.progress = 100
        job.result_ref = mask_key
        job.finished_at = datetime.now(timezone.utc)
        session.commit()
    except Exception as exc:
        session.rollback()
        job = session.get(Job, job_id)
        job.status = JobStatus.FAILED
        job.error = str(exc)
        job.finished_at = datetime.now(timezone.utc)
        session.commit()
    finally:
        session.close()


@celery_app.task(name="sam3_track")
def run_sam3_track(job_id: int, adapter: Sam3Adapter | None = None) -> None:
    session = SessionLocal()
    storage = get_storage_service()
    _evict_sam2_models()
    resolved_adapter = adapter if adapter is not None else _get_default_sam3_adapter()

    job = session.get(Job, job_id)
    job.status = JobStatus.RUNNING
    job.started_at = datetime.now(timezone.utc)
    session.commit()

    try:
        sequence_id = job.payload["sequence_id"]
        label_id = job.payload["label_id"]
        prompts = job.payload["prompts"]
        frames = session.query(Frame).filter(Frame.sequence_id == sequence_id).order_by(Frame.frame_index).all()
        label = _load_label(session, label_id)

        frame_bytes_list = [storage.download(f.storage_key) for f in frames]
        results = resolved_adapter.track(frame_bytes_list, prompts)

        for index, (frame, result) in enumerate(zip(frames, results)):
            mask_key = f"masks/{frame.id}/{job_id}.png"
            storage.upload(mask_key, result.mask_png, content_type="image/png")
            annotation = Annotation(
                frame_id=frame.id,
                label_id=label.id,
                taxonomy_version=label.taxonomy_version,
                annotation_type=AnnotationType.MASK,
                payload={"prompts": prompts, "score": result.score},
                status=AnnotationStatus.DRAFT,
                created_by_id=job.created_by_id,
                storage_key=mask_key,
                job_id=job_id,
            )
            session.add(annotation)

            job.progress = int(((index + 1) / len(frames)) * 100)
            session.commit()

        job.status = JobStatus.SUCCEEDED
        job.finished_at = datetime.now(timezone.utc)
        session.commit()
    except Exception as exc:
        session.rollback()
        job = session.get(Job, job_id)
        job.status = JobStatus.FAILED
        job.error = str(exc)
        job.finished_at = datetime.now(timezone.utc)
        session.commit()
        session.close()
        _restart_worker_process_after_track_failure()
        return
    finally:
        session.close()


@celery_app.task(name="sam2_predict")
def run_sam2_predict(job_id: int, adapter: Sam2Adapter | None = None) -> None:
    session = SessionLocal()
    storage = get_storage_service()
    _evict_sam3_models()
    resolved_adapter = adapter if adapter is not None else _get_default_sam2_adapter()

    job = session.get(Job, job_id)
    job.status = JobStatus.RUNNING
    job.started_at = datetime.now(timezone.utc)
    session.commit()

    try:
        frame_id = job.payload["frame_id"]
        label_id = job.payload["label_id"]
        prompts = job.payload["prompts"]
        frame = session.get(Frame, frame_id)
        label = _load_label(session, label_id)

        frame_bytes = storage.download(frame.storage_key)
        result = resolved_adapter.predict(frame_bytes, prompts)

        mask_key = f"masks/{frame_id}/{job_id}.png"
        storage.upload(mask_key, result.mask_png, content_type="image/png")

        annotation = Annotation(
            frame_id=frame_id,
            label_id=label.id,
            taxonomy_version=label.taxonomy_version,
            annotation_type=AnnotationType.MASK,
            payload={"prompts": prompts, "score": result.score},
            status=AnnotationStatus.DRAFT,
            created_by_id=job.created_by_id,
            storage_key=mask_key,
            job_id=job_id,
        )
        session.add(annotation)

        job.status = JobStatus.SUCCEEDED
        job.progress = 100
        job.result_ref = mask_key
        job.finished_at = datetime.now(timezone.utc)
        session.commit()
    except Exception as exc:
        session.rollback()
        job = session.get(Job, job_id)
        job.status = JobStatus.FAILED
        job.error = str(exc)
        job.finished_at = datetime.now(timezone.utc)
        session.commit()
    finally:
        session.close()


@celery_app.task(name="sam2_track")
def run_sam2_track(job_id: int, adapter: Sam2Adapter | None = None) -> None:
    session = SessionLocal()
    storage = get_storage_service()
    _evict_sam3_models()
    resolved_adapter = adapter if adapter is not None else _get_default_sam2_adapter()

    job = session.get(Job, job_id)
    job.status = JobStatus.RUNNING
    job.started_at = datetime.now(timezone.utc)
    session.commit()

    try:
        sequence_id = job.payload["sequence_id"]
        label_id = job.payload["label_id"]
        prompts = job.payload["prompts"]
        anchor_frame_id = job.payload["anchor_frame_id"]
        backward = job.payload["backward"]
        forward = job.payload["forward"]
        frames = session.query(Frame).filter(Frame.sequence_id == sequence_id).order_by(Frame.frame_index).all()
        label = _load_label(session, label_id)

        anchor_index = next(i for i, f in enumerate(frames) if f.id == anchor_frame_id)
        frame_bytes_list = [storage.download(f.storage_key) for f in frames]
        results = resolved_adapter.track(frame_bytes_list, prompts, anchor_index, backward, forward)

        tracked_frames = frames[max(0, anchor_index - backward):anchor_index + forward + 1]
        for index, (frame, result) in enumerate(zip(tracked_frames, results)):
            mask_key = f"masks/{frame.id}/{job_id}.png"
            storage.upload(mask_key, result.mask_png, content_type="image/png")
            annotation = Annotation(
                frame_id=frame.id,
                label_id=label.id,
                taxonomy_version=label.taxonomy_version,
                annotation_type=AnnotationType.MASK,
                payload={"prompts": prompts, "score": result.score},
                status=AnnotationStatus.DRAFT,
                created_by_id=job.created_by_id,
                storage_key=mask_key,
                job_id=job_id,
            )
            session.add(annotation)

            job.progress = int(((index + 1) / len(tracked_frames)) * 100)
            session.commit()

        job.status = JobStatus.SUCCEEDED
        job.finished_at = datetime.now(timezone.utc)
        session.commit()
    except Exception as exc:
        session.rollback()
        job = session.get(Job, job_id)
        job.status = JobStatus.FAILED
        job.error = str(exc)
        job.finished_at = datetime.now(timezone.utc)
        session.commit()
        session.close()
        _restart_worker_process_after_track_failure()
        return
    finally:
        session.close()


def _restart_worker_process_after_track_failure() -> None:
    """Exits this worker process immediately after any `run_sam3_track`
    failure, relying on the container's `restart: unless-stopped` policy
    (see `docker-compose.yml`'s `ml-worker` service) to bring up a fresh
    process for the next task.

    Root cause this works around: a failed `track()` call (most commonly
    this GPU's confirmed VRAM ceiling -- see
    .superpowers/sdd/task-7-fix2-report.md, a known hardware limit, not a
    bug) leaves this worker process's CUDA allocator state corrupted in a
    way that `gc.collect()` + `torch.cuda.empty_cache()` (already applied
    throughout `sam3_adapter.py`, see `_clear_cuda_cache_on_error`) does
    NOT recover from -- confirmed empirically (see
    .superpowers/sdd/predict-flakiness-report.md and the live verification
    that followed it): every subsequent `predict()` call in the SAME
    process then fails with the identical `CUDA out of memory` error,
    indefinitely, even though a fresh process handling only predict() calls
    is completely reliable. Rather than chase the exact PyTorch/CUDA
    allocator internals responsible (a deep rabbit hole with no guaranteed
    fix, given `sam3`'s video predictor holds complex internal state whose
    exact reference graph isn't fully known to this adapter), this
    deliberately sacrifices the one Celery worker process handling this
    task in exchange for a guaranteed-clean process for every task after
    it. `track()` failing on this hardware is already an accepted, logged
    limitation (ROADMAP.md) -- what's NOT acceptable is that failure
    poisoning unrelated, otherwise-working predict() calls for the rest of
    the worker's lifetime.

    `--pool=solo` means this worker process handles one task at a time, so
    killing it here cannot orphan a task queued behind this one -- Celery's
    broker (Redis) redelivers the message to whichever worker process picks
    up the queue next, which is this same container once it restarts.
    """
    sys.stderr.flush()
    sys.stdout.flush()
    os._exit(1)
