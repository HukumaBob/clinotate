import cv2
import numpy as np
import pytest

from app.inference_adapter import InferenceRequest
from app.ultralytics_inference_adapter import UltralyticsInferenceAdapter


def _write_video(path, frames=10, fps=10, size=(64, 48)):
    writer = cv2.VideoWriter(str(path), cv2.VideoWriter_fourcc(*"MJPG"), fps, size)
    for i in range(frames):
        writer.write(np.full((size[1], size[0], 3), i * 20, dtype=np.uint8))
    writer.release()
    return path


class _Boxes:
    def __init__(self, xyxyn, conf, cls):
        self.xyxyn = np.array(xyxyn, dtype=float).reshape(-1, 4)
        self.conf = np.array(conf, dtype=float)
        self.cls = np.array(cls, dtype=float)

    def __len__(self):
        return len(self.conf)


class _Masks:
    def __init__(self, xyn):
        self.xyn = [np.array(polygon, dtype=float) for polygon in xyn]


class _Result:
    def __init__(self, boxes=None, masks=None):
        self.boxes = boxes
        self.masks = masks


class _FakeModel:
    names = {0: "polyp", 1: "fold"}

    def __init__(self, results_by_call=None):
        self.results_by_call = results_by_call or {}
        self.calls = 0
        self.conf_seen = None

    def __call__(self, image, conf, verbose):
        self.conf_seen = conf
        result = self.results_by_call.get(self.calls, _Result(boxes=_Boxes([], [], [])))
        self.calls += 1
        return [result]


def _adapter(model):
    return UltralyticsInferenceAdapter(model_loader=lambda path: model)


def _request(video, stride=1, task_type="detection"):
    return InferenceRequest(
        video_path=video,
        weights_path=video.parent / "w.pt",
        task_type=task_type,
        frame_stride=stride,
    )


def test_stride_one_processes_every_frame(tmp_path):
    video = _write_video(tmp_path / "v.avi", frames=10)
    result = _adapter(_FakeModel()).infer(_request(video, 1), lambda done, total: None)
    assert list(result.frames) == [str(i) for i in range(10)]
    assert result.classes == ["polyp", "fold"]
    assert result.task_type == "detection"


def test_stride_five_processes_frames_zero_and_five(tmp_path):
    video = _write_video(tmp_path / "v.avi", frames=10)
    result = _adapter(_FakeModel()).infer(_request(video, 5), lambda done, total: None)
    assert list(result.frames) == ["0", "5"]


def test_a_stride_longer_than_the_video_still_processes_frame_zero(tmp_path):
    video = _write_video(tmp_path / "v.avi", frames=10)
    result = _adapter(_FakeModel()).infer(_request(video, 1000), lambda done, total: None)
    assert list(result.frames) == ["0"]


def test_a_frame_with_no_detections_keeps_an_empty_list(tmp_path):
    video = _write_video(tmp_path / "v.avi", frames=2)
    result = _adapter(_FakeModel()).infer(_request(video, 1), lambda done, total: None)
    assert result.frames["0"]["detections"] == []
    assert result.frames["1"]["detections"] == []


def test_boxes_become_top_left_xywh_and_the_floor_is_passed_to_the_model(tmp_path):
    video = _write_video(tmp_path / "v.avi", frames=1)
    model = _FakeModel(
        {0: _Result(boxes=_Boxes([[0.2, 0.4, 0.5, 0.9]], [0.87654321], [1]))}
    )
    result = _adapter(model).infer(_request(video, 1), lambda done, total: None)

    detection = result.frames["0"]["detections"][0]
    assert detection["class_id"] == 1
    assert detection["confidence"] == pytest.approx(0.8765, abs=1e-4)
    assert detection["bbox"] == pytest.approx([0.2, 0.4, 0.3, 0.5], abs=1e-4)
    assert "polygon" not in detection
    assert model.conf_seen == 0.05


def test_segmentation_adds_polygons(tmp_path):
    video = _write_video(tmp_path / "v.avi", frames=1)
    model = _FakeModel(
        {
            0: _Result(
                boxes=_Boxes([[0.1, 0.1, 0.4, 0.4]], [0.9], [0]),
                masks=_Masks([[[0.1, 0.1], [0.4, 0.1], [0.4, 0.4]]]),
            )
        }
    )
    result = _adapter(model).infer(
        _request(video, 1, "segmentation"), lambda done, total: None
    )
    assert result.frames["0"]["detections"][0]["polygon"] == [
        [0.1, 0.1], [0.4, 0.1], [0.4, 0.4],
    ]


def test_timestamps_follow_the_video_clock(tmp_path):
    video = _write_video(tmp_path / "v.avi", frames=10, fps=10)
    result = _adapter(_FakeModel()).infer(_request(video, 5), lambda done, total: None)
    assert result.frames["0"]["timestamp_ms"] == 0
    assert result.frames["5"]["timestamp_ms"] == pytest.approx(500, abs=60)
    assert result.fps == pytest.approx(10, abs=0.5)


def test_progress_reports_every_processed_frame_and_ends_at_the_total(tmp_path):
    video = _write_video(tmp_path / "v.avi", frames=10)
    seen: list[tuple[int, int]] = []
    _adapter(_FakeModel()).infer(_request(video, 5), lambda done, total: seen.append((done, total)))
    assert seen == [(1, 2), (2, 2)]


def test_an_unreadable_video_fails_with_a_message_instead_of_hanging(tmp_path):
    broken = tmp_path / "broken.avi"
    broken.write_bytes(b"this is not a video")
    with pytest.raises(ValueError, match="video"):
        _adapter(_FakeModel()).infer(_request(broken, 1), lambda done, total: None)


class _TimedResult(_Result):
    def __init__(self, speed, **kwargs):
        super().__init__(**kwargs)
        self.speed = speed


class _TimedModel(_FakeModel):
    """Returns a result carrying Ultralytics-style `speed` for each call."""

    def __init__(self, speeds):
        super().__init__()
        self.speeds = speeds

    def __call__(self, image, conf, verbose):
        speed = self.speeds[min(self.calls, len(self.speeds) - 1)]
        self.calls += 1
        return [_TimedResult(speed, boxes=_Boxes([], [], []))]


def _speed(inference):
    return {"preprocess": 1.0, "inference": inference, "postprocess": 1.0}


def test_timing_aggregates_the_models_own_speed_and_drops_the_warm_up_frame(tmp_path):
    video = _write_video(tmp_path / "v.avi", frames=4)
    model = _TimedModel([_speed(50.0), _speed(10.0), _speed(10.0), _speed(10.0)])
    result = _adapter(model).infer(_request(video, 1), lambda done, total: None)
    assert result.timing["frames_measured"] == 3
    assert result.timing["inference_ms"]["mean"] == 10.0
    assert result.timing["total_ms"]["mean"] == 12.0


def test_a_model_without_speed_yields_no_timing_and_still_succeeds(tmp_path):
    video = _write_video(tmp_path / "v.avi", frames=3)
    result = _adapter(_FakeModel()).infer(_request(video, 1), lambda done, total: None)
    assert result.timing is None
    assert list(result.frames) == ["0", "1", "2"]


def test_a_malformed_speed_is_ignored_instead_of_failing_the_run(tmp_path):
    video = _write_video(tmp_path / "v.avi", frames=3)
    model = _TimedModel([{"preprocess": "fast", "inference": None}])
    result = _adapter(model).infer(_request(video, 1), lambda done, total: None)
    assert result.timing is None
    assert len(result.frames) == 3


class _MeanRecordingModel(_FakeModel):
    def __init__(self):
        super().__init__()
        self.means = []

    def __call__(self, image, conf, verbose):
        self.means.append(float(image.mean()))
        return super().__call__(image, conf, verbose)


def test_the_perturbation_is_applied_before_the_model_sees_the_frame(tmp_path):
    video = _write_video(tmp_path / "v.avi", frames=3)
    plain, bright = _MeanRecordingModel(), _MeanRecordingModel()
    _adapter(plain).infer(_request(video), lambda done, total: None)
    request = _request(video)
    request.perturbation = {"kind": "brightness", "strength": 50}
    _adapter(bright).infer(request, lambda done, total: None)
    assert all(b > p + 20 for b, p in zip(bright.means, plain.means))
