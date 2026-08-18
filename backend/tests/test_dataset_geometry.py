import cv2
import numpy as np
import pytest

from app.datasets.geometry import decode_mask, extract_geometry
from app.main import app  # noqa: F401  (import registers all models on Base.metadata)


def _rect_mask(width=100, height=80, x=10, y=20, w=30, h=40):
    mask = np.zeros((height, width), dtype=np.uint8)
    mask[y : y + h, x : x + w] = 255
    return mask


def test_a_rectangular_mask_yields_its_bounding_box():
    geometry = extract_geometry(_rect_mask())
    assert geometry.bbox == (10, 20, 30, 40)


def test_area_counts_non_zero_pixels_in_the_largest_contour():
    geometry = extract_geometry(_rect_mask(w=30, h=40))
    assert geometry.area_px == 30 * 40


def test_a_mask_with_a_hole_yields_the_outer_contour():
    mask = _rect_mask(w=40, h=40)
    mask[30:40, 20:30] = 0  # punch a hole inside the rectangle
    geometry = extract_geometry(mask)
    assert geometry.bbox == (10, 20, 40, 40)
    assert len(geometry.polygon) >= 4


def test_the_polygon_stays_inside_the_bounding_box():
    geometry = extract_geometry(_rect_mask())
    x, y, w, h = geometry.bbox
    for px, py in geometry.polygon:
        assert x <= px <= x + w
        assert y <= py <= y + h


def test_an_all_zero_mask_raises_rather_than_returning_an_empty_shape():
    with pytest.raises(ValueError):
        extract_geometry(np.zeros((50, 50), dtype=np.uint8))


def test_a_single_pixel_mask_raises_due_to_insufficient_polygon_points():
    mask = np.zeros((50, 50), dtype=np.uint8)
    mask[25, 25] = 255
    with pytest.raises(ValueError, match="contour simplified to 1 points"):
        extract_geometry(mask)


def test_a_thin_line_raises_due_to_insufficient_polygon_points():
    mask = np.zeros((50, 50), dtype=np.uint8)
    mask[25, 10:20] = 255  # 1-pixel-wide horizontal line
    with pytest.raises(ValueError, match="contour simplified to 2 points"):
        extract_geometry(mask)


def test_a_2x2_blob_succeeds_with_4_point_polygon():
    mask = np.zeros((50, 50), dtype=np.uint8)
    mask[25:27, 25:27] = 255  # 2×2 blob
    geometry = extract_geometry(mask)
    assert len(geometry.polygon) == 4
    assert geometry.area_px == 4


def test_two_disjoint_blobs_area_px_reflects_the_largest_blob_only():
    mask = np.zeros((100, 100), dtype=np.uint8)
    mask[10:20, 10:20] = 255   # small blob: 10×10 = 100 pixels
    mask[50:80, 50:90] = 255   # large blob: 30×40 = 1200 pixels
    geometry = extract_geometry(mask)
    assert geometry.bbox == (50, 50, 40, 30)
    assert geometry.area_px == 1200  # area of largest blob only, not sum of both


def test_decode_mask_round_trips_a_png():
    original = _rect_mask()
    encoded = cv2.imencode(".png", original)[1].tobytes()
    decoded = decode_mask(encoded)
    assert decoded.shape == original.shape
    assert int((decoded > 0).sum()) == int((original > 0).sum())


def test_decode_mask_rejects_bytes_that_are_not_an_image():
    with pytest.raises(ValueError):
        decode_mask(b"this is not a png")
