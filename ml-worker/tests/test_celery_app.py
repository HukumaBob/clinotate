from unittest.mock import patch


def test_set_per_process_memory_fraction_called_on_import_when_cuda_available():
    """celery_app.py must cap this process's VRAM usage at import time, so
    that even a first task can never grow past the fraction -- see
    docs/superpowers/specs/2026-08-08-sam2-gpu-oom-host-crash-design.md.
    Reload the module under mocks so the assertion doesn't depend on
    whether it was already imported earlier in the test session."""
    import importlib

    import app.celery_app as celery_app_module

    with (
        patch("torch.cuda.is_available", return_value=True),
        patch("torch.cuda.set_per_process_memory_fraction") as mock_set_fraction,
    ):
        importlib.reload(celery_app_module)

    mock_set_fraction.assert_called_once_with(0.8)

    # Restore the module to its normal (non-mocked) state for later tests.
    importlib.reload(celery_app_module)


def test_set_per_process_memory_fraction_skipped_when_cuda_unavailable():
    """On a host with no GPU (e.g. CI running only the non-GPU unit tests),
    importing celery_app.py must not raise."""
    import importlib

    import app.celery_app as celery_app_module

    with (
        patch("torch.cuda.is_available", return_value=False),
        patch("torch.cuda.set_per_process_memory_fraction") as mock_set_fraction,
    ):
        importlib.reload(celery_app_module)

    mock_set_fraction.assert_not_called()

    importlib.reload(celery_app_module)
