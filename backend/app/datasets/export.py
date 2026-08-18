"""Assemble a saved Dataset into exportable items, findings, and formats.

Walks every DatasetItem in a Dataset, resolving each annotation's mask
geometry (or, for classification, its single label) into an ExportItem the
serializers below can turn into YOLO label text or a COCO document. Findings
(missing masks, below-threshold masks, multi-label classification frames)
are collected across the whole walk rather than raised immediately, so a
multi-gigabyte export surfaces every defect in one pass instead of one
re-run per defect.
"""

from dataclasses import dataclass, field
from datetime import datetime, timezone

from sqlalchemy.orm import Session

from app.annotation.models import Annotation, AnnotationType
from app.datasets.geometry import MaskGeometry, decode_mask, extract_geometry
from app.datasets.models import Dataset, DatasetItem, TaskType
from app.media.models import Frame
from app.settings.models import PlatformSettings
from app.taxonomy.models import Label


@dataclass(frozen=True)
class Finding:
    """One defect discovered while walking a dataset's frames/annotations."""

    kind: str
    frame_id: int
    annotation_id: int | None
    detail: str


@dataclass
class ExportEntry:
    """One annotation surviving into the export, geometry already extracted."""

    annotation_id: int
    class_id: int
    class_name: str
    geometry: MaskGeometry | None
    label_id: int


@dataclass
class ExportItem:
    """One frame worth of export output: its identity plus surviving entries."""

    frame_id: int
    sequence_id: int
    frame_index: int
    split: str
    storage_key: str
    width: int
    height: int
    entries: list[ExportEntry] = field(default_factory=list)
    is_negative: bool = False


def archive_name(item: ExportItem) -> str:
    """Name a frame's exported files by sequence+index, never its basename.

    Frames are stored as frames/<sequence_id>/<index>.png; across the real
    corpus, 1109 frames share only 488 distinct basenames. Naming archive
    entries by basename alone would silently overwrite more than half the
    dataset and leave label files pointing at the wrong pixels.
    """
    return f"{item.sequence_id}_{item.frame_index}"


def collect_export_items(
    session: Session, dataset: Dataset, storage
) -> tuple[list["ExportItem"], list[Finding], dict[int, str]]:
    """Walk a dataset's items, extracting geometry and collecting findings.

    Every DatasetItem is visited regardless of defects found along the way:
    a missing mask or a multi-label classification frame becomes a Finding,
    not an exception, so the whole dataset is inspected in one pass. A mask
    below the noise threshold is dropped from its frame; if that leaves the
    frame with no surviving entries and the frame was not explicitly marked
    no_findings_reviewed, the frame is omitted entirely -- filtering a mask
    is not a claim that the frame is empty.
    """
    settings_row = session.get(PlatformSettings, 1)
    if settings_row is None:
        raise RuntimeError("platform_settings row (id=1) is missing")
    min_area_fraction = settings_row.min_mask_area_fraction

    findings: list[Finding] = []
    items: list[ExportItem] = []

    dataset_items = (
        session.query(DatasetItem).filter(DatasetItem.dataset_id == dataset.id).all()
    )

    # Class ids are assigned from one sorted list of distinct label names,
    # so the integer written into every label file and the index in
    # data.yaml's `names` come from the same source. Gather names first by
    # loading every referenced annotation's label.
    all_annotation_ids: set[int] = set()
    for dataset_item in dataset_items:
        all_annotation_ids.update(dataset_item.annotation_ids or [])

    annotations_by_id: dict[int, Annotation] = {}
    if all_annotation_ids:
        rows = (
            session.query(Annotation)
            .filter(Annotation.id.in_(all_annotation_ids))
            .all()
        )
        annotations_by_id = {row.id: row for row in rows}

    label_ids = {a.label_id for a in annotations_by_id.values()}
    labels_by_id: dict[int, Label] = {}
    if label_ids:
        labels_by_id = {
            label.id: label
            for label in session.query(Label).filter(Label.id.in_(label_ids)).all()
        }

    class_names = sorted({labels_by_id[lid].name for lid in label_ids if lid in labels_by_id})
    class_id_by_name = {name: idx for idx, name in enumerate(class_names)}
    class_names_by_id = {idx: name for idx, name in enumerate(class_names)}

    frame_ids = {dataset_item.frame_id for dataset_item in dataset_items}
    frames_by_id: dict[int, Frame] = {}
    if frame_ids:
        frames_by_id = {
            frame.id: frame
            for frame in session.query(Frame).filter(Frame.id.in_(frame_ids)).all()
        }

    for dataset_item in dataset_items:
        frame = frames_by_id.get(dataset_item.frame_id)
        if frame is None:
            findings.append(
                Finding(
                    kind="missing_frame",
                    frame_id=dataset_item.frame_id,
                    annotation_id=None,
                    detail=f"frame {dataset_item.frame_id} referenced by dataset item not found",
                )
            )
            continue

        annotation_ids = dataset_item.annotation_ids or []
        annotations = [
            annotations_by_id[aid] for aid in annotation_ids if aid in annotations_by_id
        ]

        entries: list[ExportEntry] = []

        if dataset.task_type == TaskType.CLASSIFICATION:
            if len(annotations) > 1:
                label_names = ", ".join(
                    labels_by_id[a.label_id].name
                    for a in annotations
                    if a.label_id in labels_by_id
                )
                findings.append(
                    Finding(
                        kind="multi_label_classification",
                        frame_id=frame.id,
                        annotation_id=None,
                        detail=f"frame carries {len(annotations)} classification labels: {label_names}",
                    )
                )
                continue
            for annotation in annotations:
                label = labels_by_id.get(annotation.label_id)
                if label is None:
                    continue
                entries.append(
                    ExportEntry(
                        annotation_id=annotation.id,
                        class_id=class_id_by_name[label.name],
                        class_name=label.name,
                        geometry=None,
                        label_id=label.id,
                    )
                )
        else:
            for annotation in annotations:
                label = labels_by_id.get(annotation.label_id)
                if label is None:
                    continue

                if not annotation.storage_key:
                    findings.append(
                        Finding(
                            kind="missing_mask",
                            frame_id=frame.id,
                            annotation_id=annotation.id,
                            detail="annotation has no storage_key",
                        )
                    )
                    continue

                try:
                    data = storage.download(annotation.storage_key)
                except Exception as exc:  # noqa: BLE001 -- any storage failure is a finding
                    findings.append(
                        Finding(
                            kind="missing_mask",
                            frame_id=frame.id,
                            annotation_id=annotation.id,
                            detail=str(exc),
                        )
                    )
                    continue

                try:
                    mask = decode_mask(data)
                    geometry = extract_geometry(mask)
                except ValueError as exc:
                    findings.append(
                        Finding(
                            kind="invalid_mask",
                            frame_id=frame.id,
                            annotation_id=annotation.id,
                            detail=str(exc),
                        )
                    )
                    continue

                frame_area = frame.width * frame.height
                fraction = (geometry.area_px / frame_area) if frame_area else 0.0
                if fraction < min_area_fraction:
                    findings.append(
                        Finding(
                            kind="mask_below_threshold",
                            frame_id=frame.id,
                            annotation_id=annotation.id,
                            detail=f"{fraction:.5f}",
                        )
                    )
                    continue

                entries.append(
                    ExportEntry(
                        annotation_id=annotation.id,
                        class_id=class_id_by_name[label.name],
                        class_name=label.name,
                        geometry=geometry,
                        label_id=label.id,
                    )
                )

        is_negative = not entries and bool(frame.no_findings_reviewed)
        if not entries and not is_negative:
            # The frame's only annotation(s) were filtered/errored out; this
            # is not the same as the frame being confirmed empty, so it
            # leaves the dataset rather than becoming a negative.
            continue

        items.append(
            ExportItem(
                frame_id=frame.id,
                sequence_id=frame.sequence_id,
                frame_index=frame.frame_index,
                split=dataset_item.split.value
                if hasattr(dataset_item.split, "value")
                else dataset_item.split,
                storage_key=frame.storage_key,
                width=frame.width,
                height=frame.height,
                entries=entries,
                is_negative=is_negative,
            )
        )

    return items, findings, class_names_by_id


def _clamp01(value: float) -> float:
    return max(0.0, min(1.0, value))


def write_yolo_label(item: ExportItem, task_type: TaskType) -> str:
    """Render one frame's surviving entries as YOLO label text.

    Empty for a negative frame. Detection lines are `class cx cy w h`;
    segmentation lines are `class x1 y1 x2 y2 ...` -- both normalized by the
    frame's width/height and clamped into [0, 1].
    """
    if item.is_negative or not item.entries:
        return ""

    lines: list[str] = []
    width, height = item.width, item.height

    for entry in item.entries:
        if entry.geometry is None:
            continue
        geometry = entry.geometry

        if task_type == TaskType.SEGMENTATION:
            coords: list[float] = []
            for x, y in geometry.polygon:
                coords.append(_clamp01(x / width))
                coords.append(_clamp01(y / height))
            values = " ".join(f"{v:.6f}" for v in coords)
            lines.append(f"{entry.class_id} {values}")
        else:
            x, y, w, h = geometry.bbox
            cx = _clamp01((x + w / 2) / width)
            cy = _clamp01((y + h / 2) / height)
            nw = _clamp01(w / width)
            nh = _clamp01(h / height)
            lines.append(f"{entry.class_id} {cx:.6f} {cy:.6f} {nw:.6f} {nh:.6f}")

    if not lines:
        return ""
    return "\n".join(lines) + "\n"


def build_coco(
    items: list[ExportItem], class_names: dict[int, str], dataset: Dataset
) -> dict:
    """Build one COCO document from every ExportItem produced by this export.

    `info` carries provenance (taxonomy_version, class_map, class_limits,
    excluded_label_ids, split_config, an ISO export timestamp) so the
    resulting file is self-describing without the originating Dataset row.
    A negative frame appears in `images` with no corresponding entry in
    `annotations`.
    """
    # class_map maps class name -> source label_id(s) it was derived from.
    class_map: dict[str, list[int]] = {}
    for item in items:
        for entry in item.entries:
            label_ids = class_map.setdefault(entry.class_name, [])
            if entry.label_id not in label_ids:
                label_ids.append(entry.label_id)

    categories = [
        {"id": class_id, "name": class_names[class_id]}
        for class_id in sorted(class_names)
    ]

    images = []
    annotations = []
    annotation_id = 1

    for item in items:
        images.append(
            {
                "id": item.frame_id,
                "file_name": f"{archive_name(item)}.png",
                "width": item.width,
                "height": item.height,
                "split": item.split,
            }
        )
        for entry in item.entries:
            if entry.geometry is None:
                continue
            geometry = entry.geometry
            x, y, w, h = geometry.bbox
            segmentation = [coord for point in geometry.polygon for coord in point]
            annotations.append(
                {
                    "id": annotation_id,
                    "image_id": item.frame_id,
                    "category_id": entry.class_id,
                    "bbox": [x, y, w, h],
                    "segmentation": [segmentation],
                    "area": geometry.area_px,
                    "iscrowd": 0,
                }
            )
            annotation_id += 1

    info = {
        "taxonomy_version": dataset.taxonomy_version,
        "class_map": class_map,
        "class_limits": dataset.class_limits,
        "excluded_label_ids": dataset.excluded_label_ids,
        "split_config": dataset.split_config,
        "exported_at": datetime.now(timezone.utc).isoformat(),
    }

    return {
        "info": info,
        "images": images,
        "annotations": annotations,
        "categories": categories,
    }
