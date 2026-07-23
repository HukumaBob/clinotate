import os
from pathlib import Path
from unittest.mock import patch

import pytest

os.environ.setdefault("HF_TOKEN", os.environ.get("HF_TOKEN", ""))

from app.sam3_adapter import Sam3Adapter


def _gpu_lacks_flash_attention() -> bool:
    """True when the visible GPU's compute capability is < 8 (pre-Ampere),
    meaning no Flash Attention support -- PyTorch falls back to a math-only
    attention kernel that materializes the full attention matrix instead of
    a fused, memory-efficient one. Returns False (i.e. "don't skip") when no
    CUDA device is visible at all, since that case is already covered by the
    separate `requires_sam3_weights` marker.

    See .superpowers/sdd/task-7-report.md and its two follow-ups
    (task-7-fix-report.md, task-7-fix2-report.md) for the full investigation:
    on this class of GPU, SAM-3's video predictor's hardcoded 1008x1008
    internal resolution drives per-layer attention-matrix memory (measured at
    ~0.8 GiB/layer in fp16 alone, across dozens of backbone layers) past
    available VRAM, and six separate VRAM-reduction avenues were tried and
    conclusively ruled out with real GPU evidence. This is a confirmed
    hardware ceiling, not a code defect in `Sam3Adapter.track()`.
    """
    try:
        import torch
    except ImportError:
        return False
    if not torch.cuda.is_available():
        return False
    major, _minor = torch.cuda.get_device_capability(0)
    return major < 8


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


@pytest.mark.requires_sam3_weights
@pytest.mark.skipif(
    _gpu_lacks_flash_attention(),
    reason=(
        "Confirmed hardware VRAM ceiling on GPUs without Flash Attention "
        "support (compute capability < 8 / pre-Ampere) combined with SAM-3's "
        "video predictor's hardcoded 1008x1008 internal resolution -- not a "
        "code defect. See .superpowers/sdd/task-7-report.md and its two "
        "follow-ups (task-7-fix-report.md, task-7-fix2-report.md) for the "
        "full investigation. Will re-run automatically on a future GPU with "
        "compute capability >= 8."
    ),
)
def test_track_propagates_prompt_across_frames():
    adapter = Sam3Adapter()
    fixture_path = Path(__file__).parent / "fixtures" / "sample_frame.png"
    frame_bytes = fixture_path.read_bytes()
    frames = [frame_bytes, frame_bytes, frame_bytes]  # 3 identical frames is enough to prove propagation runs

    results = adapter.track(
        frames,
        prompts=[{"type": "point", "coords": [0.5, 0.5], "label": True}],
    )

    assert len(results) == 3
    for result in results:
        assert isinstance(result.mask_png, bytes)
        assert len(result.mask_png) > 0


def test_video_predictor_defaults_to_sam3_version():
    """Sam3Adapter() with no argument must keep requesting the "sam3"
    checkpoint -- this is an additive parameter, not a behavior change for
    existing callers (see task-7-fix-report.md, Task B)."""
    with patch("app.sam3_adapter.build_sam3_predictor") as mock_builder:
        adapter = Sam3Adapter()
        adapter._get_video_predictor()

    mock_builder.assert_called_once_with(version="sam3")


def test_video_predictor_threads_sam3_1_version_through():
    """Passing video_predictor_version="sam3.1" must reach
    build_sam3_predictor(version="sam3.1") -- sam3's own explicit
    version-dispatch entry point (model_builder.py:1243-1287), confirmed to
    return the same handle_request/handle_stream_request API for both
    versions."""
    with patch("app.sam3_adapter.build_sam3_predictor") as mock_builder:
        adapter = Sam3Adapter(video_predictor_version="sam3.1")
        adapter._get_video_predictor()

    mock_builder.assert_called_once_with(version="sam3.1")


def test_get_video_predictor_evicts_already_loaded_processor():
    """Regression test for the memory-lifecycle bug documented in
    .superpowers/sdd/predict-flakiness-report.md: this adapter is reused as
    a module-level singleton across every task in a worker process
    (app/tasks.py's `_adapter_singleton`), and the image model + video
    predictor cannot coexist in this GPU's VRAM budget (see __init__'s
    docstring). Building the video predictor while the image
    model/processor is already loaded must release it first (and call
    torch.cuda.empty_cache()) rather than leaving both resident, which is
    exactly what caused jobs #84/#85 to OOM requesting a mere 12 MiB."""
    with (
        patch("app.sam3_adapter.build_sam3_image_model") as mock_image_builder,
        patch("app.sam3_adapter.Sam3Processor") as mock_processor_cls,
        patch("app.sam3_adapter.build_sam3_predictor") as mock_video_builder,
        patch("app.sam3_adapter.torch.cuda.empty_cache") as mock_empty_cache,
    ):
        adapter = Sam3Adapter()
        adapter._get_processor()
        assert adapter._processor is not None
        assert adapter._model is not None

        adapter._get_video_predictor()

    assert adapter._processor is None, "image processor must be released once the video predictor is requested"
    assert adapter._model is None, "image model must be released once the video predictor is requested"
    assert adapter._video_predictor is mock_video_builder.return_value
    mock_empty_cache.assert_called_once()


def test_get_processor_evicts_already_loaded_video_predictor():
    """Mirror of test_get_video_predictor_evicts_already_loaded_processor:
    the eviction must work in both directions, since either predict() or
    track() can be called first on a long-lived singleton."""
    with (
        patch("app.sam3_adapter.build_sam3_predictor") as mock_video_builder,
        patch("app.sam3_adapter.build_sam3_image_model") as mock_image_builder,
        patch("app.sam3_adapter.Sam3Processor") as mock_processor_cls,
        patch("app.sam3_adapter.torch.cuda.empty_cache") as mock_empty_cache,
    ):
        adapter = Sam3Adapter()
        adapter._get_video_predictor()
        assert adapter._video_predictor is not None

        adapter._get_processor()

    assert adapter._video_predictor is None, "video predictor must be released once the image processor is requested"
    assert adapter._processor is mock_processor_cls.return_value
    mock_empty_cache.assert_called_once()


def test_get_processor_does_not_evict_when_already_loaded():
    """Calling _get_processor() twice in a row (the common case: repeated
    predict() calls with no intervening track()) must reuse the cached
    processor without releasing anything -- eviction should only happen
    when switching from one model to the other, not on every call."""
    with (
        patch("app.sam3_adapter.build_sam3_image_model") as mock_image_builder,
        patch("app.sam3_adapter.Sam3Processor") as mock_processor_cls,
        patch("app.sam3_adapter.torch.cuda.empty_cache") as mock_empty_cache,
    ):
        adapter = Sam3Adapter()
        first = adapter._get_processor()
        second = adapter._get_processor()

    assert first is second
    mock_image_builder.assert_called_once()
    mock_empty_cache.assert_not_called()


def test_predict_clears_cuda_cache_on_error_without_swallowing_exception():
    """Regression test for the second half of the memory-lifecycle bug in
    .superpowers/sdd/predict-flakiness-report.md: a CUDA OOM (or any other
    exception) raised during set_image/add_geometric_prompt -- i.e. during
    actual inference, not just model construction -- must still trigger
    torch.cuda.empty_cache() before propagating, and the original exception
    must not be swallowed. Confirmed necessary by a real production
    reproduction: a track() call that OOM'd inside add_prompt (a known,
    pre-existing hardware ceiling, not a new defect -- see
    task-7-fix2-report.md) left ~6.3 GiB resident even after the task
    finished, and the very next predict() call on the same, correctly
    single-model adapter OOM'd too, purely from that leftover
    fragmentation."""
    from PIL import Image

    fake_image = Image.new("RGB", (4, 4))
    buffer_bytes = io_bytes(fake_image)

    with (
        patch("app.sam3_adapter.build_sam3_image_model"),
        patch("app.sam3_adapter.Sam3Processor") as mock_processor_cls,
        patch("app.sam3_adapter.torch.cuda.empty_cache") as mock_empty_cache,
    ):
        mock_processor_cls.return_value.set_image.side_effect = RuntimeError("CUDA out of memory")
        adapter = Sam3Adapter()

        with pytest.raises(RuntimeError, match="CUDA out of memory"):
            adapter.predict(buffer_bytes, prompts=[{"type": "point", "coords": [0.5, 0.5], "label": True}])

    mock_empty_cache.assert_called_once()


def io_bytes(image) -> bytes:
    import io

    buffer = io.BytesIO()
    image.save(buffer, format="PNG")
    return buffer.getvalue()


def test_get_processor_releases_partial_state_on_build_failure():
    """If build_sam3_image_model() raises partway through (e.g. a real
    torch.OutOfMemoryError from an internal .to(device) call), the adapter
    must not be left holding a half-built processor, and must clear the
    CUDA cache so a failed build doesn't leave fragmented/unreturned
    allocations for the next call -- see predict-flakiness-report.md for
    the confirmed production mechanism this guards against."""
    with (
        patch("app.sam3_adapter.build_sam3_image_model", side_effect=RuntimeError("boom")),
        patch("app.sam3_adapter.torch.cuda.empty_cache") as mock_empty_cache,
    ):
        adapter = Sam3Adapter()
        with pytest.raises(RuntimeError, match="boom"):
            adapter._get_processor()

    assert adapter._processor is None
    assert adapter._model is None
    mock_empty_cache.assert_called_once()
