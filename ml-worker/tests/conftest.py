import os

import pytest


def pytest_collection_modifyitems(config, items):
    if os.environ.get("SAM3_WEIGHTS_AVAILABLE") == "1":
        return
    skip_gpu = pytest.mark.skip(
        reason="SAM3_WEIGHTS_AVAILABLE=1 not set — skipping tests that need real SAM-3 weights/GPU"
    )
    for item in items:
        if "requires_sam3_weights" in item.keywords:
            item.add_marker(skip_gpu)


@pytest.fixture(autouse=True)
def _release_cuda_memory_after_test():
    """Frees CUDA memory after every test so GPU tests that each build their
    own `Sam3Adapter()` don't cascade-OOM against a previous test's still-resident
    model. `torch` is only installed inside the ml-worker Docker image, so the
    import is done lazily and skipped entirely when unavailable (e.g. host env
    running the two non-GPU conversion tests without the full ML dependencies)."""
    yield
    try:
        import gc

        import torch
    except ImportError:
        return
    gc.collect()
    if torch.cuda.is_available():
        torch.cuda.empty_cache()
