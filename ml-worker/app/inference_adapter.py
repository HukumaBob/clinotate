"""The interface every inference backend implements.

Parallel to TrainingAdapter and shaped the same way: control is handed to
the adapter, which reports progress as it goes. The result is plain data
(dicts and lists) so the worker can serialise it without knowing which
framework produced it.
"""

from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable, Protocol


@dataclass
class InferenceRequest:
    video_path: Path
    weights_path: Path
    # "detection" or "segmentation" -- the TaskType values.
    task_type: str
    frame_stride: int
    # Deliberately low: the screen filters by confidence on the client, so
    # anything the model might still call a detection has to be stored.
    confidence_floor: float = 0.05
    # Stress test: {"kind", "strength"} applied to each frame before the model.
    perturbation: dict | None = None


@dataclass
class InferenceResult:
    task_type: str
    fps: float
    # Index is the class id.
    classes: list[str]
    # str(frame_index) -> {"timestamp_ms": int, "detections": [...]}.
    # A processed frame with nothing in it has "detections": [], so
    # "nothing found" stays distinguishable from "frame not processed".
    frames: dict[str, dict] = field(default_factory=dict)
    # Aggregates of the model's own per-frame timings (see inference_timing),
    # or None when the model reported none. Optional in the document too.
    timing: dict | None = None


class InferenceAdapter(Protocol):
    def infer(
        self,
        request: InferenceRequest,
        on_progress: Callable[[int, int], None],
    ) -> InferenceResult:
        """Run the model over the video. on_progress(processed, total) is
        called after each processed frame. Raise on failure; the caller
        records it."""
        ...
