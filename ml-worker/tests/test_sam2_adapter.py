import os
from pathlib import Path
from unittest.mock import patch

import pytest

os.environ.setdefault("HF_TOKEN", os.environ.get("HF_TOKEN", ""))

from app.sam2_adapter import Sam2Adapter


@pytest.mark.requires_sam2_weights
def test_predict_with_point_prompt_returns_mask():
    adapter = Sam2Adapter()
    fixture_path = Path(__file__).parent / "fixtures" / "sample_frame.png"
    frame_bytes = fixture_path.read_bytes()

    result = adapter.predict(
        frame_bytes,
        prompts=[{"type": "point", "coords": [0.5, 0.5], "label": True}],
    )

    assert isinstance(result.mask_png, bytes)
    assert len(result.mask_png) > 0
    assert 0.0 <= result.score <= 1.0


def test_point_prompts_convert_to_point_coords_and_labels():
    from app.sam2_adapter import _prompts_to_predict_kwargs

    kwargs = _prompts_to_predict_kwargs([
        {"type": "point", "coords": [0.5, 0.3], "label": True},
        {"type": "point", "coords": [0.2, 0.1], "label": False},
    ])

    assert kwargs["point_coords"].tolist() == [[0.5, 0.3], [0.2, 0.1]]
    assert kwargs["point_labels"].tolist() == [1, 0]
    assert "box" not in kwargs
    assert "mask_input" not in kwargs


def test_box_prompt_converts_to_box_kwarg():
    from app.sam2_adapter import _prompts_to_predict_kwargs

    kwargs = _prompts_to_predict_kwargs([
        {"type": "box", "coords": [0.1, 0.1, 0.4, 0.4], "label": True},
    ])

    assert kwargs["box"].tolist() == [0.1, 0.1, 0.4, 0.4]
    assert "point_coords" not in kwargs


def test_mask_prompt_converts_to_256x256_logits():
    import base64
    import io

    from PIL import Image

    from app.sam2_adapter import _prompts_to_predict_kwargs

    small_mask = Image.new("L", (64, 64), color=255)
    buffer = io.BytesIO()
    small_mask.save(buffer, format="PNG")
    mask_b64 = base64.b64encode(buffer.getvalue()).decode()

    kwargs = _prompts_to_predict_kwargs([{"type": "mask", "mask_png": mask_b64}])

    assert kwargs["mask_input"].shape == (1, 256, 256)
    assert (kwargs["mask_input"] == 32.0).all()


def test_unknown_prompt_type_raises():
    from app.sam2_adapter import _prompts_to_predict_kwargs

    with pytest.raises(ValueError, match="Unknown prompt type"):
        _prompts_to_predict_kwargs([{"type": "exemplar", "coords": []}])


@pytest.mark.requires_sam2_weights
def test_track_propagates_bidirectionally_from_anchor():
    adapter = Sam2Adapter()
    fixture_path = Path(__file__).parent / "fixtures" / "sample_frame.png"
    frame_bytes = fixture_path.read_bytes()
    frames = [frame_bytes] * 5  # 5 identical frames; anchor at index 2

    results = adapter.track(
        frames,
        prompts=[{"type": "point", "coords": [0.5, 0.5], "label": True}],
        anchor_frame_index=2,
        backward=1,
        forward=1,
    )

    # anchor (2) + 1 backward (1) + 1 forward (3) = 3 frames tracked
    assert len(results) == 3
    for result in results:
        assert isinstance(result.mask_png, bytes)
        assert len(result.mask_png) > 0


def test_track_skips_direction_with_zero_count():
    """Regression test for the UI spec's '0 in either field means don't
    track that direction' rule -- track() must not call propagate_in_video
    for a direction whose count is 0."""
    import torch

    with (
        patch("app.sam2_adapter.SAM2VideoPredictor") as mock_predictor_cls,
        patch("app.sam2_adapter.tempfile.TemporaryDirectory"),
    ):
        mock_predictor = mock_predictor_cls.from_pretrained.return_value
        mock_predictor.init_state.return_value = {"num_frames": 3}
        # video_res_masks is a real (tiny) tensor here rather than a mock,
        # because track() does video_res_masks[0, 0].cpu().numpy() > 0 on
        # it -- a bare mock object doesn't support numeric comparisons and
        # would blow up before the assertions below ever run.
        mock_predictor.propagate_in_video.return_value = iter([
            (1, [1], torch.zeros((1, 1, 2, 2))),
        ])

        adapter = Sam2Adapter()
        with patch.object(adapter, "_frames_to_video_dir", return_value="/tmp/fake"):
            adapter.track(
                [b"frame0", b"frame1", b"frame2"],
                prompts=[{"type": "point", "coords": [0.5, 0.5], "label": True}],
                anchor_frame_index=1,
                backward=0,
                forward=1,
            )

    calls = mock_predictor.propagate_in_video.call_args_list
    assert len(calls) == 1
    assert calls[0].kwargs["reverse"] is False
