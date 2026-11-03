"""Ultralytics classification models run over a video, one model per axis.

Ultralytics API, verified in the ml-worker container (ultralytics 8.4.123):
a classification model call returns a list of ``Results``; each has
``result.probs`` (a ``Probs`` object) whose ``.data`` is the full probability
vector (torch tensor or ndarray, length = number of classes), with ``top1``
and ``top1conf`` derived from it. ``model.names`` is a ``{class_id: name}``
dict, so class order is read as ``names[0..n-1]``, matching class-id order.

Reads the video with OpenCV the same way as the detection adapter
(grab()/retrieve(), decode once, run every axis model on each kept frame).
"""

import math
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable

import cv2

from app.perturbation import apply_perturbation

_PROB_DIGITS = 3


@dataclass
class AxisWeights:
    name: str
    weights_path: Path


@dataclass
class ClassificationRequest:
    video_path: Path
    axes: list[AxisWeights]
    frame_stride: int
    # Stress test: {"kind", "strength"} applied to each frame before the models.
    perturbation: dict | None = None


@dataclass
class ClassificationResult:
    fps: float
    # [{"name": str, "classes": [str]}], index = axis position.
    axes: list[dict]
    # str(frame_index) -> {"timestamp_ms": int, "axes": [{"class_id",
    # "confidence", "probs"}]} with "axes" parallel to ClassificationResult.axes.
    frames: dict[str, dict] = field(default_factory=dict)


def _axis_entry(result: Any) -> dict:
    probs = [float(p) for p in result.probs.data.tolist()]
    class_id = max(range(len(probs)), key=probs.__getitem__)
    return {
        "class_id": class_id,
        "confidence": round(probs[class_id], _PROB_DIGITS),
        "probs": [round(p, _PROB_DIGITS) for p in probs],
    }


class UltralyticsClassificationAdapter:
    name = "ultralytics_classification"

    def __init__(self, model_loader: Callable[[str], Any] | None = None) -> None:
        # Injectable so tests can run without weights or a GPU.
        self._model_loader = model_loader

    def _load(self, weights_path: str) -> Any:
        if self._model_loader is not None:
            return self._model_loader(weights_path)
        from ultralytics import YOLO

        return YOLO(weights_path)

    def infer(
        self,
        request: ClassificationRequest,
        on_progress: Callable[[int, int], None],
    ) -> ClassificationResult:
        capture = cv2.VideoCapture(str(request.video_path))
        if not capture.isOpened():
            raise ValueError("Could not open the video file")
        try:
            fps = float(capture.get(cv2.CAP_PROP_FPS)) or 0.0
            frame_count = int(capture.get(cv2.CAP_PROP_FRAME_COUNT))
            total = math.ceil(frame_count / request.frame_stride) if frame_count > 0 else 0
            models = [self._load(str(axis.weights_path)) for axis in request.axes]

            frames: dict[str, dict] = {}
            index = 0
            while capture.grab():
                if index % request.frame_stride == 0:
                    ok, image = capture.retrieve()
                    if ok:
                        image = apply_perturbation(image, request.perturbation, seed=index)
                        position_ms = capture.get(cv2.CAP_PROP_POS_MSEC)
                        if position_ms and position_ms > 0:
                            timestamp_ms = int(position_ms)
                        else:
                            timestamp_ms = int(index / fps * 1000) if fps else 0
                        frames[str(index)] = {
                            "timestamp_ms": timestamp_ms,
                            "axes": [
                                _axis_entry(model(image, verbose=False)[0]) for model in models
                            ],
                        }
                        on_progress(len(frames), max(total, len(frames)))
                index += 1
        finally:
            capture.release()

        if not frames:
            raise ValueError("The video has no readable frames")

        axes = [
            {"name": axis.name, "classes": [str(model.names[i]) for i in range(len(model.names))]}
            for axis, model in zip(request.axes, models)
        ]
        return ClassificationResult(fps=fps, axes=axes, frames=frames)
