"""The interface every trainer implements.

Shaped for hand-written PyTorch loops, not for Ultralytics. The reference
platform trained RT-DETRv2, DINOv2 and ConvNeXt with hand-rolled loops and
only YOLO with Ultralytics; an interface modelled on YOLO.train() would
not fit three of those four. So control is handed *to* the adapter, which
calls back as it goes.

should_stop is a pull rather than a push: the worker cannot interrupt
someone else's training loop from outside, but the loop can ask.
"""

from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable, Protocol


@dataclass
class TrainingRequest:
    dataset_dir: Path
    task_type: str
    base_model: str
    config: dict
    output_dir: Path


@dataclass
class TrainingResult:
    weights_path: Path
    metrics: dict = field(default_factory=dict)


class TrainingAdapter(Protocol):
    def train(
        self,
        request: TrainingRequest,
        on_log: Callable[[str], None],
        on_epoch: Callable[[int, int], None],
        should_stop: Callable[[], bool],
    ) -> TrainingResult:
        """Train to completion, or until should_stop() returns True at an
        epoch boundary. Raise on failure; the caller records it."""
        ...
