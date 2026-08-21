import io
import os
import sys
import tempfile
import threading
import time
import zipfile
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
import torch
from PIL import Image

from app.celery_app import WORKER_VRAM_FRACTION as _WORKER_VRAM_FRACTION
from app.celery_app import celery_app
from app.db import SessionLocal
from app.models import (
    Annotation,
    AnnotationStatus,
    AnnotationType,
    Frame,
    Job,
    JobStatus,
    Label,
    ModelVersion,
    TrainingRun,
    TrainingRunStatus,
)
from app.quality_adapter import QualityAdapter
from app.sam2_adapter import Sam2Adapter
from app.sam3_adapter import Sam3Adapter
from app.similarity_adapter import SimilarityAdapter
from app.storage import get_storage_service
from app.training_adapter import TrainingRequest
from app.union_find import cluster_by_threshold


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
_quality_adapter_singleton: QualityAdapter | None = None
_similarity_adapter_singleton: SimilarityAdapter | None = None


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


def _get_default_quality_adapter() -> QualityAdapter:
    global _quality_adapter_singleton
    if _quality_adapter_singleton is None:
        _quality_adapter_singleton = QualityAdapter()
    return _quality_adapter_singleton


def _get_default_similarity_adapter() -> SimilarityAdapter:
    global _similarity_adapter_singleton
    if _similarity_adapter_singleton is None:
        _similarity_adapter_singleton = SimilarityAdapter()
    return _similarity_adapter_singleton


def _evict_similarity_models() -> None:
    """Releases the SimilarityAdapter singleton's DINOv2 model if resident,
    same cross-family VRAM-sharing reason as the other _evict_*_models
    helpers."""
    adapter = _get_default_similarity_adapter()
    adapter._model = None
    import gc

    import torch

    gc.collect()
    if torch.cuda.is_available():
        torch.cuda.empty_cache()


def _evict_quality_models() -> None:
    """Releases the QualityAdapter singleton's TOPIQ model if resident,
    for the same cross-family VRAM-sharing reason as _evict_sam3_models/
    _evict_sam2_models. QualityAdapter has no video predictor to release,
    only the single lazy _metric."""
    adapter = _get_default_quality_adapter()
    adapter._metric = None
    import gc

    import torch

    gc.collect()
    if torch.cuda.is_available():
        torch.cuda.empty_cache()


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


def _record_vram_usage(job: Job) -> None:
    """Records this process's current CUDA memory usage onto the Job row,
    as a percentage-of-total traffic-light metric the frontend renders
    live while a job is pending/running (see
    docs/superpowers/specs/2026-08-05-gpu-vram-gauge-design.md).
    torch.cuda.mem_get_info() is a cheap driver query, not a memory
    operation -- safe to call at every existing progress checkpoint
    without measurably affecting job duration."""
    free_bytes, total_bytes = torch.cuda.mem_get_info()
    job.vram_used_bytes = total_bytes - free_bytes
    job.vram_total_bytes = total_bytes


class _InsufficientVramError(Exception):
    """Raised by the run_sam2_track() pre-flight VRAM check when the
    estimated requirement exceeds the safe available budget. Deliberately
    distinct from a generic RuntimeError (subclasses Exception directly,
    NOT RuntimeError) so the except block below can skip
    _restart_worker_process_after_track_failure() for this case -- no GPU
    work was attempted, so there is no corrupted CUDA allocator state to
    work around, and restarting the process here would be pure overhead.
    torch.cuda.OutOfMemoryError also subclasses RuntimeError, so if this
    class subclassed RuntimeError too, an `except RuntimeError:` clause
    added above this one in the future could silently swallow a real CUDA
    OOM into this no-restart path -- subclassing Exception directly removes
    that ambiguity entirely."""


# Rough calibration: SAM2's video predictor keeps a resized copy of every
# tracked frame (plus internal feature maps) resident in VRAM for the
# duration of propagate_in_video(). This constant is a conservative
# starting estimate, not a measured physical model -- see
# docs/superpowers/specs/2026-08-08-sam2-gpu-oom-host-crash-design.md's
# "Open items" section. Recalibrate by comparing this estimate against the
# actual vram_used_bytes _record_vram_usage() reports for a real tracking
# job of known frame_count/width/height, then update this constant.
_TRACK_VRAM_BYTES_PER_PIXEL_PER_FRAME = 40


def _estimate_track_vram_bytes(frame_count: int, width: int, height: int) -> int:
    """Rough upper-bound estimate of the VRAM a run_sam2_track() call will
    need, used only as a cheap pre-flight check to reject obviously
    oversized requests before spending time loading frames and starting a
    SAM2 video session. Not a substitute for the hard per-process VRAM
    cap set in celery_app.py, which is what actually guarantees safety if
    this estimate is wrong."""
    return frame_count * width * height * _TRACK_VRAM_BYTES_PER_PIXEL_PER_FRAME


# Fraction of currently-free VRAM the estimate must fit under, leaving
# headroom for the safety margin discussed in the design doc.
_TRACK_VRAM_SAFETY_MARGIN = 0.7


@celery_app.task(name="sam3_predict")
def run_sam3_predict(job_id: int, adapter: Sam3Adapter | None = None) -> None:
    """`adapter` is injectable for tests; production calls always resolve
    the real singleton lazily so the (slow) model load happens once per
    worker process, not once per plan-writing decision."""
    session = SessionLocal()
    storage = get_storage_service()
    _evict_sam2_models()
    _evict_quality_models()
    _evict_similarity_models()
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

        if frame.no_findings_reviewed:
            frame.no_findings_reviewed = False
            frame.no_findings_reviewed_by_id = None
            frame.no_findings_reviewed_at = None

        job.status = JobStatus.SUCCEEDED
        job.progress = 100
        job.result_ref = mask_key
        job.finished_at = datetime.now(timezone.utc)
        _record_vram_usage(job)
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
    _evict_quality_models()
    _evict_similarity_models()
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

            if frame.no_findings_reviewed:
                frame.no_findings_reviewed = False
                frame.no_findings_reviewed_by_id = None
                frame.no_findings_reviewed_at = None

            job.progress = int(((index + 1) / len(frames)) * 100)
            _record_vram_usage(job)
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
    _evict_quality_models()
    _evict_similarity_models()
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
        # raw_mask_key stores the untouched SAM2 output under its own,
        # never-overwritten key. storage_key is what backend's
        # apply_default_postprocess_for_job/reapply_mask_postprocess
        # overwrite in place with the cleaned-up mask -- if both pointed at
        # the same key, the first post-processing pass would permanently
        # destroy the raw mask, making the per-mask "reset to 0" slider
        # return an already-smoothed result instead of the true raw output.
        raw_mask_key = f"masks/{frame_id}/{job_id}_raw.png"
        storage.upload(mask_key, result.mask_png, content_type="image/png")
        storage.upload(raw_mask_key, result.mask_png, content_type="image/png")

        annotation = Annotation(
            frame_id=frame_id,
            label_id=label.id,
            taxonomy_version=label.taxonomy_version,
            annotation_type=AnnotationType.MASK,
            payload={"prompts": prompts, "score": result.score},
            status=AnnotationStatus.DRAFT,
            created_by_id=job.created_by_id,
            storage_key=mask_key,
            raw_mask_storage_key=raw_mask_key,
            job_id=job_id,
        )
        session.add(annotation)

        if frame.no_findings_reviewed:
            frame.no_findings_reviewed = False
            frame.no_findings_reviewed_by_id = None
            frame.no_findings_reviewed_at = None

        job.status = JobStatus.SUCCEEDED
        job.progress = 100
        job.result_ref = mask_key
        job.finished_at = datetime.now(timezone.utc)
        _record_vram_usage(job)
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
    _evict_quality_models()
    _evict_similarity_models()
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
        window_start = max(0, anchor_index - backward)
        window_end = anchor_index + forward + 1
        tracked_frames = frames[window_start:window_end]
        anchor_index_in_window = anchor_index - window_start

        # Only download the frames actually reaching the GPU. Sam2Adapter.track()
        # stages every frame it's given resident in VRAM via
        # SAM2VideoPredictor.init_state() -- backward/forward only bound how far
        # propagate_in_video() walks afterward, not what init_state() loads up
        # front. Downloading/passing the whole sequence here would let the real
        # VRAM footprint balloon far past what the pre-flight estimate below
        # (and Layer 2's combined-range cap) models. That cap is no longer a
        # fixed 20-frame constant -- it's a tunable, database-backed setting
        # (default 10) read live from the platform_settings table via the
        # Settings page; see docs/superpowers/specs/2026-08-11-settings-page-design.md.
        frame_bytes_list = [storage.download(f.storage_key) for f in tracked_frames]

        with Image.open(io.BytesIO(frame_bytes_list[0])) as first_frame_image:
            estimated_bytes = _estimate_track_vram_bytes(
                frame_count=len(tracked_frames),
                width=first_frame_image.width,
                height=first_frame_image.height,
            )
        free_bytes, total_bytes = torch.cuda.mem_get_info()
        # torch.cuda.mem_get_info() reports raw driver-level free VRAM across
        # the whole device -- it does NOT account for the per-process fraction
        # cap set in celery_app.py (that cap lives entirely inside PyTorch's
        # allocator, invisible to cudaMemGetInfo). Combine both so a busy
        # desktop session sharing this GPU can't make this process think it
        # has more headroom than its own fraction cap actually allows.
        fraction_budget = int(total_bytes * _WORKER_VRAM_FRACTION) - torch.cuda.memory_reserved()
        available_budget = min(free_bytes, fraction_budget)
        if estimated_bytes > available_budget * _TRACK_VRAM_SAFETY_MARGIN:
            raise _InsufficientVramError(
                f"Estimated GPU memory required ({estimated_bytes} bytes) exceeds the "
                f"safe available budget ({int(available_budget * _TRACK_VRAM_SAFETY_MARGIN)} bytes "
                f"of {available_budget} available) -- try a smaller tracking range."
            )

        results = resolved_adapter.track(
            frame_bytes_list, prompts, anchor_index_in_window, backward, forward
        )

        for index, (frame, result) in enumerate(zip(tracked_frames, results)):
            mask_key = f"masks/{frame.id}/{job_id}.png"
            # See run_sam2_predict's comment above -- storage_key and
            # raw_mask_storage_key must be distinct keys, or the first
            # post-processing pass destroys the raw SAM2 mask forever.
            raw_mask_key = f"masks/{frame.id}/{job_id}_raw.png"
            storage.upload(mask_key, result.mask_png, content_type="image/png")
            storage.upload(raw_mask_key, result.mask_png, content_type="image/png")
            annotation = Annotation(
                frame_id=frame.id,
                label_id=label.id,
                taxonomy_version=label.taxonomy_version,
                annotation_type=AnnotationType.MASK,
                payload={"prompts": prompts, "score": result.score},
                status=AnnotationStatus.DRAFT,
                created_by_id=job.created_by_id,
                storage_key=mask_key,
                raw_mask_storage_key=raw_mask_key,
                job_id=job_id,
            )
            session.add(annotation)

            if frame.no_findings_reviewed:
                frame.no_findings_reviewed = False
                frame.no_findings_reviewed_by_id = None
                frame.no_findings_reviewed_at = None

            job.progress = int(((index + 1) / len(tracked_frames)) * 100)
            _record_vram_usage(job)
            session.commit()

        job.status = JobStatus.SUCCEEDED
        job.finished_at = datetime.now(timezone.utc)
        session.commit()
    except _InsufficientVramError as exc:
        # No GPU work was attempted (the pre-flight check ran before
        # resolved_adapter.track()), so there is no corrupted CUDA
        # allocator state to work around -- skip the worker-process
        # restart used for genuine track() failures below.
        session.rollback()
        job = session.get(Job, job_id)
        job.status = JobStatus.FAILED
        job.error = str(exc)
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


@celery_app.task(name="rank_quality")
def run_rank_quality(job_id: int, adapter: QualityAdapter | None = None) -> None:
    session = SessionLocal()
    storage = get_storage_service()
    _evict_sam3_models()
    _evict_sam2_models()
    _evict_similarity_models()
    resolved_adapter = adapter if adapter is not None else _get_default_quality_adapter()

    job = session.get(Job, job_id)
    job.status = JobStatus.RUNNING
    job.started_at = datetime.now(timezone.utc)
    session.commit()

    try:
        sequence_id = job.payload["sequence_id"]
        percent = job.payload["percent"]
        frames = (
            session.query(Frame)
            .filter(Frame.sequence_id == sequence_id)
            .order_by(Frame.frame_index)
            .all()
        )

        scores: list[dict] = []
        for index, frame in enumerate(frames):
            frame_bytes = storage.download(frame.storage_key)
            score = resolved_adapter.score(frame_bytes)
            scores.append({"frame_id": frame.id, "score": score})

            job.progress = int(((index + 1) / len(frames)) * 100)
            session.commit()

        scores.sort(key=lambda entry: entry["score"])
        worst_count = round(len(frames) * percent / 100)
        worst_ids = [entry["frame_id"] for entry in scores[:worst_count]]

        job.payload = {**job.payload, "result": {"scores": scores, "worst_ids": worst_ids}}
        job.status = JobStatus.SUCCEEDED
        job.progress = 100
        job.finished_at = datetime.now(timezone.utc)
        _record_vram_usage(job)
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


@celery_app.task(name="find_similar")
def run_find_similar(job_id: int, adapter: SimilarityAdapter | None = None) -> None:
    session = SessionLocal()
    storage = get_storage_service()
    _evict_sam3_models()
    _evict_sam2_models()
    _evict_quality_models()
    resolved_adapter = adapter if adapter is not None else _get_default_similarity_adapter()

    job = session.get(Job, job_id)
    job.status = JobStatus.RUNNING
    job.started_at = datetime.now(timezone.utc)
    session.commit()

    try:
        sequence_id = job.payload["sequence_id"]
        percent = job.payload["percent"]
        frames = (
            session.query(Frame)
            .filter(Frame.sequence_id == sequence_id)
            .order_by(Frame.frame_index)
            .all()
        )

        embeddings = []
        for index, frame in enumerate(frames):
            frame_bytes = storage.download(frame.storage_key)
            embeddings.append(resolved_adapter.embed(frame_bytes))
            job.progress = int(((index + 1) / len(frames)) * 50)  # embedding is the first half
            session.commit()

        matrix = np.stack(embeddings) @ np.stack(embeddings).T
        ids = [f.id for f in frames]
        threshold = percent / 100.0
        clusters = cluster_by_threshold(matrix, ids, threshold)

        id_to_frame = {f.id: f for f in frames}
        id_to_index = {f.id: i for i, f in enumerate(frames)}

        # Evict the similarity model before loading the quality model --
        # both are GPU-resident deep models and this GPU has room for only
        # one large model family at a time (see _evict_*_models docstrings).
        _evict_similarity_models()
        quality_adapter = _get_default_quality_adapter()

        duplicate_ids: list[int] = []
        pairs: list[dict] = []
        similarity_map: dict[str, float] = {}

        for cluster_index, cluster_ids in enumerate(clusters):
            if len(cluster_ids) < 2:
                continue
            scored = []
            for frame_id in cluster_ids:
                frame_bytes = storage.download(id_to_frame[frame_id].storage_key)
                score = quality_adapter.score(frame_bytes)
                scored.append((frame_id, score))
            scored.sort(key=lambda entry: entry[1], reverse=True)  # best (highest) first
            best_id = scored[0][0]
            for frame_id, _score in scored[1:]:
                duplicate_ids.append(frame_id)
                similarity = float(matrix[id_to_index[best_id]][id_to_index[frame_id]])
                pairs.append({"frame_a": best_id, "frame_b": frame_id, "similarity": similarity})
                similarity_map[str(frame_id)] = similarity

            job.progress = 50 + int(((cluster_index + 1) / len(clusters)) * 50)
            session.commit()

        job.payload = {
            **job.payload,
            "result": {"duplicate_ids": duplicate_ids, "pairs": pairs, "similarity_map": similarity_map},
        }
        job.status = JobStatus.SUCCEEDED
        job.progress = 100
        job.finished_at = datetime.now(timezone.utc)
        _record_vram_usage(job)
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


LOG_FLUSH_SECONDS = 2.0
LOG_FLUSH_LINES = 20


class _LogBuffer:
    """Accumulates log lines and flushes them to TrainingRun.log_text.

    Flushed on a cadence rather than per line: a multi-hour run at ~30
    single-row UPDATEs per minute costs Postgres nothing, while one UPDATE
    per line would not.

    Thread safety: UltralyticsYoloAdapter's _ForwardingLogHandler.emit()
    calls on_log directly, outside _LineForwardingStream's lock, and
    stdlib logging can emit from a thread other than the one running
    train() (a DataLoader or callback thread). on_log here is this
    buffer's add(), which both mutates self._lines and -- on flush --
    commits self._session, a SQLAlchemy Session that is explicitly NOT
    thread-safe. Two threads committing the same session concurrently is
    a real corruption/exception risk, not a theoretical one, so add() and
    flush() both hold self._lock for their entire body: the buffer
    mutation and the session commit are serialized regardless of which
    thread calls in. The lock lives here, not in the adapter, because the
    shared state that needs protecting is this buffer and this session --
    not the call site.
    """

    def __init__(self, session, run, flush_seconds=LOG_FLUSH_SECONDS, flush_lines=LOG_FLUSH_LINES):
        self._session = session
        self._run = run
        self._lines: list[str] = []
        self._flush_seconds = flush_seconds
        self._flush_lines = flush_lines
        self._last_flush = time.monotonic()
        self._lock = threading.Lock()

    def add(self, line: str) -> None:
        with self._lock:
            self._lines.append(line)
            elapsed = time.monotonic() - self._last_flush
            if len(self._lines) >= self._flush_lines or elapsed >= self._flush_seconds:
                self._flush_locked()

    def flush(self) -> None:
        with self._lock:
            self._flush_locked()

    def _flush_locked(self) -> None:
        """Caller must hold self._lock."""
        if not self._lines:
            return
        chunk = "\n".join(self._lines) + "\n"
        self._run.log_text = (self._run.log_text or "") + chunk
        self._session.commit()
        self._lines = []
        self._last_flush = time.monotonic()

    def append_history(self, point: dict) -> None:
        """Append one per-epoch point under this buffer's lock.

        Deliberately a method here rather than a separate helper with its
        own lock: the state needing protection is this session, and two
        independent locks around one session is a deadlock waiting to
        happen. Reassigns rather than mutating in place -- SQLAlchemy does
        not track in-place mutation of a plain JSON column.
        """
        with self._lock:
            self._run.metrics_history = [*(self._run.metrics_history or []), point]
            self._session.commit()


@celery_app.task(name="model_train")
def model_train(job_id: int, adapter=None) -> None:
    """Train a model on an exported dataset.

    Runs on this worker's solo pool, which means annotation jobs queue
    behind it -- the accepted cost of one GPU. Stopping is cooperative:
    revoke(terminate=True) on a solo worker would SIGTERM the container,
    so the adapter polls TrainingRun.stop_requested at epoch boundaries.
    """
    session = SessionLocal()
    job = session.get(Job, job_id)
    if job is None:
        session.close()
        return

    run = session.get(TrainingRun, job.payload["training_run_id"])
    if run is None:
        job.status = JobStatus.FAILED
        job.error = f"TrainingRun {job.payload.get('training_run_id')} not found"
        job.finished_at = datetime.now(timezone.utc)
        session.commit()
        session.close()
        return

    if adapter is None:
        from app.ultralytics_yolo_adapter import UltralyticsYoloAdapter

        adapter = UltralyticsYoloAdapter()

    job.status = JobStatus.RUNNING
    job.started_at = datetime.now(timezone.utc)
    run.status = TrainingRunStatus.RUNNING
    run.started_at = job.started_at
    session.commit()

    buffer = _LogBuffer(session, run)
    storage = get_storage_service()

    def _on_log(line: str) -> None:
        buffer.add(line)

    def _on_epoch(epoch: int, total: int, metrics: dict | None = None) -> None:
        buffer.flush()
        run.current_epoch = epoch
        run.total_epochs = total
        job.progress = int((epoch / total) * 100) if total else 0
        _record_vram_usage(job)
        session.commit()
        # A trainer that computes nothing contributes no point at all --
        # not {"epoch": n} with no values, which would render a chart with
        # no series.
        if metrics:
            buffer.append_history({"epoch": epoch, **metrics})

    def _should_stop() -> bool:
        session.refresh(run)
        return bool(run.stop_requested)

    try:
        with tempfile.TemporaryDirectory() as workdir:
            work = Path(workdir)
            dataset_dir = work / "dataset"
            dataset_dir.mkdir()
            output_dir = work / "output"
            output_dir.mkdir()

            archive_bytes = storage.download(job.payload["export_key"])
            archive_path = work / "dataset.zip"
            archive_path.write_bytes(archive_bytes)
            with zipfile.ZipFile(archive_path) as archive:
                archive.extractall(dataset_dir)

            result = adapter.train(
                TrainingRequest(
                    dataset_dir=dataset_dir,
                    task_type=run.task_type.value,
                    base_model=run.base_model,
                    config=run.config,
                    output_dir=output_dir,
                ),
                on_log=_on_log,
                on_epoch=_on_epoch,
                should_stop=_should_stop,
            )

            buffer.flush()

            storage_key = f"models/{run.id}/{Path(result.weights_path).name}"
            storage.upload(
                storage_key,
                Path(result.weights_path).read_bytes(),
                "application/octet-stream",
            )

            artifact_keys = []
            for artifact in result.artifacts:
                artifact_path = Path(artifact)
                if not artifact_path.exists():
                    continue
                artifact_key = f"models/{run.id}/artifacts/{artifact_path.name}"
                storage.upload(
                    artifact_key,
                    artifact_path.read_bytes(),
                    "application/octet-stream",
                )
                artifact_keys.append(artifact_key)

        version = ModelVersion(
            training_run_id=run.id,
            name=f"{run.base_model.rsplit('.', 1)[0]}-run{run.id}",
            task_type=run.task_type,
            storage_key=storage_key,
            metrics=result.metrics,
            per_class_metrics=result.per_class,
            confusion_matrix=result.confusion,
            artifact_keys=artifact_keys,
        )
        session.add(version)

        run.status = (
            TrainingRunStatus.STOPPED if run.stop_requested else TrainingRunStatus.SUCCEEDED
        )
        run.metrics = result.metrics
        # A trainer that fills history only at the end wins over what
        # on_epoch accumulated: it is that trainer's final word.
        if result.history:
            run.metrics_history = result.history
        run.finished_at = datetime.now(timezone.utc)
        job.status = JobStatus.SUCCEEDED
        job.progress = 100
        job.result_ref = storage_key
        job.finished_at = run.finished_at
        session.commit()
    except Exception as exc:  # noqa: BLE001 -- recorded, not swallowed
        # buffer.flush() before rollback: the log lines already committed
        # by earlier flushes are safe, but anything still buffered must be
        # written before the rollback below discards any uncommitted ORM
        # state, matching the rollback-then-refetch pattern every other
        # task in this file uses on failure (e.g. run_sam2_predict above).
        buffer.flush()
        session.rollback()
        job = session.get(Job, job_id)
        run = session.get(TrainingRun, job.payload["training_run_id"])
        run.status = TrainingRunStatus.FAILED
        run.error = str(exc)[:2000]
        run.finished_at = datetime.now(timezone.utc)
        job.status = JobStatus.FAILED
        job.error = str(exc)[:2000]
        job.finished_at = run.finished_at
        session.commit()
    finally:
        session.close()
