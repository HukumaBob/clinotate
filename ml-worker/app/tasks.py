from datetime import datetime, timezone

from app.celery_app import celery_app
from app.db import SessionLocal
from app.models import Annotation, AnnotationStatus, AnnotationType, Frame, Job, JobStatus, Label
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


_adapter_singleton: Sam3Adapter | None = None


def _get_default_adapter() -> Sam3Adapter:
    global _adapter_singleton
    if _adapter_singleton is None:
        _adapter_singleton = Sam3Adapter()
    return _adapter_singleton


@celery_app.task(name="sam3_predict")
def run_sam3_predict(job_id: int, adapter: Sam3Adapter | None = None) -> None:
    """`adapter` is injectable for tests; production calls always resolve
    the real singleton lazily so the (slow) model load happens once per
    worker process, not once per plan-writing decision."""
    session = SessionLocal()
    storage = get_storage_service()
    resolved_adapter = adapter if adapter is not None else _get_default_adapter()

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
    resolved_adapter = adapter if adapter is not None else _get_default_adapter()

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
    finally:
        session.close()
