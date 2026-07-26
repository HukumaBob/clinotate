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
    ], image_width=1000, image_height=1000)

    assert kwargs["point_coords"].tolist() == [[500.0, 300.0], [200.0, 100.0]]
    assert kwargs["point_labels"].tolist() == [1, 0]
    assert "box" not in kwargs
    assert "mask_input" not in kwargs


def test_point_prompts_denormalize_using_actual_image_dimensions():
    """Regression test for the double-normalization bug: this platform's
    prompt coords are always [0,1]-normalized, but SAM2ImagePredictor.predict()
    defaults to normalize_coords=True, which itself expects PIXEL coordinates
    and normalizes them internally (see SAM2Transforms.transform_coords).
    Passing already-normalized [0,1] coords through unchanged causes every
    click to collapse toward (0,0) regardless of actual click location --
    confirmed against the real installed sam2 source. The fix is to convert
    [0,1] -> pixel space here, using the real (non-square) frame dimensions."""
    from app.sam2_adapter import _prompts_to_predict_kwargs

    kwargs = _prompts_to_predict_kwargs([
        {"type": "point", "coords": [0.5, 0.5], "label": True},
    ], image_width=800, image_height=400)

    assert kwargs["point_coords"].tolist() == [[400.0, 200.0]]


def test_box_prompt_converts_to_box_kwarg():
    from app.sam2_adapter import _prompts_to_predict_kwargs

    kwargs = _prompts_to_predict_kwargs([
        {"type": "box", "coords": [0.1, 0.1, 0.4, 0.4], "label": True},
    ], image_width=1000, image_height=500)

    assert kwargs["box"].tolist() == [100.0, 50.0, 400.0, 200.0]
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

    kwargs = _prompts_to_predict_kwargs(
        [{"type": "mask", "mask_png": mask_b64}], image_width=100, image_height=100
    )

    assert kwargs["mask_input"].shape == (1, 256, 256)
    assert (kwargs["mask_input"] == 32.0).all()


def test_unknown_prompt_type_raises():
    from app.sam2_adapter import _prompts_to_predict_kwargs

    with pytest.raises(ValueError, match="Unknown prompt type"):
        _prompts_to_predict_kwargs([{"type": "exemplar", "coords": []}], image_width=100, image_height=100)


def test_prompts_to_predict_kwargs_rejects_empty_list():
    from app.sam2_adapter import _prompts_to_predict_kwargs

    with pytest.raises(ValueError, match="at least one prompt"):
        _prompts_to_predict_kwargs([], image_width=100, image_height=100)


def test_track_rejects_empty_prompts_list():
    from app.sam2_adapter import Sam2Adapter

    adapter = Sam2Adapter()
    with pytest.raises(ValueError, match="at least one prompt"):
        adapter.track(
            [b"frame0"],
            prompts=[],
            anchor_frame_index=0,
            backward=0,
            forward=0,
        )


def test_frames_to_video_dir_writes_real_jpeg_files():
    """Regression test: SAM2VideoPredictor.init_state() ->
    load_video_frames_from_jpg_images() only scans for *.jpg/*.jpeg files
    and silently ignores anything else (confirmed against the installed
    sam2 source) -- so frames written under a .png extension (or any
    non-JPEG bytes under a .jpg name) are invisible to it or fail to
    decode. _frames_to_video_dir must re-encode this platform's PNG frame
    bytes into real JPEG files."""
    import io
    import tempfile

    from PIL import Image

    from app.sam2_adapter import Sam2Adapter

    frame = Image.new("RGB", (20, 10), color="blue")
    buffer = io.BytesIO()
    frame.save(buffer, format="PNG")
    png_bytes = buffer.getvalue()

    adapter = Sam2Adapter()
    with tempfile.TemporaryDirectory() as tmp_dir:
        adapter._frames_to_video_dir([png_bytes, png_bytes], tmp_dir)

        written = sorted(Path(tmp_dir).iterdir())
        assert [p.name for p in written] == ["00000.jpg", "00001.jpg"]
        for path in written:
            reopened = Image.open(path)
            assert reopened.format == "JPEG"
            assert reopened.size == (20, 10)


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
    import io

    import torch
    from PIL import Image

    frame = Image.new("RGB", (10, 10), color="black")
    buffer = io.BytesIO()
    frame.save(buffer, format="PNG")
    frame_bytes = buffer.getvalue()

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
                [frame_bytes, frame_bytes, frame_bytes],
                prompts=[{"type": "point", "coords": [0.5, 0.5], "label": True}],
                anchor_frame_index=1,
                backward=0,
                forward=1,
            )

    calls = mock_predictor.propagate_in_video.call_args_list
    assert len(calls) == 1
    assert calls[0].kwargs["reverse"] is False


def test_track_denormalizes_point_prompt_to_pixel_coords():
    """Regression test for the same double-normalization bug as
    predict(): SAM2VideoPredictor.add_new_points_or_box() also defaults to
    normalize_coords=True and expects pixel coordinates (confirmed by
    reading the real installed sam2 source), so track() must convert this
    platform's [0,1]-normalized point coords to pixel space -- using the
    real frame dimensions -- before calling it."""
    import io

    import torch
    from PIL import Image

    frame = Image.new("RGB", (800, 400), color="black")
    buffer = io.BytesIO()
    frame.save(buffer, format="PNG")
    frame_bytes = buffer.getvalue()

    with (
        patch("app.sam2_adapter.SAM2VideoPredictor") as mock_predictor_cls,
        patch("app.sam2_adapter.tempfile.TemporaryDirectory"),
    ):
        mock_predictor = mock_predictor_cls.from_pretrained.return_value
        mock_predictor.init_state.return_value = {"num_frames": 1}
        mock_predictor.propagate_in_video.return_value = iter([
            (0, [1], torch.zeros((1, 1, 2, 2))),
        ])

        adapter = Sam2Adapter()
        with patch.object(adapter, "_frames_to_video_dir", return_value="/tmp/fake"):
            adapter.track(
                [frame_bytes],
                prompts=[{"type": "point", "coords": [0.5, 0.5], "label": True}],
                anchor_frame_index=0,
                backward=0,
                forward=1,
            )

    add_call = mock_predictor.add_new_points_or_box.call_args
    assert add_call.kwargs["points"] == [[400.0, 200.0]]


def test_track_denormalizes_box_prompt_to_pixel_coords():
    import io

    import torch
    from PIL import Image

    frame = Image.new("RGB", (800, 400), color="black")
    buffer = io.BytesIO()
    frame.save(buffer, format="PNG")
    frame_bytes = buffer.getvalue()

    with (
        patch("app.sam2_adapter.SAM2VideoPredictor") as mock_predictor_cls,
        patch("app.sam2_adapter.tempfile.TemporaryDirectory"),
    ):
        mock_predictor = mock_predictor_cls.from_pretrained.return_value
        mock_predictor.init_state.return_value = {"num_frames": 1}
        mock_predictor.propagate_in_video.return_value = iter([
            (0, [1], torch.zeros((1, 1, 2, 2))),
        ])

        adapter = Sam2Adapter()
        with patch.object(adapter, "_frames_to_video_dir", return_value="/tmp/fake"):
            adapter.track(
                [frame_bytes],
                prompts=[{"type": "box", "coords": [0.1, 0.1, 0.4, 0.4], "label": True}],
                anchor_frame_index=0,
                backward=0,
                forward=1,
            )

    add_call = mock_predictor.add_new_points_or_box.call_args
    assert add_call.kwargs["box"].tolist() == [80.0, 40.0, 320.0, 160.0]


def test_track_combines_all_point_prompts_in_a_single_call():
    """Regression test: track() previously only used prompts[0], silently
    dropping every refinement point after the first -- so a positive point
    plus a negative point meant to narrow the mask before tracking would
    submit ONLY the positive point, producing a much-too-broad tracked
    mask (this is the real bug: a user submits [positive, negative], sees
    a good draft mask on the anchor frame, hits Track, and gets a mask
    that ignores the negative point entirely). add_new_points_or_box()
    accepts points/labels as lists in a single call, so all point prompts
    must be collected and passed together, not just the first."""
    import io

    import torch
    from PIL import Image

    frame = Image.new("RGB", (800, 400), color="black")
    buffer = io.BytesIO()
    frame.save(buffer, format="PNG")
    frame_bytes = buffer.getvalue()

    with (
        patch("app.sam2_adapter.SAM2VideoPredictor") as mock_predictor_cls,
        patch("app.sam2_adapter.tempfile.TemporaryDirectory"),
    ):
        mock_predictor = mock_predictor_cls.from_pretrained.return_value
        mock_predictor.init_state.return_value = {"num_frames": 1}
        mock_predictor.propagate_in_video.return_value = iter([
            (0, [1], torch.zeros((1, 1, 2, 2))),
        ])

        adapter = Sam2Adapter()
        with patch.object(adapter, "_frames_to_video_dir", return_value="/tmp/fake"):
            adapter.track(
                [frame_bytes],
                prompts=[
                    {"type": "point", "coords": [0.5, 0.5], "label": True},
                    {"type": "point", "coords": [0.9, 0.1], "label": False},
                ],
                anchor_frame_index=0,
                backward=0,
                forward=1,
            )

    assert mock_predictor.add_new_points_or_box.call_count == 1
    add_call = mock_predictor.add_new_points_or_box.call_args
    assert add_call.kwargs["points"] == [[400.0, 200.0], [720.0, 40.0]]
    assert add_call.kwargs["labels"] == [1, 0]
