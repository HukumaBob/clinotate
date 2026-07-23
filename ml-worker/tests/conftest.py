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
