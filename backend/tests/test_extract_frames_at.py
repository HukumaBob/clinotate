import tempfile

import cv2
import numpy as np
import pytest

from app.media.service import FramesOutOfRange, extract_frames_at


def make_video(frames: int = 20, fps: int = 10, size=(64, 48)) -> bytes:
    """Frame i is a flat gray of value i * 10, so a frame's content names its number."""
    with tempfile.NamedTemporaryFile(suffix=".avi") as tmp:
        writer = cv2.VideoWriter(tmp.name, cv2.VideoWriter_fourcc(*"MJPG"), fps, size)
        for i in range(frames):
            writer.write(np.full((size[1], size[0], 3), i * 10, dtype=np.uint8))
        writer.release()
        return open(tmp.name, "rb").read()


def gray_of(png: bytes) -> float:
    return float(cv2.imdecode(np.frombuffer(png, np.uint8), cv2.IMREAD_COLOR).mean())


def test_returns_the_exact_frames_in_ascending_order():
    result = extract_frames_at(make_video(), [7, 2, 5])
    assert [index for index, *_ in result] == [2, 5, 7]
    for index, png, width, height in result:
        assert gray_of(png) == pytest.approx(index * 10, abs=6)
        assert (width, height) == (64, 48)


def test_duplicate_indices_are_returned_once():
    result = extract_frames_at(make_video(), [4, 4, 4])
    assert [index for index, *_ in result] == [4]


def test_frame_zero_and_the_last_frame_are_reachable():
    result = extract_frames_at(make_video(frames=20), [0, 19])
    assert [index for index, *_ in result] == [0, 19]


def test_an_index_past_the_end_raises_and_lists_every_such_index():
    with pytest.raises(FramesOutOfRange) as caught:
        extract_frames_at(make_video(frames=20), [3, 20, 99])
    assert caught.value.indices == [20, 99]


def test_an_empty_request_returns_nothing():
    assert extract_frames_at(make_video(), []) == []


def test_bytes_that_are_not_a_video_raise_value_error():
    with pytest.raises(ValueError, match="video"):
        extract_frames_at(b"this is not a video", [0])


def test_a_decoder_error_becomes_a_value_error(monkeypatch):
    import app.media.service as media_service

    def boom(*args, **kwargs):
        raise cv2.error("decoder exploded")

    monkeypatch.setattr(media_service.cv2, "imencode", boom)
    with pytest.raises(ValueError):
        extract_frames_at(make_video(), [3])
