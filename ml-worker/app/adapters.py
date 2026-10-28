"""Registry of training adapters, keyed by the name stored on TrainingRun.adapter.

Adapters are imported lazily so that importing this module stays cheap:
torch/transformers are only loaded when a run actually asks for an adapter
that needs them.
"""

from app.training_adapter import TrainingAdapter


def get_training_adapter(name: str) -> TrainingAdapter:
    if name == "ultralytics_yolo":
        from app.ultralytics_yolo_adapter import UltralyticsYoloAdapter

        return UltralyticsYoloAdapter()
    raise ValueError(f"Unknown training adapter {name!r}")
