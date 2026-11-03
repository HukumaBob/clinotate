import numpy as np
import pytest

from app.crop import crop_frame, crop_rect, remap_bbox, remap_point


def _backend_apply_crop_shape(width, height, crop):
    """Reference copy of backend/app/media/service.py:_apply_crop's arithmetic.

    Must stay identical to it: training frames and inference frames have to be
    cut the same way."""
    left_px = int(width * crop["left"] / 100)
    right_px = int(width * crop["right"] / 100)
    top_px = int(height * crop["top"] / 100)
    bottom_px = int(height * crop["bottom"] / 100)
    return (height - bottom_px - top_px, width - right_px - left_px)


def test_crop_rect_truncates_like_the_backend_on_an_odd_frame():
    crop = {"left": 7.5, "right": 7.5, "top": 0, "bottom": 0}
    assert crop_rect(101, 75, crop) == (7, 0, 101 - 7, 75)


@pytest.mark.parametrize("crop", [None, {"left": 0, "right": 0, "top": 0, "bottom": 0}])
def test_no_crop_and_zero_crop_give_the_full_rect(crop):
    assert crop_rect(64, 48, crop) == (0, 0, 64, 48)


def test_crop_frame_cuts_the_requested_insets():
    image = np.zeros((48, 64, 3), dtype=np.uint8)
    cropped = crop_frame(image, {"left": 10, "right": 0, "top": 25, "bottom": 0})
    assert cropped.shape == (36, 58, 3)


@pytest.mark.parametrize(
    "size,crop",
    [
        ((64, 48), {"left": 10, "right": 5, "top": 25, "bottom": 2.5}),
        ((101, 75), {"left": 7.5, "right": 3.3, "top": 1.1, "bottom": 9.9}),
        ((1920, 1080), {"left": 12, "right": 18, "top": 0, "bottom": 0}),
    ],
)
def test_crop_rect_matches_the_backend_arithmetic(size, crop):
    width, height = size
    x0, y0, x1, y1 = crop_rect(width, height, crop)
    assert (y1 - y0, x1 - x0) == _backend_apply_crop_shape(width, height, crop)


def test_bbox_round_trips_from_a_cropped_frame_to_full_frame_coordinates():
    width, height = 101, 75
    crop = {"left": 7.5, "right": 3.3, "top": 1.1, "bottom": 9.9}
    full = np.zeros((height, width, 3), dtype=np.uint8)
    full[20:50, 30:70] = 255  # known object, pixels x 30..70, y 20..50
    cropped = crop_frame(full, crop)
    ys, xs = np.where(cropped[:, :, 0] == 255)
    ch, cw = cropped.shape[:2]
    bbox = [xs.min() / cw, ys.min() / ch, (xs.max() + 1 - xs.min()) / cw, (ys.max() + 1 - ys.min()) / ch]

    rect = crop_rect(width, height, crop)
    out = remap_bbox(bbox, rect, width, height)

    assert out == pytest.approx([30 / width, 20 / height, 40 / width, 30 / height], abs=1e-6)


def test_remap_point_maps_the_crop_corners_onto_the_rect_corners():
    rect = crop_rect(64, 48, {"left": 25, "right": 0, "top": 0, "bottom": 0})
    assert remap_point(0.0, 0.0, rect, 64, 48) == pytest.approx((0.25, 0.0))
    assert remap_point(1.0, 1.0, rect, 64, 48) == pytest.approx((1.0, 1.0))
