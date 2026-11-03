from pathlib import Path

import cv2
import numpy as np
import pytest

from app.classification_adapter import (
    AxisWeights,
    ClassificationRequest,
    UltralyticsClassificationAdapter,
)


def _write_video(path, frames=10, fps=10, size=(64, 48)):
    writer = cv2.VideoWriter(str(path), cv2.VideoWriter_fourcc(*"MJPG"), fps, size)
    for i in range(frames):
        writer.write(np.full((size[1], size[0], 3), i * 20, dtype=np.uint8))
    writer.release()
    return path


class _Probs:
    def __init__(self, values):
        self.data = np.array(values, dtype=float)


class _Result:
    def __init__(self, values):
        self.probs = _Probs(values)


class _FakeModel:
    def __init__(self, names, probs):
        self.names = names
        self._probs = probs
        self.calls = 0
        self.means = []
        self.shapes = []

    def __call__(self, image, verbose):
        self.calls += 1
        self.shapes.append(image.shape)
        self.means.append(float(np.mean(image)))
        return [_Result(self._probs)]


def _loader(models):
    loaded = []

    def load(path):
        loaded.append(path)
        return models[path]

    load.loaded = loaded
    return load


def _models():
    return {
        "a.pt": _FakeModel({0: "clean", 1: "dirty"}, [0.12345, 0.87655]),
        "b.pt": _FakeModel({0: "ok", 1: "blur", 2: "dark"}, [0.2, 0.1, 0.7]),
    }


def _request(video, stride=1, perturbation=None, crop_box=None):
    return ClassificationRequest(
        video_path=video,
        axes=[AxisWeights("cleanliness", Path("a.pt")), AxisWeights("sharpness", Path("b.pt"))],
        frame_stride=stride,
        perturbation=perturbation,
        crop_box=crop_box,
    )


def test_two_axes_produce_documented_shape(tmp_path):
    video = _write_video(tmp_path / "v.avi", frames=3)
    models = _models()
    result = UltralyticsClassificationAdapter(model_loader=_loader(models)).infer(
        _request(video), lambda p, t: None
    )
    assert result.fps == pytest.approx(10.0)
    assert result.axes == [
        {"name": "cleanliness", "classes": ["clean", "dirty"]},
        {"name": "sharpness", "classes": ["ok", "blur", "dark"]},
    ]
    assert sorted(result.frames) == ["0", "1", "2"]
    entry = result.frames["1"]
    assert entry["timestamp_ms"] >= 0
    assert entry["axes"] == [
        {"class_id": 1, "confidence": 0.877, "probs": [0.123, 0.877]},
        {"class_id": 2, "confidence": 0.7, "probs": [0.2, 0.1, 0.7]},
    ]


def test_stride_keeps_every_fifth_frame_and_reports_progress(tmp_path):
    video = _write_video(tmp_path / "v.avi", frames=10)
    progress = []
    result = UltralyticsClassificationAdapter(model_loader=_loader(_models())).infer(
        _request(video, stride=5), lambda p, t: progress.append((p, t))
    )
    assert sorted(result.frames, key=int) == ["0", "5"]
    assert progress == [(1, 2), (2, 2)]


def test_perturbation_applied_before_models(tmp_path):
    video = _write_video(tmp_path / "v.avi", frames=2)
    plain, perturbed = _models(), _models()
    UltralyticsClassificationAdapter(model_loader=_loader(plain)).infer(
        _request(video), lambda p, t: None
    )
    UltralyticsClassificationAdapter(model_loader=_loader(perturbed)).infer(
        _request(video, perturbation={"kind": "brightness", "strength": 50}),
        lambda p, t: None,
    )
    for key in plain:
        assert perturbed[key].means[1] > plain[key].means[1] + 30


def test_unreadable_video_raises(tmp_path):
    bad = tmp_path / "nope.avi"
    bad.write_bytes(b"not a video")
    with pytest.raises(ValueError, match="Could not open the video file"):
        UltralyticsClassificationAdapter(model_loader=_loader(_models())).infer(
            _request(bad), lambda p, t: None
        )


def test_video_without_frames_raises(tmp_path):
    video = _write_video(tmp_path / "v.avi", frames=0)
    with pytest.raises(ValueError, match="The video has no readable frames"):
        UltralyticsClassificationAdapter(model_loader=_loader(_models())).infer(
            _request(video), lambda p, t: None
        )


def test_each_model_loaded_once(tmp_path):
    video = _write_video(tmp_path / "v.avi", frames=4)
    loader = _loader(_models())
    UltralyticsClassificationAdapter(model_loader=loader).infer(_request(video), lambda p, t: None)
    assert loader.loaded == ["a.pt", "b.pt"]


def test_every_axis_model_sees_the_cropped_frame(tmp_path):
    video = _write_video(tmp_path / "v.avi", frames=2)  # 64x48
    models = _models()
    crop = {"left": 25, "right": 0, "top": 0, "bottom": 0}

    UltralyticsClassificationAdapter(model_loader=_loader(models)).infer(
        _request(video, crop_box=crop), lambda p, t: None
    )

    for model in models.values():
        assert [shape[:2] for shape in model.shapes] == [(48, 48), (48, 48)]


def test_the_perturbation_is_applied_after_the_crop(tmp_path):
    video = _write_video(tmp_path / "v.avi", frames=2)
    models = _models()
    crop = {"left": 25, "right": 0, "top": 0, "bottom": 0}

    UltralyticsClassificationAdapter(model_loader=_loader(models)).infer(
        _request(video, perturbation={"kind": "blur", "strength": 2}, crop_box=crop),
        lambda p, t: None,
    )

    # A blur keeps the shape it is given, so the model sees the cropped size.
    assert models["a.pt"].shapes[0][:2] == (48, 48)
