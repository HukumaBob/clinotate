import io
import json
import zipfile

import app.main  # noqa: F401
import cv2
import numpy as np
import sqlalchemy as sa
from fastapi.testclient import TestClient

from app.annotation.models import Annotation, AnnotationStatus, AnnotationType
from app.datasets.models import Dataset, DatasetItem, SplitName, TaskType
from app.jobs.models import Job, JobStatus, JobType
from app.main import app
from app.media.models import Frame, Sequence, Video
from app.taxonomy.models import AnnotationScope, Category, EvaluationType, Label, Procedure

client = TestClient(app)


def _register_and_login(email: str) -> dict[str, str]:
    client.post("/auth/register", json={"email": email, "password": "pass1234", "role": "admin"})
    response = client.post("/auth/login", json={"email": email, "password": "pass1234"})
    return {"Authorization": f"Bearer {response.json()['access_token']}"}


def test_export_endpoint_creates_a_pending_job_without_blocking():
    from app.db import SessionLocal

    headers = _register_and_login("export-api1@example.com")
    session = SessionLocal()
    try:
        user_id = session.execute(sa.text("SELECT id FROM users ORDER BY id LIMIT 1")).scalar()
        dataset = Dataset(
            name="export-api1-ds", task_type=TaskType.DETECTION, taxonomy_version=1,
            split_config={"train": 70, "val": 20}, grouping_overrides={},
            excluded_label_ids=[], class_limits={}, balance_metrics={},
            created_by_id=user_id,
        )
        session.add(dataset)
        session.commit()
        dataset_id = dataset.id
    finally:
        session.close()

    response = client.post(f"/datasets/{dataset_id}/export",
                           json={"include_images": True}, headers=headers)

    assert response.status_code == 202
    body = response.json()
    assert body["job_type"] == "dataset_export"
    assert body["status"] == "pending"
    assert body["payload"]["dataset_id"] == dataset_id
    assert body["payload"]["include_images"] is True

    cleanup = SessionLocal()
    try:
        cleanup.query(Job).filter(Job.id == body["id"]).delete()
        cleanup.query(Dataset).filter(Dataset.id == dataset_id).delete()
        cleanup.commit()
    finally:
        cleanup.close()


def test_exporting_an_unknown_dataset_returns_404():
    headers = _register_and_login("export-api2@example.com")
    response = client.post("/datasets/99999999/export",
                           json={"include_images": True}, headers=headers)
    assert response.status_code == 404


def test_include_images_defaults_to_true():
    from app.db import SessionLocal

    headers = _register_and_login("export-api3@example.com")
    session = SessionLocal()
    try:
        user_id = session.execute(sa.text("SELECT id FROM users ORDER BY id LIMIT 1")).scalar()
        dataset = Dataset(
            name="export-api3-ds", task_type=TaskType.DETECTION, taxonomy_version=1,
            split_config={"train": 70, "val": 20}, grouping_overrides={},
            excluded_label_ids=[], class_limits={}, balance_metrics={},
            created_by_id=user_id,
        )
        session.add(dataset)
        session.commit()
        dataset_id = dataset.id
    finally:
        session.close()

    response = client.post(f"/datasets/{dataset_id}/export", json={}, headers=headers)

    assert response.status_code == 202
    assert response.json()["payload"]["include_images"] is True

    cleanup = SessionLocal()
    try:
        cleanup.query(Job).filter(Job.id == response.json()["id"]).delete()
        cleanup.query(Dataset).filter(Dataset.id == dataset_id).delete()
        cleanup.commit()
    finally:
        cleanup.close()


class _FakeStorage:
    def __init__(self):
        self.objects: dict[str, bytes] = {}
        self.uploaded: dict[str, bytes] = {}

    def put(self, key: str, data: bytes) -> None:
        self.objects[key] = data

    def download(self, key: str) -> bytes:
        if key not in self.objects:
            raise FileNotFoundError(key)
        return self.objects[key]

    def upload(self, key: str, data: bytes, content_type: str) -> None:
        self.uploaded[key] = data


def _png(height=80, width=100, x=10, y=20, w=30, h=40):
    mask = np.zeros((height, width), dtype=np.uint8)
    mask[y : y + h, x : x + w] = 255
    return cv2.imencode(".png", mask)[1].tobytes()


def _build_dataset(session, tag, include_mask=True, task_type=TaskType.DETECTION,
                   annotation_scope=AnnotationScope.REGION):
    procedure = Procedure(name=f"xt-{tag}-proc")
    session.add(procedure)
    session.flush()
    category = Category(name=f"xt-{tag}-cat", procedure_id=procedure.id)
    session.add(category)
    session.flush()
    region = EvaluationType(name=f"xt-{tag}-et", annotation_scope=annotation_scope)
    session.add(region)
    session.flush()
    video = Video(title=f"xt-{tag}-v", storage_key=f"xt/{tag}.mp4", checksum=f"xt-{tag}",
                  fps=25.0, duration_seconds=1.0)
    session.add(video)
    session.flush()
    sequence = Sequence(name=f"xt-{tag}-seq", start_time=0, duration=1,
                        procedure_id=procedure.id, video_id=video.id)
    session.add(sequence)
    session.flush()
    frame = Frame(sequence_id=sequence.id, storage_key=f"frames/{sequence.id}/1.png",
                  frame_index=1, width=100, height=80)
    session.add(frame)
    session.flush()
    label = Label(name=f"xt-{tag}-polyp", category_id=category.id,
                  evaluation_type_id=region.id)
    session.add(label)
    session.flush()
    user_id = session.execute(sa.text("SELECT id FROM users ORDER BY id LIMIT 1")).scalar()
    annotation = Annotation(
        frame_id=frame.id, label_id=label.id, taxonomy_version=label.taxonomy_version,
        annotation_type=AnnotationType.MASK, payload={}, status=AnnotationStatus.DRAFT,
        created_by_id=user_id, storage_key=f"masks/xt-{tag}.png",
    )
    session.add(annotation)
    session.flush()
    dataset = Dataset(
        name=f"xt-{tag}-ds", task_type=task_type, taxonomy_version=1,
        split_config={"train": 70, "val": 20}, grouping_overrides={},
        excluded_label_ids=[], class_limits={}, balance_metrics={}, created_by_id=user_id,
    )
    session.add(dataset)
    session.flush()
    session.add(DatasetItem(dataset_id=dataset.id, frame_id=frame.id,
                            annotation_ids=[annotation.id], split=SplitName.TRAIN))
    session.flush()
    return dataset, frame, annotation, user_id


def test_the_task_writes_an_archive_with_both_formats(monkeypatch):
    from app.db import SessionLocal

    from app.worker import export_task as module

    session = SessionLocal()
    try:
        dataset, frame, annotation, user_id = _build_dataset(session, "both")
        storage = _FakeStorage()
        storage.put(annotation.storage_key, _png())
        storage.put(frame.storage_key, _png())
        job = Job(job_type=JobType.DATASET_EXPORT, payload={
            "dataset_id": dataset.id, "include_images": True}, created_by_id=user_id)
        session.add(job)
        session.commit()
        job_id = job.id

        monkeypatch.setattr(module, "get_storage_service", lambda: storage)
        module.dataset_export(job_id)

        refreshed = SessionLocal()
        try:
            done = refreshed.get(Job, job_id)
            assert done.status == JobStatus.SUCCEEDED, done.error
            assert done.result_ref in storage.uploaded
            with zipfile.ZipFile(io.BytesIO(storage.uploaded[done.result_ref])) as archive:
                names = archive.namelist()
                assert "data.yaml" in names
                assert "annotations.json" in names
                assert any(n.startswith("labels/train/") for n in names)
                assert any(n.startswith("images/train/") for n in names)
                coco = json.loads(archive.read("annotations.json"))
                assert coco["info"]["taxonomy_version"] == 1
        finally:
            refreshed.close()
    finally:
        session.rollback()
        session.close()


def test_include_images_false_omits_the_images_directory(monkeypatch):
    from app.db import SessionLocal

    from app.worker import export_task as module

    session = SessionLocal()
    try:
        dataset, frame, annotation, user_id = _build_dataset(session, "noimg")
        storage = _FakeStorage()
        storage.put(annotation.storage_key, _png())
        storage.put(frame.storage_key, _png())
        job = Job(job_type=JobType.DATASET_EXPORT, payload={
            "dataset_id": dataset.id, "include_images": False}, created_by_id=user_id)
        session.add(job)
        session.commit()
        job_id = job.id

        monkeypatch.setattr(module, "get_storage_service", lambda: storage)
        module.dataset_export(job_id)

        refreshed = SessionLocal()
        try:
            done = refreshed.get(Job, job_id)
            assert done.status == JobStatus.SUCCEEDED, done.error
            with zipfile.ZipFile(io.BytesIO(storage.uploaded[done.result_ref])) as archive:
                names = archive.namelist()
                assert not any(n.startswith("images/") for n in names)
                assert "annotations.json" in names
        finally:
            refreshed.close()
    finally:
        session.rollback()
        session.close()


def test_findings_abort_the_export_and_are_recorded_on_the_job(monkeypatch):
    from app.db import SessionLocal

    from app.worker import export_task as module

    session = SessionLocal()
    try:
        dataset, frame, annotation, user_id = _build_dataset(session, "abort")
        storage = _FakeStorage()  # mask deliberately absent
        storage.put(frame.storage_key, _png())
        job = Job(job_type=JobType.DATASET_EXPORT, payload={
            "dataset_id": dataset.id, "include_images": True}, created_by_id=user_id)
        session.add(job)
        session.commit()
        job_id = job.id

        monkeypatch.setattr(module, "get_storage_service", lambda: storage)
        module.dataset_export(job_id)

        refreshed = SessionLocal()
        try:
            done = refreshed.get(Job, job_id)
            assert done.status == JobStatus.FAILED
            findings = done.payload["findings"]
            assert any(f["kind"] == "missing_mask" for f in findings)
            assert done.error and "finding" in done.error.lower()
        finally:
            refreshed.close()
    finally:
        session.rollback()
        session.close()


def test_a_classification_export_uses_the_folder_per_class_layout(monkeypatch):
    """YOLO classification reads a directory, never a data.yaml.

    Its class names come from the subdirectory names under train/, so a
    classification dataset has to ship as train/<class>/<image>.png with no
    labels/ at all. Exporting the detection layout instead produced an
    archive Ultralytics could not read: it reported a missing images/val
    path, which says nothing about the real mismatch.
    """
    from app.db import SessionLocal

    from app.worker import export_task as module

    session = SessionLocal()
    try:
        dataset, frame, annotation, user_id = _build_dataset(
            session, "cls", task_type=TaskType.CLASSIFICATION,
            annotation_scope=AnnotationScope.FRAME,
        )
        storage = _FakeStorage()
        storage.put(annotation.storage_key, _png())
        storage.put(frame.storage_key, _png())
        job = Job(job_type=JobType.DATASET_EXPORT, payload={
            "dataset_id": dataset.id, "include_images": True}, created_by_id=user_id)
        session.add(job)
        session.commit()
        job_id = job.id

        monkeypatch.setattr(module, "get_storage_service", lambda: storage)
        module.dataset_export(job_id)

        refreshed = SessionLocal()
        try:
            done = refreshed.get(Job, job_id)
            assert done.status == JobStatus.SUCCEEDED, done.error
            with zipfile.ZipFile(io.BytesIO(storage.uploaded[done.result_ref])) as archive:
                names = archive.namelist()
                assert not any(n.startswith("labels/") for n in names), names
                assert "data.yaml" not in names, names
                images = [n for n in names if n.endswith(".png")]
                assert images, names
                # train/<class>/<file>.png -- the class name is the folder.
                for path in images:
                    parts = path.split("/")
                    assert len(parts) == 3, path
                    assert parts[0] in {"train", "val", "test"}, path
                    assert parts[1] == f"xt-cls-polyp", path
        finally:
            refreshed.close()
    finally:
        session.rollback()
        session.close()


def test_an_empty_val_split_is_warned_about_on_the_job(monkeypatch):
    """A train-only dataset exports fine but cannot be validated.

    Splits are assigned per grouping unit -- a whole video, so one procedure
    never straddles train and val and validation cannot measure memorisation
    of it. A dataset built from a single unit therefore lands entirely in
    train. Ultralytics only discovers this at training time, reporting a
    missing images/val directory, which reads as a broken archive rather
    than a dataset that has nothing to validate against. Warn on the job so
    the user sees it while still looking at the dataset.
    """
    from app.db import SessionLocal

    from app.worker import export_task as module

    session = SessionLocal()
    try:
        dataset, frame, annotation, user_id = _build_dataset(session, "emptyval")
        storage = _FakeStorage()
        storage.put(annotation.storage_key, _png())
        storage.put(frame.storage_key, _png())
        job = Job(job_type=JobType.DATASET_EXPORT, payload={
            "dataset_id": dataset.id, "include_images": True}, created_by_id=user_id)
        session.add(job)
        session.commit()
        job_id = job.id

        monkeypatch.setattr(module, "get_storage_service", lambda: storage)
        module.dataset_export(job_id)

        refreshed = SessionLocal()
        try:
            done = refreshed.get(Job, job_id)
            # The export still succeeds -- an unvalidatable dataset is legal.
            assert done.status == JobStatus.SUCCEEDED, done.error
            warnings = done.payload.get("warnings", [])
            assert any("val" in w for w in warnings), warnings
        finally:
            refreshed.close()
    finally:
        session.rollback()
        session.close()


def test_a_single_class_dataset_is_warned_about(monkeypatch):
    """One class means the model cannot be wrong, and learns nothing.

    A classifier with a single class answers it every time and scores 1.0
    accuracy -- which reads as a perfect model rather than as an absent
    task. The user hit this after a full 100-epoch run: the only clue was
    `found 113 images in 1 classes` buried in the training log. Say it at
    export time instead.
    """
    from app.db import SessionLocal

    from app.worker import export_task as module

    session = SessionLocal()
    try:
        dataset, frame, annotation, user_id = _build_dataset(
            session, "single", task_type=TaskType.CLASSIFICATION,
            annotation_scope=AnnotationScope.FRAME,
        )
        storage = _FakeStorage()
        storage.put(annotation.storage_key, _png())
        storage.put(frame.storage_key, _png())
        job = Job(job_type=JobType.DATASET_EXPORT, payload={
            "dataset_id": dataset.id, "include_images": True}, created_by_id=user_id)
        session.add(job)
        session.commit()
        job_id = job.id

        monkeypatch.setattr(module, "get_storage_service", lambda: storage)
        module.dataset_export(job_id)

        refreshed = SessionLocal()
        try:
            done = refreshed.get(Job, job_id)
            assert done.status == JobStatus.SUCCEEDED, done.error
            warnings = done.payload.get("warnings", [])
            assert any("one class" in w for w in warnings), warnings
        finally:
            refreshed.close()
    finally:
        session.rollback()
        session.close()
