import os
from pathlib import Path

import pytest

os.environ.setdefault("HF_TOKEN", os.environ.get("HF_TOKEN", ""))

from app.sam3_adapter import Sam3Adapter


@pytest.mark.requires_sam3_weights
def test_predict_with_point_prompt_returns_mask():
    adapter = Sam3Adapter()
    fixture_path = Path(__file__).parent / "fixtures" / "sample_frame.png"
    frame_bytes = fixture_path.read_bytes()

    result = adapter.predict(
        frame_bytes,
        prompts=[{"type": "point", "coords": [0.5, 0.5], "label": True}],
    )

    assert isinstance(result.mask_png, bytes)
    assert len(result.mask_png) > 0
    assert 0.0 <= result.score <= 1.0


@pytest.mark.requires_sam3_weights
def test_predict_with_box_prompt_returns_mask():
    adapter = Sam3Adapter()
    fixture_path = Path(__file__).parent / "fixtures" / "sample_frame.png"
    frame_bytes = fixture_path.read_bytes()

    result = adapter.predict(
        frame_bytes,
        prompts=[{"type": "box", "coords": [0.2, 0.2, 0.6, 0.6], "label": True}],
    )

    assert isinstance(result.mask_png, bytes)
    assert len(result.mask_png) > 0


def test_point_prompt_converts_to_zero_area_box():
    from app.sam3_adapter import _prompt_to_geometric_box

    box, label = _prompt_to_geometric_box({"type": "point", "coords": [0.5, 0.3], "label": True})

    assert box == [0.5, 0.3, 0.0, 0.0]
    assert label is True


def test_box_prompt_converts_corners_to_center_width_height():
    from app.sam3_adapter import _prompt_to_geometric_box

    box, label = _prompt_to_geometric_box({"type": "box", "coords": [0.2, 0.2, 0.6, 0.6], "label": False})

    assert box == pytest.approx([0.4, 0.4, 0.4, 0.4])
    assert label is False
