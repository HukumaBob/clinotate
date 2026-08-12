import io
from pathlib import Path
from unittest.mock import patch

from PIL import Image

from app.quality_adapter import QualityAdapter


def _make_frame_bytes(color: tuple[int, int, int] = (128, 128, 128)) -> bytes:
    image = Image.new("RGB", (64, 64), color=color)
    buffer = io.BytesIO()
    image.save(buffer, format="PNG")
    return buffer.getvalue()


def test_score_uses_topiq_when_pyiqa_available():
    adapter = QualityAdapter()
    fake_metric = lambda *args, **kwargs: __import__("torch").tensor([0.7])
    with patch.object(adapter, "_get_metric", return_value=fake_metric):
        score = adapter.score(_make_frame_bytes())

    assert score == 0.7


def test_score_falls_back_to_laplacian_variance_when_topiq_unavailable():
    adapter = QualityAdapter()
    with patch.object(adapter, "_get_metric", side_effect=RuntimeError("pyiqa unavailable")):
        score = adapter.score(_make_frame_bytes())

    assert isinstance(score, float)


def test_laplacian_fallback_scores_sharper_image_higher_than_blurry():
    """Lower score = worse quality (matches TOPIQ's higher-is-better polarity).
    A flat gray image has ~zero Laplacian variance (no edges, worst case);
    a checkerboard has strong edges (sharp, best case) -- so the fallback's
    inversion must rank the checkerboard as *higher* score than the flat image."""
    import numpy as np

    adapter = QualityAdapter()

    flat = Image.new("RGB", (64, 64), color=(128, 128, 128))
    flat_buffer = io.BytesIO()
    flat.save(flat_buffer, format="PNG")

    checkerboard_array = np.zeros((64, 64, 3), dtype="uint8")
    checkerboard_array[::2, ::2] = 255
    checkerboard_array[1::2, 1::2] = 255
    checkerboard = Image.fromarray(checkerboard_array)
    checkerboard_buffer = io.BytesIO()
    checkerboard.save(checkerboard_buffer, format="PNG")

    with patch.object(adapter, "_get_metric", side_effect=RuntimeError("pyiqa unavailable")):
        flat_score = adapter.score(flat_buffer.getvalue())
        checkerboard_score = adapter.score(checkerboard_buffer.getvalue())

    assert checkerboard_score > flat_score
