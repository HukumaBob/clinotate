"""Crop geometry and sample loading for the DINOv3 crop classifier.

Pure numpy/OpenCV: reads the COCO ``annotations.json`` the backend exporter
writes and cuts one square, fixed-size RGB crop per annotated region.
"""

from __future__ import annotations

import json
from collections import Counter
from dataclasses import dataclass
from pathlib import Path
from typing import Callable

import cv2
import numpy as np


VALID_SPLITS = ("train", "val", "test")


@dataclass
class Sample:
    image_path: Path
    bbox: tuple[float, float, float, float]  # x, y, w, h in pixels
    polygon: list[tuple[float, float]]
    class_id: int  # dense 0..n-1
    split: str


def read_rgb(path: Path) -> np.ndarray:
    """Read an image file as an RGB uint8 HxWx3 array."""
    bgr = cv2.imread(str(path), cv2.IMREAD_COLOR)
    if bgr is None:
        raise FileNotFoundError(f"Could not read image: {path}")
    return cv2.cvtColor(bgr, cv2.COLOR_BGR2RGB)


def _parse_polygon(segmentation) -> list[tuple[float, float]]:
    if not segmentation:
        return []
    ring = segmentation[0]
    return [
        (float(ring[i]), float(ring[i + 1])) for i in range(0, len(ring) - 1, 2)
    ]


def load_samples(
    dataset_dir: Path, on_log: Callable[[str], None]
) -> tuple[list[Sample], list[str]]:
    """Return one Sample per usable annotation plus dense-ordered class names."""
    dataset_dir = Path(dataset_dir)
    doc = json.loads((dataset_dir / "annotations.json").read_text())

    ids = sorted(c["id"] for c in doc["categories"])
    dense = {cid: i for i, cid in enumerate(ids)}
    name_by_id = {c["id"]: c["name"] for c in doc["categories"]}
    class_names = [name_by_id[cid] for cid in ids]

    images = {img["id"]: img for img in doc["images"]}
    exists_cache: dict[int, bool] = {}
    skipped: Counter[str] = Counter()
    samples: list[Sample] = []

    for ann in doc["annotations"]:
        img = images.get(ann["image_id"])
        if img is None:
            skipped["unknown image"] += 1
            continue
        if img.get("split") not in VALID_SPLITS:
            skipped["unknown or missing split"] += 1
            continue
        path = dataset_dir / "images" / img["split"] / img["file_name"]
        if img["id"] not in exists_cache:
            exists_cache[img["id"]] = path.is_file()
        if not exists_cache[img["id"]]:
            skipped["missing image file"] += 1
            continue
        x, y, w, h = ann["bbox"]
        if w <= 0 or h <= 0:
            skipped["empty box"] += 1
            continue
        if ann["category_id"] not in dense:
            skipped["unknown category"] += 1
            continue
        samples.append(
            Sample(
                image_path=path,
                bbox=(float(x), float(y), float(w), float(h)),
                polygon=_parse_polygon(ann.get("segmentation")),
                class_id=dense[ann["category_id"]],
                split=img["split"],
            )
        )

    total = sum(skipped.values())
    if total:
        reasons = ", ".join(f"{n} {reason}" for reason, n in skipped.items())
        on_log(f"Skipped {total} regions: {reasons}")
    return samples, class_names


def crop_region(
    image: np.ndarray,
    sample_bbox: tuple[float, float, float, float],
    polygon: list[tuple[float, float]],
    *,
    margin: float,
    mask_mode: str,
    imgsz: int,
) -> np.ndarray:
    """Cut a square ``imgsz x imgsz x 3`` RGB crop around a region."""
    img_h, img_w = image.shape[:2]
    x, y, w, h = sample_bbox
    mx, my = margin * w, margin * h
    x0 = max(0, int(np.floor(x - mx)))
    y0 = max(0, int(np.floor(y - my)))
    x1 = min(img_w, int(np.ceil(x + w + mx)))
    y1 = min(img_h, int(np.ceil(y + h + my)))
    if x1 <= x0:
        x1 = min(img_w, x0 + 1)
        x0 = x1 - 1
    if y1 <= y0:
        y1 = min(img_h, y0 + 1)
        y0 = y1 - 1

    crop = image[y0:y1, x0:x1]
    ch, cw = crop.shape[:2]
    mean = np.round(crop.reshape(-1, 3).mean(axis=0)).astype(np.uint8)

    side = max(ch, cw)
    off_y, off_x = (side - ch) // 2, (side - cw) // 2
    square = np.empty((side, side, 3), dtype=np.uint8)
    square[:] = mean
    square[off_y : off_y + ch, off_x : off_x + cw] = crop

    if mask_mode in ("zero", "blur") and len(polygon) >= 3:
        pts = np.array(
            [[px - x0 + off_x, py - y0 + off_y] for px, py in polygon],
            dtype=np.float64,
        )
        mask = np.zeros((side, side), dtype=np.uint8)
        cv2.fillPoly(mask, [np.round(pts).astype(np.int32)], 1)
        outside = mask == 0
        if mask_mode == "zero":
            square[outside] = mean
        else:
            sigma = max(1.0, 0.05 * side)
            blurred = cv2.GaussianBlur(square, (0, 0), sigma)
            square[outside] = blurred[outside]

    interp = cv2.INTER_AREA if side > imgsz else cv2.INTER_CUBIC
    return cv2.resize(square, (imgsz, imgsz), interpolation=interp)
