"""Celery task that assembles a Dataset export archive and uploads it.

Follows tasks.py's transcode_video shape: a stale-job guard, RUNNING ->
SUCCEEDED/FAILED transitions, started_at/finished_at, SessionLocal(). The
archive itself is streamed into a tempfile.NamedTemporaryFile rather than
held in memory -- real datasets run to gigabytes, and media/service.py's
sanctioned tempfile exception is the precedent this follows.
"""

import json
import logging
import tempfile
import zipfile
from datetime import datetime, timezone

import app.db as db_module
from app.auth.models import User  # noqa: F401 -- registers `users` for Job.created_by_id's FK
from app.datasets.export import (
    archive_name,
    build_coco,
    collect_export_items,
    write_yolo_label,
)
from app.datasets.models import Dataset, TaskType
from app.jobs.models import Job, JobStatus
from app.storage import get_storage_service
from app.worker.celery_app import celery_app

logger = logging.getLogger(__name__)

_ERROR_FINDING_KINDS = {"missing_mask", "invalid_mask", "multi_label_classification"}


def _data_yaml(class_names_by_id: dict[int, str]) -> str:
    names = ", ".join(
        f"{idx}: {class_names_by_id[idx]}" for idx in sorted(class_names_by_id)
    )
    lines = [
        "train: images/train",
        "val: images/val",
        "test: images/test",
        f"nc: {len(class_names_by_id)}",
        f"names: {{{names}}}",
    ]
    return "\n".join(lines) + "\n"


@celery_app.task(name="dataset_export")
def dataset_export(job_id: int) -> None:
    # Resolved dynamically off the module (not `from app.db import
    # SessionLocal` at import time) so tests that repoint
    # `app.db.SessionLocal` at the test database -- see conftest.py's
    # `_route_app_db_sessions_to_the_test_database` -- take effect here too.
    session = db_module.SessionLocal()
    storage = get_storage_service()

    job = session.get(Job, job_id)
    if job is None:
        # A stale message from a broker queue can outlive the database it
        # referenced -- log and drop rather than crashing the worker on an
        # AttributeError, mirroring transcode_video's guard.
        logger.warning("dataset_export: job_id=%s not found, skipping", job_id)
        return
    job.status = JobStatus.RUNNING
    job.started_at = datetime.now(timezone.utc)
    session.commit()

    try:
        dataset_id = job.payload["dataset_id"]
        include_images = job.payload.get("include_images", True)

        dataset = session.get(Dataset, dataset_id)
        if dataset is None:
            raise ValueError(f"Dataset {dataset_id} not found")

        items, findings, class_names_by_id = collect_export_items(session, dataset, storage)

        error_findings = [f for f in findings if f.kind in _ERROR_FINDING_KINDS]
        if error_findings:
            job.status = JobStatus.FAILED
            job.payload = {
                **job.payload,
                "findings": [
                    {
                        "kind": f.kind,
                        "frame_id": f.frame_id,
                        "annotation_id": f.annotation_id,
                        "detail": f.detail,
                    }
                    for f in findings
                ],
            }
            job.error = f"{len(error_findings)} findings; export aborted"
            job.finished_at = datetime.now(timezone.utc)
            session.commit()
            return

        # YOLO classification reads a DIRECTORY whose subfolder names are the
        # class names (train/<class>/<image>.png) and never a data.yaml, while
        # detection and segmentation read images/ + labels/ + data.yaml. One
        # layout cannot serve both: exporting the detection shape for a
        # classification dataset yields an archive Ultralytics rejects with a
        # missing-images/val error that hides the real mismatch.
        is_classification = dataset.task_type == TaskType.CLASSIFICATION

        with tempfile.NamedTemporaryFile(suffix=".zip") as archive_tmp:
            with zipfile.ZipFile(archive_tmp, mode="w", compression=zipfile.ZIP_DEFLATED) as archive:
                if not is_classification:
                    archive.writestr("data.yaml", _data_yaml(class_names_by_id))

                total = len(items)
                for index, item in enumerate(items, start=1):
                    name = archive_name(item)

                    if is_classification:
                        # A classification frame carries exactly one label --
                        # export.py already reports a multi_label_classification
                        # finding otherwise, and those abort the export.
                        if include_images and item.entries:
                            class_name = item.entries[0].class_name
                            image_bytes = storage.download(item.storage_key)
                            archive.writestr(
                                f"{item.split}/{class_name}/{name}.png", image_bytes
                            )
                    else:
                        label_text = write_yolo_label(item, dataset.task_type)
                        archive.writestr(f"labels/{item.split}/{name}.txt", label_text)

                        if include_images:
                            image_bytes = storage.download(item.storage_key)
                            archive.writestr(f"images/{item.split}/{name}.png", image_bytes)

                    job.progress = int(index / total * 100) if total else 100
                    session.commit()

                coco = build_coco(items, class_names_by_id, dataset)
                archive.writestr("annotations.json", json.dumps(coco))

            archive_tmp.flush()
            archive_tmp.seek(0)
            archive_bytes = archive_tmp.read()

        timestamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S%f")
        archive_key = f"datasets/{dataset_id}/export-{timestamp}.zip"
        storage.upload(archive_key, archive_bytes, "application/zip")

        # Splits are assigned per grouping unit -- a whole video, so one
        # procedure never straddles train and val and validation cannot
        # measure memorisation of it. A dataset built from a single unit
        # therefore lands entirely in train, and Ultralytics only notices at
        # training time, reporting a missing images/val directory that reads
        # as a broken archive. Say it here, while the user is still looking
        # at the dataset. Not an error: a train-only export is legal, it
        # simply cannot be validated.
        populated = {item.split for item in items}
        split_config = dataset.split_config or {}
        train_pct = split_config.get("train", 70)
        val_pct = split_config.get("val", 20)
        wanted = {
            "train": train_pct > 0,
            "val": val_pct > 0,
            "test": max(100 - train_pct - val_pct, 0) > 0,
        }
        warnings = [
            f"{name} split is empty: the dataset's frames all fall in one "
            "grouping unit, so there is nothing to validate against"
            for name in ("train", "val", "test")
            if wanted[name] and name not in populated
        ]

        warning_findings = [f for f in findings if f.kind not in _ERROR_FINDING_KINDS]
        job.payload = {
            **job.payload,
            "warnings": warnings,
            "findings": [
                {
                    "kind": f.kind,
                    "frame_id": f.frame_id,
                    "annotation_id": f.annotation_id,
                    "detail": f.detail,
                }
                for f in warning_findings
            ],
        }
        job.status = JobStatus.SUCCEEDED
        job.progress = 100
        job.result_ref = archive_key
        job.finished_at = datetime.now(timezone.utc)
        session.commit()
    except Exception as exc:
        session.rollback()
        job = session.get(Job, job_id)
        job.status = JobStatus.FAILED
        job.error = str(exc)
        job.finished_at = datetime.now(timezone.utc)
        session.commit()
    # No `finally: session.close()` -- see tasks.py's identical note: tests
    # patch SessionLocal to return a shared, transactional session so the
    # task's writes are visible before either side commits/rolls back.
