"""The interface every trainer implements.

Shaped for hand-written PyTorch loops, not for Ultralytics. The reference
platform trained RT-DETRv2, DINOv2 and ConvNeXt with hand-rolled loops and
only YOLO with Ultralytics; an interface modelled on YOLO.train() would
not fit three of those four. So control is handed *to* the adapter, which
calls back as it goes.

should_stop is a pull rather than a push: the worker cannot interrupt
someone else's training loop from outside, but the loop can ask.

The third argument to on_epoch is the trainer's own flat dict of metrics
for that epoch, or None if it computes none. Key names are deliberately
NOT normalized: mapping metrics/mAP50(B) and map50 onto one canonical
name is the schema-shaped-around-one-trainer this interface exists to
avoid. The platform understands the shape, never the vocabulary.
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
    # Per-epoch points, [{"epoch": 1, <the trainer's own keys>}, ...].
    # Redundant with what on_epoch already delivered; it exists for a
    # trainer that can only produce its history at the end. If both are
    # non-empty this one wins -- it is the trainer's final word.
    history: list[dict] = field(default_factory=list)
    # [{"class": "polyp", <numbers>}, ...]. "class" is required; every
    # other key is the trainer's own.
    per_class: list[dict] = field(default_factory=list)
    # {"labels": [...], "matrix": [[int, ...], ...]}. For detection the
    # labels end with a literal "background": misses into background are
    # real data, not padding to trim.
    confusion: dict | None = None
    # Files the trainer wrote that the platform stores without parsing.
    artifacts: list[Path] = field(default_factory=list)


class TrainingAdapter(Protocol):
    def train(
        self,
        request: TrainingRequest,
        on_log: Callable[[str], None],
        on_epoch: Callable[[int, int, dict | None], None],
        should_stop: Callable[[], bool],
    ) -> TrainingResult:
        """Train to completion, or until should_stop() returns True at an
        epoch boundary. Raise on failure; the caller records it."""
        ...
