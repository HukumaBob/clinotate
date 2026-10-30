"""Pretrained base models each training adapter can start from.

Lives in the backend, keyed by adapter name, because the adapters
themselves live in ml-worker and the backend cannot import them. The
worker receives an already-resolved weights name. A second adapter adds an
entry to _TABLES; the Train form does not change.

Weight names were checked against ultralytics 8.4.123 in the ml-worker
image: every size x task combination below exists upstream.
"""

from dataclasses import dataclass

from app.datasets.models import TaskType

YOLO_ADAPTER = "ultralytics_yolo"
ADAPTER_NAME = YOLO_ADAPTER  # alias kept for existing imports
DINOV3_ADAPTER = "dinov3_classifier"

# Which dataset task types each adapter can train on, in display order.
ADAPTER_TASKS: dict[str, tuple[TaskType, ...]] = {
    YOLO_ADAPTER: (TaskType.DETECTION, TaskType.SEGMENTATION, TaskType.CLASSIFICATION),
    DINOV3_ADAPTER: (TaskType.DETECTION, TaskType.SEGMENTATION),
}
ADAPTER_LABELS = {YOLO_ADAPTER: "YOLO11", DINOV3_ADAPTER: "DINOv3 crop classifier"}

# The host GPU is 8 GB and has hard-rebooted under VRAM pressure. The note
# warns; it never blocks -- the person decides.
VRAM_NOTE = "may not fit in 8 GB"


@dataclass(frozen=True)
class PretrainedModel:
    weights: str
    family: str
    size: str
    note: str | None


_YOLO11_SIZES = ("n", "s", "m", "l", "x")
_YOLO11_SUFFIX = {
    TaskType.DETECTION: "",
    TaskType.SEGMENTATION: "-seg",
    TaskType.CLASSIFICATION: "-cls",
}


def _yolo11(task_type: TaskType) -> list[PretrainedModel]:
    suffix = _YOLO11_SUFFIX[task_type]
    return [
        PretrainedModel(
            weights=f"yolo11{size}{suffix}.pt",
            family="yolo11",
            size=size,
            note=VRAM_NOTE if size in ("l", "x") else None,
        )
        for size in _YOLO11_SIZES
    ]


_DINOV3_HUB = {
    "b": "facebook/dinov3-vitb16-pretrain-lvd1689m",  # default, listed first
    "s": "facebook/dinov3-vits16-pretrain-lvd1689m",
    "l": "facebook/dinov3-vitl16-pretrain-lvd1689m",
}


def _dinov3(task_type: TaskType) -> list[PretrainedModel]:
    if task_type not in ADAPTER_TASKS[DINOV3_ADAPTER]:
        return []
    return [
        PretrainedModel(
            weights=hub_id,
            family="dinov3",
            size=size,
            note=VRAM_NOTE if size == "l" else None,
        )
        for size, hub_id in _DINOV3_HUB.items()
    ]


_TABLES = {YOLO_ADAPTER: _yolo11, DINOV3_ADAPTER: _dinov3}


def adapters_for(task_type: TaskType) -> list[dict]:
    return [
        {"id": adapter, "label": ADAPTER_LABELS[adapter], "supported": task_type in tasks}
        for adapter, tasks in ADAPTER_TASKS.items()
    ]


def pretrained_models(adapter: str, task_type: TaskType) -> list[PretrainedModel]:
    build = _TABLES.get(adapter)
    return build(task_type) if build else []


def resolve_pretrained(adapter: str, task_type: TaskType, name: str) -> str | None:
    """The catalog's weights name for `name`, or None if it is not offered.

    Accepts the legacy un-suffixed form ("yolo11s.pt" on a segmentation
    dataset) because earlier clients sent it and the worker used to add the
    suffix silently; it now resolves to what will actually be trained.
    """
    for model in pretrained_models(adapter, task_type):
        legacy = f"{model.family}{model.size}.pt"
        if name in (model.weights, legacy):
            return model.weights
    return None
