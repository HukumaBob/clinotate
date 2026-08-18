from dataclasses import dataclass

import cv2
import numpy as np


@dataclass(frozen=True)
class MaskGeometry:
    """The shape of one annotation, derived once from its raster.

    Geometry is not stored in the database -- Annotation.payload holds the
    SAM prompt that produced the mask, not the resulting shape -- so every
    label file is derived from the raster. Extracting once and reusing the
    result is what keeps a multi-format export from decoding each mask twice.
    """

    bbox: tuple[int, int, int, int]
    polygon: list[tuple[int, int]]
    area_px: int


def decode_mask(data: bytes) -> np.ndarray:
    """Decode PNG bytes into a 2-D uint8 mask."""
    buffer = np.frombuffer(data, dtype=np.uint8)
    mask = cv2.imdecode(buffer, cv2.IMREAD_GRAYSCALE)
    if mask is None:
        raise ValueError("mask bytes could not be decoded as an image")
    return mask


def extract_geometry(mask: np.ndarray) -> MaskGeometry:
    """Bounding box, outer polygon and pixel area of a mask's largest blob.

    Raises on an empty mask rather than emitting a degenerate shape: a label
    file with a zero-area box trains a detector on nothing, and silently
    writing one would hide a real annotation defect.
    """
    binary = (mask > 0).astype(np.uint8)
    area_px = int(binary.sum())
    if area_px == 0:
        raise ValueError("mask has no non-zero pixels")

    contours, _ = cv2.findContours(binary, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    if not contours:
        raise ValueError("mask has no extractable contour")

    largest = max(contours, key=cv2.contourArea)
    x, y, w, h = cv2.boundingRect(largest)

    # Simplify the contour so a polygon label stays a few dozen points
    # instead of one point per boundary pixel.
    epsilon = 0.002 * cv2.arcLength(largest, True)
    simplified = cv2.approxPolyDP(largest, epsilon, True)
    polygon = [(int(point[0][0]), int(point[0][1])) for point in simplified]

    return MaskGeometry(bbox=(x, y, w, h), polygon=polygon, area_px=area_px)
