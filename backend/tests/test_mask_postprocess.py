import numpy as np
import pytest

from app.annotation.mask_postprocess import postprocess_mask


def _mask_with_speckle() -> np.ndarray:
    """200x200 mask: a 60x60 solid square plus an isolated 2x2 speckle
    30px away from the square, disconnected from it."""
    mask = np.zeros((200, 200), dtype=bool)
    mask[50:110, 50:110] = True
    mask[20:22, 20:22] = True
    return mask


def _mask_with_hole() -> np.ndarray:
    """200x200 solid 80x80 square with a 4x4 hole punched in the middle."""
    mask = np.zeros((200, 200), dtype=bool)
    mask[50:130, 50:130] = True
    mask[88:92, 88:92] = False
    return mask


def test_strength_zero_is_byte_identity():
    mask = _mask_with_speckle()
    result = postprocess_mask(mask, 0.0)
    assert np.array_equal(result, mask)


def test_speckle_removed_by_opening_and_largest_component():
    mask = _mask_with_speckle()
    result = postprocess_mask(mask, 0.5)
    # The speckle's pixels are gone; the main square survives.
    assert not result[20:22, 20:22].any()
    assert result[70:90, 70:90].all()


def test_hole_closed():
    mask = _mask_with_hole()
    result = postprocess_mask(mask, 0.5)
    assert result[88:92, 88:92].all()


def test_contour_smoothing_reduces_perimeter_to_area_ratio():
    import cv2

    # A jagged mask: a square with alternating notches cut into its border.
    mask = np.zeros((200, 200), dtype=bool)
    mask[40:160, 40:160] = True
    for i in range(40, 160, 6):
        mask[i : i + 3, 40:46] = False  # notch the left edge repeatedly

    def perimeter_to_area(m: np.ndarray) -> float:
        contours, _ = cv2.findContours(
            m.astype(np.uint8) * 255, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_NONE
        )
        largest = max(contours, key=cv2.contourArea)
        perimeter = cv2.arcLength(largest, True)
        area = cv2.contourArea(largest)
        return perimeter / area

    before = perimeter_to_area(mask)
    after = perimeter_to_area(postprocess_mask(mask, 1.0))
    assert after < before


def test_empty_mask_after_processing_stays_empty():
    # A single isolated 1px dot: opening erodes it away entirely at high strength.
    mask = np.zeros((200, 200), dtype=bool)
    mask[100, 100] = True
    result = postprocess_mask(mask, 1.0)
    assert not result.any()


@pytest.mark.parametrize("bad_strength", [-0.1, 1.1, 2.0, -5.0])
def test_out_of_range_strength_raises(bad_strength):
    mask = _mask_with_speckle()
    with pytest.raises(ValueError, match="strength"):
        postprocess_mask(mask, bad_strength)
