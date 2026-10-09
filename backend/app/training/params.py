"""Training settings each adapter exposes, with validation and presets.

Lives in the backend, keyed by adapter name, next to the base-model catalog:
the adapters live in ml-worker, which the backend cannot import. The Train
form is rendered from this schema, so a second adapter adds a table here and
the screen does not change.

Names, ranges and defaults were read from ultralytics 8.4.123
(cfg/default.yaml). Deliberately not exposed: the loss gains, shear,
perspective, bgr, cutmix, compile, fraction, single_cls, nbs, rect -- and
every key that would let a request redirect the trainer (data, project, name,
exist_ok, resume, pretrained, device, model): a key that is not in this
schema is rejected, so those can never reach model.train().
"""

import math
from dataclasses import dataclass
from typing import Any, Literal

from app.datasets.models import TaskType
from app.training.catalog import ADAPTER_NAME

FieldType = Literal["int", "float", "bool", "choice"]

GROUPS = (
    ("basic", "Basic"),
    ("optimization", "Optimization"),
    ("augmentation", "Augmentation"),
    ("finetune", "Fine-tuning"),
    ("system", "System"),
)

_DETECT_SEGMENT = (TaskType.DETECTION, TaskType.SEGMENTATION)


class InvalidSettings(Exception):
    """One or more settings are not acceptable; `errors` lists every problem."""

    def __init__(self, errors: list[str]):
        self.errors = errors
        super().__init__("; ".join(errors))


@dataclass(frozen=True)
class ParamField:
    key: str
    label: str
    group: str
    type: FieldType
    default: Any
    help: str
    min: float | None = None
    max: float | None = None
    step: float | None = None
    choices: tuple[str, ...] | None = None
    tasks: tuple[TaskType, ...] | None = None  # None = every task
    optional: bool = False  # default None: omitted from the resolved settings


@dataclass(frozen=True)
class Preset:
    id: str
    label: str
    description: str
    values: dict


def _yolo11_fields() -> list[ParamField]:
    f = ParamField
    return [
        # -- basic
        f("epochs", "Epochs", "basic", "int", 50, min=1, max=1000,
          help="Passes over the training set. More epochs help until validation stops improving."),
        f("batch", "Batch size", "basic", "int", 8, min=1, max=256,
          help="Images per step. Larger is faster and steadier but needs more GPU memory; "
               "on the 8 GB card lower it first when a run runs out of memory."),
        f("imgsz", "Image size", "basic", "int", 640, min=32, max=1280, step=32,
          help="Side of the training image in pixels, a multiple of 32. Larger frames keep fine "
               "surface texture but cost much more memory and time."),
        f("patience", "Early-stop patience", "basic", "int", 100, min=1, max=1000,
          help="Stop early after this many epochs without validation improvement."),
        f("seed", "Random seed", "basic", "int", 0, min=0, max=2147483647,
          help="Keep it fixed to repeat a run; change it to see how much results vary."),
        # -- optimization
        f("optimizer", "Optimizer", "optimization", "choice", "auto",
          choices=("auto", "SGD", "Adam", "AdamW"),
          help="'auto' lets Ultralytics choose the optimizer and ignores the learning rate and "
               "momentum settings. Pick one explicitly to control the learning rate."),
        f("lr0", "Initial learning rate", "optimization", "float", 0.01, min=0.00001, max=1,
          help="Only used with an explicit optimizer (not 'auto'). AdamW usually wants about "
               "0.001, SGD about 0.01; fine-tuning wants less."),
        f("lrf", "Final learning rate", "optimization", "float", 0.01, min=0.0001, max=1,
          help="Learning rate at the end, as a fraction of the initial one."),
        f("cos_lr", "Cosine schedule", "optimization", "bool", False,
          help="Decay the learning rate along a cosine curve instead of linearly."),
        f("weight_decay", "Weight decay", "optimization", "float", 0.0005, min=0, max=0.1,
          help="Regularisation strength; raise it a little if the model overfits."),
        f("warmup_epochs", "Warm-up epochs", "optimization", "float", 3.0, min=0, max=20,
          help="Epochs of gentle learning-rate ramp-up at the start; shorten it when fine-tuning."),
        # -- augmentation
        f("hsv_h", "Hue shift", "augmentation", "float", 0.015, min=0, max=0.1,
          help="Random hue change. Keep it small when colour is a diagnostic cue."),
        f("hsv_s", "Saturation shift", "augmentation", "float", 0.7, min=0, max=1,
          help="Random saturation change; large values wash out mucosal colour."),
        f("hsv_v", "Brightness shift", "augmentation", "float", 0.4, min=0, max=1,
          help="Random brightness change; helps with uneven endoscope lighting."),
        f("degrees", "Rotation (degrees)", "augmentation", "float", 0.0, min=0, max=180,
          tasks=_DETECT_SEGMENT, help="Random rotation up to this many degrees either way."),
        f("translate", "Translation", "augmentation", "float", 0.1, min=0, max=0.5,
          tasks=_DETECT_SEGMENT, help="Random shift as a fraction of the image size."),
        f("scale", "Scale", "augmentation", "float", 0.5, min=0, max=1,
          help="Random zoom in and out by up to this fraction."),
        f("fliplr", "Horizontal flip", "augmentation", "float", 0.5, min=0, max=1,
          help="Probability of mirroring the image left to right."),
        f("flipud", "Vertical flip", "augmentation", "float", 0.0, min=0, max=1,
          help="Probability of flipping the image upside down; endoscopic views have no fixed up."),
        f("mosaic", "Mosaic", "augmentation", "float", 1.0, min=0, max=1,
          tasks=_DETECT_SEGMENT,
          help="Probability of stitching four images into one training image."),
        f("close_mosaic", "Mosaic off for last epochs", "augmentation", "int", 10, min=0, max=100,
          tasks=_DETECT_SEGMENT,
          help="Switch mosaic off for the final N epochs so the model finishes on natural images."),
        f("mixup", "MixUp", "augmentation", "float", 0.0, min=0, max=1,
          tasks=_DETECT_SEGMENT, help="Probability of blending two images together."),
        f("copy_paste", "Copy-paste", "augmentation", "float", 0.0, min=0, max=1,
          tasks=(TaskType.SEGMENTATION,),
          help="Probability of pasting objects from one image into another."),
        f("erasing", "Random erasing", "augmentation", "float", 0.4, min=0, max=0.9,
          tasks=(TaskType.CLASSIFICATION,),
          help="Probability of blanking a random patch so the model cannot rely on one spot."),
        f("auto_augment", "Auto-augment policy", "augmentation", "choice", "randaugment",
          choices=("randaugment", "autoaugment", "augmix"), tasks=(TaskType.CLASSIFICATION,),
          help="Which ready-made augmentation recipe to apply."),
        f("dropout", "Classifier dropout", "augmentation", "float", 0.0, min=0, max=0.9,
          tasks=(TaskType.CLASSIFICATION,),
          help="Fraction of the classifier head switched off during training; fights overfitting."),
        # -- fine-tuning
        f("freeze", "Freeze first layers", "finetune", "int", None, min=0, max=50, optional=True,
          help="Keep the first N layers unchanged. Leave empty to train everything; freezing "
               "helps when fine-tuning on little data."),
        # -- system
        f("cache", "Cache images", "system", "choice", "false", choices=("false", "ram", "disk"),
          help="Keep decoded images in memory or on disk to speed up epochs; 'false' reads files "
               "each time."),
        f("workers", "Data-loader workers", "system", "int", 8, min=0, max=16,
          help="Parallel image-loading processes."),
        f("amp", "Mixed precision", "system", "bool", True,
          help="Faster and lighter on memory; switch off only to diagnose odd numerical results."),
        f("deterministic", "Deterministic", "system", "bool", True,
          help="Reproducible but slightly slower operations."),
    ]


def _yolo11_presets() -> list[Preset]:
    return [
        Preset("quick_check", "Quick check",
               "Three short epochs to confirm the dataset and settings run at all.",
               {"epochs": 3, "batch": 4}),
        Preset("standard", "Standard", "The default settings.", {}),
        Preset("fine_detail", "Fine detail",
               "Larger frames and gentler colour jitter, so fine surface texture and "
               "mucosal colour cues are kept.",
               {"imgsz": 800, "batch": 4, "hsv_h": 0.005, "hsv_s": 0.3, "hsv_v": 0.2,
                "mosaic": 0.5, "scale": 0.3, "close_mosaic": 15}),
        Preset("fine_tune", "Fine-tune",
               "For continuing from a trained model: first layers frozen, a small explicit "
               "learning rate and a short warm-up.",
               {"epochs": 30, "freeze": 10, "optimizer": "AdamW", "lr0": 0.0005,
                "warmup_epochs": 1}),
    ]


_TABLES = {ADAPTER_NAME: (_yolo11_fields, _yolo11_presets)}


def _fields_for(adapter: str, task_type: TaskType) -> list[ParamField]:
    table = _TABLES.get(adapter)
    if table is None:
        return []
    return [f for f in table[0]() if f.tasks is None or task_type in f.tasks]


def _presets_for(adapter: str) -> list[Preset]:
    table = _TABLES.get(adapter)
    return table[1]() if table else []


def settings_schema(adapter: str, task_type: TaskType) -> dict:
    fields = _fields_for(adapter, task_type)
    keys = {f.key for f in fields}
    groups = []
    for group_id, label in GROUPS:
        members = [f for f in fields if f.group == group_id]
        if not members:
            continue
        groups.append(
            {
                "id": group_id,
                "label": label,
                "fields": [
                    {
                        "key": f.key,
                        "label": f.label,
                        "type": f.type,
                        "default": f.default,
                        "help": f.help,
                        "min": f.min,
                        "max": f.max,
                        "step": f.step,
                        "choices": list(f.choices) if f.choices else None,
                        "optional": f.optional,
                    }
                    for f in members
                ],
            }
        )
    presets = [
        {
            "id": p.id,
            "label": p.label,
            "description": p.description,
            "values": {k: v for k, v in p.values.items() if k in keys},
        }
        for p in _presets_for(adapter)
    ]
    return {"groups": groups, "presets": presets}


def _check(field: ParamField, value: Any) -> tuple[Any, str | None]:
    key = field.key
    if field.type == "bool":
        if not isinstance(value, bool):
            return None, f"{key} must be true or false"
        return value, None
    if field.type == "choice":
        if not isinstance(value, str) or value not in (field.choices or ()):
            return None, f"{key} must be one of: {', '.join(field.choices or ())}"
        return value, None
    # int and float: a bool is an int in Python, so exclude it explicitly
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None, f"{key} must be a number"
    if not math.isfinite(value):
        return None, f"{key} must be a finite number"
    if field.type == "int":
        if isinstance(value, float):
            if not value.is_integer():
                return None, f"{key} must be a whole number"
            value = int(value)
        if field.step and field.step > 1 and value % int(field.step) != 0:
            return None, f"{key} must be a multiple of {int(field.step)}"
    else:
        value = float(value)
    if field.min is not None and value < field.min:
        return None, f"{key} must be at least {field.min:g}"
    if field.max is not None and value > field.max:
        return None, f"{key} must be at most {field.max:g}"
    return value, None


def resolve_settings(adapter: str, task_type: TaskType, raw: dict | None) -> dict:
    """Defaults for every applicable field, overridden by the validated `raw`.

    The result is the run's complete, reproducible configuration. Raises
    InvalidSettings listing every problem at once.
    """
    if raw is None:
        raw = {}
    if not isinstance(raw, dict):
        raise InvalidSettings(["settings must be an object"])

    fields = {f.key: f for f in _fields_for(adapter, task_type)}
    resolved = {f.key: f.default for f in fields.values() if f.default is not None}
    errors: list[str] = []
    for key, value in raw.items():
        field = fields.get(key)
        if field is None:
            errors.append(f"{key}: unknown, or not applicable to {task_type.value} training")
            continue
        if value is None:
            if field.optional:
                resolved.pop(key, None)
            else:
                errors.append(f"{key} is required")
            continue
        checked, error = _check(field, value)
        if error:
            errors.append(error)
        else:
            resolved[key] = checked
    if errors:
        raise InvalidSettings(errors)
    return resolved
