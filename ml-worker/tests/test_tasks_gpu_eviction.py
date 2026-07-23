from unittest.mock import MagicMock, patch

import app.tasks as tasks_module


def test_evict_sam3_models_releases_processor_and_video_predictor():
    fake_sam3_adapter = MagicMock()

    with patch.object(tasks_module, "_get_default_sam3_adapter", return_value=fake_sam3_adapter):
        tasks_module._evict_sam3_models()

    fake_sam3_adapter._release_processor.assert_called_once()
    fake_sam3_adapter._release_video_predictor.assert_called_once()


def test_evict_sam2_models_releases_image_and_video_predictor():
    fake_sam2_adapter = MagicMock()

    with patch.object(tasks_module, "_get_default_sam2_adapter", return_value=fake_sam2_adapter):
        tasks_module._evict_sam2_models()

    fake_sam2_adapter._release_image_predictor.assert_called_once()
    fake_sam2_adapter._release_video_predictor.assert_called_once()


def test_get_default_sam3_adapter_returns_cached_singleton():
    first = tasks_module._get_default_sam3_adapter()
    second = tasks_module._get_default_sam3_adapter()

    assert first is second


def test_get_default_sam2_adapter_returns_cached_singleton():
    first = tasks_module._get_default_sam2_adapter()
    second = tasks_module._get_default_sam2_adapter()

    assert first is second
