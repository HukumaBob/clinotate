import pytest

from app import adapters


def test_unknown_adapter_name_raises():
    with pytest.raises(ValueError, match="Unknown training adapter 'nope'"):
        adapters.get_training_adapter("nope")


def test_yolo_name_returns_ultralytics_adapter(monkeypatch):
    import app.ultralytics_yolo_adapter as module

    class _Fake:
        pass

    monkeypatch.setattr(module, "UltralyticsYoloAdapter", _Fake)
    assert isinstance(adapters.get_training_adapter("ultralytics_yolo"), _Fake)
