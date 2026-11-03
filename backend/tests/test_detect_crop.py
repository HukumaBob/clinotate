"""detect_crop: a working area from temporal pixel variance."""

import tempfile

import cv2
import numpy as np
import pytest

import app.main  # noqa: F401 -- registers every model on Base.metadata
from app.media.schemas import CropBox
from app.media.service import detect_crop

WIDTH, HEIGHT = 128, 96


def make_bordered_video(
    frames: int = 30,
    left_px: int = 26,
    right_px: int = 13,
    text_in_border: bool = False,
    live_everywhere: bool = False,
    static: bool = False,
) -> bytes:
    """A live (per-frame random) region inside a static black border."""
    rng = np.random.default_rng(0)
    # A smooth static picture: pure noise would not re-encode identically.
    ramp = np.linspace(40, 200, WIDTH, dtype=np.uint8)
    still = np.tile(ramp, (HEIGHT, 1))[:, :, None].repeat(3, axis=2)
    with tempfile.NamedTemporaryFile(suffix=".avi") as tmp:
        writer = cv2.VideoWriter(tmp.name, cv2.VideoWriter_fourcc(*"MJPG"), 10, (WIDTH, HEIGHT))
        for _ in range(frames):
            live = still if static else rng.integers(0, 256, (HEIGHT, WIDTH, 3), dtype=np.uint8)
            frame = live.copy()
            if not live_everywhere:
                frame[:, :left_px] = 0
                frame[:, WIDTH - right_px :] = 0
                if text_in_border:
                    frame[10:30, 4:20] = 255  # static bright "overlay"
            writer.write(frame)
        writer.release()
        return open(tmp.name, "rb").read()


def test_a_static_black_border_around_a_live_region_is_found():
    crop = detect_crop(make_bordered_video())

    assert crop is not None
    assert crop.left == pytest.approx(26 / WIDTH * 100, abs=2)
    assert crop.right == pytest.approx(13 / WIDTH * 100, abs=2)
    assert crop.top == pytest.approx(0, abs=2)
    assert crop.bottom == pytest.approx(0, abs=2)


def test_the_margin_only_ever_loosens_the_area():
    crop = detect_crop(make_bordered_video())

    assert crop.left <= 26 / WIDTH * 100 + 0.01
    assert crop.right <= 13 / WIDTH * 100 + 0.01


def test_static_bright_text_in_the_border_does_not_widen_the_area():
    plain = detect_crop(make_bordered_video())
    texty = detect_crop(make_bordered_video(text_in_border=True))

    assert texty is not None
    assert texty.left == pytest.approx(plain.left, abs=1)


def test_a_video_with_no_border_gives_no_crop():
    assert detect_crop(make_bordered_video(live_everywhere=True)) is None


def test_a_fully_static_video_gives_no_crop():
    assert detect_crop(make_bordered_video(static=True)) is None


def test_a_video_too_short_to_decide_gives_no_crop():
    assert detect_crop(make_bordered_video(frames=3)) is None


def test_the_result_is_a_valid_crop_box():
    crop = detect_crop(make_bordered_video())

    assert isinstance(crop, CropBox)
    assert crop.left + crop.right < 100 and crop.top + crop.bottom < 100


def test_unreadable_bytes_raise_value_error():
    with pytest.raises(ValueError, match="Could not open"):
        detect_crop(b"not a video")
