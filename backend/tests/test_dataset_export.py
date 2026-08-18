import app.main  # noqa: F401 -- registers every model on Base.metadata for create_all
import cv2
import numpy as np
import pytest
import sqlalchemy as sa

from app.annotation.models import Annotation, AnnotationStatus, AnnotationType
from app.datasets.export import (
    Finding,
    archive_name,
    build_coco,
    collect_export_items,
    write_yolo_label,
)
from app.datasets.models import Dataset, DatasetItem, SplitName, TaskType
from app.db import SessionLocal
from app.media.models import Frame, Sequence, Video
from app.taxonomy.models import AnnotationScope, Category, EvaluationType, Label, Procedure


class _FakeStorage:
    """Stands in for MinIO so export tests never touch object storage."""

    def __init__(self):
        self.objects: dict[str, bytes] = {}

    def put_mask(self, key: str, mask: np.ndarray) -> None:
        self.objects[key] = cv2.imencode(".png", mask)[1].tobytes()

    def download(self, key: str) -> bytes:
        if key not in self.objects:
            raise FileNotFoundError(key)
        return self.objects[key]


def _rect_mask(height, width, x, y, w, h):
    mask = np.zeros((height, width), dtype=np.uint8)
    mask[y : y + h, x : x + w] = 255
    return mask


def _island(session, tag, scope=AnnotationScope.REGION):
    procedure = Procedure(name=f"ex-{tag}-proc")
    session.add(procedure)
    session.flush()
    category = Category(name=f"ex-{tag}-cat", procedure_id=procedure.id)
    session.add(category)
    session.flush()
    evaluation_type = EvaluationType(name=f"ex-{tag}-et", annotation_scope=scope)
    session.add(evaluation_type)
    session.flush()
    video = Video(title=f"ex-{tag}-v", storage_key=f"ex/{tag}.mp4",
                  checksum=f"ex-{tag}", fps=25.0, duration_seconds=1.0)
    session.add(video)
    session.flush()
    sequence = Sequence(name=f"ex-{tag}-seq", start_time=0, duration=1,
                        procedure_id=procedure.id, video_id=video.id)
    session.add(sequence)
    session.flush()
    user_id = session.execute(sa.text("SELECT id FROM users ORDER BY id LIMIT 1")).scalar()
    return category, evaluation_type, sequence, user_id


def _frame(session, sequence, index, width=100, height=80):
    frame = Frame(sequence_id=sequence.id, storage_key=f"frames/{sequence.id}/{index}.png",
                  frame_index=index, width=width, height=height)
    session.add(frame)
    session.flush()
    return frame


def _label(session, category, evaluation_type, name):
    label = Label(name=name, category_id=category.id, evaluation_type_id=evaluation_type.id)
    session.add(label)
    session.flush()
    return label


def _annotate(session, frame, label, user_id, annotation_type=AnnotationType.MASK, key=None):
    annotation = Annotation(
        frame_id=frame.id, label_id=label.id, taxonomy_version=label.taxonomy_version,
        annotation_type=annotation_type, payload={}, status=AnnotationStatus.DRAFT,
        created_by_id=user_id, storage_key=key,
    )
    session.add(annotation)
    session.flush()
    return annotation


def _dataset(session, user_id, task_type, items):
    dataset = Dataset(
        name=f"ex-ds-{task_type.value}", task_type=task_type, taxonomy_version=1,
        split_config={"train": 70, "val": 20}, grouping_overrides={},
        excluded_label_ids=[], class_limits={}, balance_metrics={}, created_by_id=user_id,
    )
    session.add(dataset)
    session.flush()
    for frame, annotation_ids, split in items:
        session.add(DatasetItem(dataset_id=dataset.id, frame_id=frame.id,
                                annotation_ids=annotation_ids, split=split))
    session.flush()
    return dataset


def test_archive_names_disambiguate_frames_from_different_sequences():
    # Real corpus: 1109 frames share only 488 basenames. Naming by basename
    # would silently overwrite more than half the dataset.
    session = SessionLocal()
    try:
        category, region, sequence_a, user_id = _island(session, "namea")
        _, _, sequence_b, _ = _island(session, "nameb")
        polyp = _label(session, category, region, "ex-name-polyp")
        storage = _FakeStorage()

        frame_a = _frame(session, sequence_a, 7)
        frame_b = _frame(session, sequence_b, 7)
        for frame in (frame_a, frame_b):
            key = f"masks/{frame.id}.png"
            storage.put_mask(key, _rect_mask(80, 100, 10, 20, 30, 40))
            _annotate(session, frame, polyp, user_id, key=key)

        dataset = _dataset(session, user_id, TaskType.DETECTION, [
            (frame_a, [a.id for a in session.query(Annotation).filter_by(frame_id=frame_a.id)], SplitName.TRAIN),
            (frame_b, [a.id for a in session.query(Annotation).filter_by(frame_id=frame_b.id)], SplitName.TRAIN),
        ])

        items, findings, _ = collect_export_items(session, dataset, storage)

        names = {archive_name(item) for item in items}
        assert len(names) == 2, f"names collided: {names}"
        assert findings == []
    finally:
        session.rollback()
        session.close()


def test_a_missing_mask_file_is_an_error_finding():
    session = SessionLocal()
    try:
        category, region, sequence, user_id = _island(session, "missing")
        polyp = _label(session, category, region, "ex-missing-polyp")
        storage = _FakeStorage()  # deliberately empty
        frame = _frame(session, sequence, 1)
        annotation = _annotate(session, frame, polyp, user_id, key="masks/absent.png")
        dataset = _dataset(session, user_id, TaskType.DETECTION,
                           [(frame, [annotation.id], SplitName.TRAIN)])

        _, findings, _ = collect_export_items(session, dataset, storage)

        assert any(f.kind == "missing_mask" and f.annotation_id == annotation.id
                   for f in findings)
    finally:
        session.rollback()
        session.close()


def test_every_defect_is_reported_not_just_the_first():
    session = SessionLocal()
    try:
        category, region, sequence, user_id = _island(session, "allfind")
        polyp = _label(session, category, region, "ex-allfind-polyp")
        storage = _FakeStorage()
        frames = [_frame(session, sequence, i) for i in range(3)]
        annotations = [
            _annotate(session, frame, polyp, user_id, key=f"masks/absent-{i}.png")
            for i, frame in enumerate(frames)
        ]
        dataset = _dataset(session, user_id, TaskType.DETECTION,
                           [(f, [a.id], SplitName.TRAIN) for f, a in zip(frames, annotations)])

        _, findings, _ = collect_export_items(session, dataset, storage)

        assert len([f for f in findings if f.kind == "missing_mask"]) == 3
    finally:
        session.rollback()
        session.close()


def test_a_mask_below_the_threshold_is_filtered_and_reported():
    session = SessionLocal()
    try:
        category, region, sequence, user_id = _island(session, "tiny")
        polyp = _label(session, category, region, "ex-tiny-polyp")
        storage = _FakeStorage()
        frame = _frame(session, sequence, 1, width=100, height=100)
        key = "masks/tiny.png"
        # 2x2 = 4px out of 10000 = 0.04%, below the 0.05% default.
        storage.put_mask(key, _rect_mask(100, 100, 5, 5, 2, 2))
        annotation = _annotate(session, frame, polyp, user_id, key=key)
        dataset = _dataset(session, user_id, TaskType.DETECTION,
                           [(frame, [annotation.id], SplitName.TRAIN)])

        items, findings, _ = collect_export_items(session, dataset, storage)

        assert any(f.kind == "mask_below_threshold" for f in findings)
        assert items == [], "the frame's only annotation was filtered, so it leaves"
    finally:
        session.rollback()
        session.close()


def test_a_frame_whose_only_mask_was_filtered_does_not_become_a_negative():
    # Discarding a noisy mask is not a claim that the frame is empty.
    session = SessionLocal()
    try:
        category, region, sequence, user_id = _island(session, "notneg")
        polyp = _label(session, category, region, "ex-notneg-polyp")
        storage = _FakeStorage()
        frame = _frame(session, sequence, 1, width=100, height=100)
        key = "masks/notneg.png"
        storage.put_mask(key, _rect_mask(100, 100, 5, 5, 2, 2))
        annotation = _annotate(session, frame, polyp, user_id, key=key)
        dataset = _dataset(session, user_id, TaskType.DETECTION,
                           [(frame, [annotation.id], SplitName.TRAIN)])

        items, _, _ = collect_export_items(session, dataset, storage)

        assert all(not item.is_negative for item in items)
        assert items == []
    finally:
        session.rollback()
        session.close()


def test_a_multi_label_classification_frame_is_an_error_finding():
    session = SessionLocal()
    try:
        category, frame_scope, sequence, user_id = _island(
            session, "multi", scope=AnnotationScope.FRAME)
        quality = _label(session, category, frame_scope, "ex-multi-low-quality")
        landmark = _label(session, category, frame_scope, "ex-multi-caecum")
        storage = _FakeStorage()
        frame = _frame(session, sequence, 1)
        first = _annotate(session, frame, quality, user_id, AnnotationType.CLASSIFICATION)
        second = _annotate(session, frame, landmark, user_id, AnnotationType.CLASSIFICATION)
        dataset = _dataset(session, user_id, TaskType.CLASSIFICATION,
                           [(frame, [first.id, second.id], SplitName.TRAIN)])

        _, findings, _ = collect_export_items(session, dataset, storage)

        multi = [f for f in findings if f.kind == "multi_label_classification"]
        assert multi and multi[0].frame_id == frame.id
    finally:
        session.rollback()
        session.close()


def test_a_negative_frame_yields_an_empty_yolo_label():
    session = SessionLocal()
    try:
        category, region, sequence, user_id = _island(session, "neg")
        storage = _FakeStorage()
        frame = _frame(session, sequence, 1)
        frame.no_findings_reviewed = True
        session.flush()
        dataset = _dataset(session, user_id, TaskType.DETECTION,
                           [(frame, [], SplitName.TRAIN)])

        items, findings, _ = collect_export_items(session, dataset, storage)

        assert findings == []
        assert len(items) == 1 and items[0].is_negative
        assert write_yolo_label(items[0], TaskType.DETECTION) == ""
    finally:
        session.rollback()
        session.close()


def test_detection_labels_are_normalized_into_zero_to_one():
    session = SessionLocal()
    try:
        category, region, sequence, user_id = _island(session, "norm")
        polyp = _label(session, category, region, "ex-norm-polyp")
        storage = _FakeStorage()
        frame = _frame(session, sequence, 1, width=100, height=80)
        key = "masks/norm.png"
        storage.put_mask(key, _rect_mask(80, 100, 10, 20, 30, 40))
        annotation = _annotate(session, frame, polyp, user_id, key=key)
        dataset = _dataset(session, user_id, TaskType.DETECTION,
                           [(frame, [annotation.id], SplitName.TRAIN)])

        items, _, _ = collect_export_items(session, dataset, storage)
        line = write_yolo_label(items[0], TaskType.DETECTION).strip()

        parts = line.split()
        assert parts[0] == "0"
        values = [float(v) for v in parts[1:]]
        assert len(values) == 4
        assert all(0.0 <= v <= 1.0 for v in values), values
        # bbox (10,20,30,40) on a 100x80 frame -> centre (25,40) -> 0.25, 0.5
        assert abs(values[0] - 0.25) < 0.01
        assert abs(values[1] - 0.50) < 0.01
    finally:
        session.rollback()
        session.close()


def test_segmentation_labels_are_polygons_normalized_into_zero_to_one():
    session = SessionLocal()
    try:
        category, region, sequence, user_id = _island(session, "seg")
        polyp = _label(session, category, region, "ex-seg-polyp")
        storage = _FakeStorage()
        frame = _frame(session, sequence, 1, width=100, height=80)
        key = "masks/seg.png"
        storage.put_mask(key, _rect_mask(80, 100, 10, 20, 30, 40))
        annotation = _annotate(session, frame, polyp, user_id, key=key)
        dataset = _dataset(session, user_id, TaskType.SEGMENTATION,
                           [(frame, [annotation.id], SplitName.TRAIN)])

        items, _, _ = collect_export_items(session, dataset, storage)
        line = write_yolo_label(items[0], TaskType.SEGMENTATION).strip()

        parts = line.split()
        assert parts[0] == "0"
        values = [float(v) for v in parts[1:]]
        assert len(values) >= 6 and len(values) % 2 == 0
        assert all(0.0 <= v <= 1.0 for v in values)
    finally:
        session.rollback()
        session.close()


def test_coco_carries_provenance_and_matches_the_class_map():
    session = SessionLocal()
    try:
        category, region, sequence, user_id = _island(session, "coco")
        polyp = _label(session, category, region, "ex-coco-polyp")
        storage = _FakeStorage()
        frame = _frame(session, sequence, 1, width=100, height=80)
        key = "masks/coco.png"
        storage.put_mask(key, _rect_mask(80, 100, 10, 20, 30, 40))
        annotation = _annotate(session, frame, polyp, user_id, key=key)
        dataset = _dataset(session, user_id, TaskType.DETECTION,
                           [(frame, [annotation.id], SplitName.TRAIN)])

        items, _, class_names = collect_export_items(session, dataset, storage)
        coco = build_coco(items, class_names, dataset)

        assert coco["info"]["taxonomy_version"] == dataset.taxonomy_version
        assert "class_map" in coco["info"]
        assert coco["info"]["class_limits"] == dataset.class_limits
        assert coco["info"]["excluded_label_ids"] == dataset.excluded_label_ids
        assert len(coco["images"]) == 1
        assert len(coco["annotations"]) == 1
        assert coco["annotations"][0]["bbox"] == [10, 20, 30, 40]
        assert coco["annotations"][0]["segmentation"]
        category_ids = {c["id"] for c in coco["categories"]}
        assert coco["annotations"][0]["category_id"] in category_ids
    finally:
        session.rollback()
        session.close()


def test_a_negative_frame_appears_in_coco_images_with_no_annotation():
    session = SessionLocal()
    try:
        category, region, sequence, user_id = _island(session, "coconeg")
        storage = _FakeStorage()
        frame = _frame(session, sequence, 1)
        frame.no_findings_reviewed = True
        session.flush()
        dataset = _dataset(session, user_id, TaskType.DETECTION,
                           [(frame, [], SplitName.TRAIN)])

        items, _, class_names = collect_export_items(session, dataset, storage)
        coco = build_coco(items, class_names, dataset)

        assert len(coco["images"]) == 1
        assert coco["annotations"] == []
    finally:
        session.rollback()
        session.close()
