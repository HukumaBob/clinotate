"""Ultralytics YOLO behind InferenceAdapter.

Reads the video with OpenCV (the sanctioned exception to "no filesystem
paths in domain code": OpenCV needs a real path and the caller deletes the
file), runs every frame_stride-th frame through the model, and converts
Ultralytics' result objects to plain dicts with top-left xywh boxes
normalised to 0..1.
"""

import math
from typing import Any, Callable

import cv2

from app.inference_adapter import InferenceRequest, InferenceResult

_BOX_DIGITS = 5
_CONFIDENCE_DIGITS = 4


def _detections_from(result: Any, task_type: str) -> list[dict]:
    boxes = result.boxes
    if boxes is None or len(boxes) == 0:
        return []
    corners = boxes.xyxyn.tolist()
    confidences = boxes.conf.tolist()
    class_ids = boxes.cls.tolist()
    polygons = None
    if task_type == "segmentation" and result.masks is not None:
        polygons = result.masks.xyn

    detections = []
    for i, (corner, confidence, class_id) in enumerate(zip(corners, confidences, class_ids)):
        x1, y1, x2, y2 = corner
        detection = {
            "class_id": int(class_id),
            "confidence": round(float(confidence), _CONFIDENCE_DIGITS),
            "bbox": [
                round(x1, _BOX_DIGITS),
                round(y1, _BOX_DIGITS),
                round(x2 - x1, _BOX_DIGITS),
                round(y2 - y1, _BOX_DIGITS),
            ],
        }
        if polygons is not None and i < len(polygons):
            detection["polygon"] = [
                [round(float(x), _BOX_DIGITS), round(float(y), _BOX_DIGITS)]
                for x, y in polygons[i].tolist()
            ]
        detections.append(detection)
    return detections


class UltralyticsInferenceAdapter:
    name = "ultralytics_yolo"

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
        request: InferenceRequest,
        on_progress: Callable[[int, int], None],
    ) -> InferenceResult:
        capture = cv2.VideoCapture(str(request.video_path))
        if not capture.isOpened():
            raise ValueError("Could not open the video file")
        try:
            fps = float(capture.get(cv2.CAP_PROP_FPS)) or 0.0
            frame_count = int(capture.get(cv2.CAP_PROP_FRAME_COUNT))
            total = math.ceil(frame_count / request.frame_stride) if frame_count > 0 else 0
            model = self._load(str(request.weights_path))

            frames: dict[str, dict] = {}
            index = 0
            # grab() advances without decoding; only the frames we keep are
            # retrieved, which is what makes a large stride cheap.
            while capture.grab():
                if index % request.frame_stride == 0:
                    ok, image = capture.retrieve()
                    if ok:
                        position_ms = capture.get(cv2.CAP_PROP_POS_MSEC)
                        if position_ms and position_ms > 0:
                            timestamp_ms = int(position_ms)
                        else:
                            timestamp_ms = int(index / fps * 1000) if fps else 0
                        results = model(image, conf=request.confidence_floor, verbose=False)
                        frames[str(index)] = {
                            "timestamp_ms": timestamp_ms,
                            "detections": _detections_from(results[0], request.task_type),
                        }
                        on_progress(len(frames), max(total, len(frames)))
                index += 1
        finally:
            capture.release()

        if not frames:
            raise ValueError("The video has no readable frames")

        names = model.names
        classes = [str(names[i]) for i in range(len(names))]
        return InferenceResult(
            task_type=request.task_type, fps=fps, classes=classes, frames=frames
        )
