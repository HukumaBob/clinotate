"""Working-area crop for QC inference, and the way back to full-frame coordinates.

Training frames are cut with ``backend/app/media/service.py:_apply_crop``
(percent insets, ``int()`` truncation per side). The arithmetic here must stay
identical to it, so the model sees the same kind of region at inference time.
The ml-worker cannot import the backend; ``tests/test_crop.py`` pins the two.
"""

import numpy as np

Rect = tuple[int, int, int, int]


def crop_rect(width: int, height: int, crop_box: dict | None) -> Rect:
    """Pixel rectangle ``(x0, y0, x1, y1)`` kept by ``crop_box``; None keeps everything."""
    if crop_box is None:
        return 0, 0, width, height
    left = int(width * crop_box["left"] / 100)
    right = int(width * crop_box["right"] / 100)
    top = int(height * crop_box["top"] / 100)
    bottom = int(height * crop_box["bottom"] / 100)
    return left, top, width - right, height - bottom


def crop_frame(image: np.ndarray, crop_box: dict | None) -> np.ndarray:
    height, width = image.shape[:2]
    x0, y0, x1, y1 = crop_rect(width, height, crop_box)
    return image[y0:y1, x0:x1]


def remap_point(x: float, y: float, rect: Rect, width: int, height: int) -> tuple[float, float]:
    """Crop-normalised point to full-frame-normalised, using the real pixel rectangle."""
    x0, y0, x1, y1 = rect
    return (x0 + x * (x1 - x0)) / width, (y0 + y * (y1 - y0)) / height


def remap_bbox(bbox: list[float], rect: Rect, width: int, height: int) -> list[float]:
    """``[x, y, w, h]`` crop-normalised to the same in full-frame-normalised coordinates."""
    x0, y0, x1, y1 = rect
    x, y = remap_point(bbox[0], bbox[1], rect, width, height)
    return [x, y, bbox[2] * (x1 - x0) / width, bbox[3] * (y1 - y0) / height]
