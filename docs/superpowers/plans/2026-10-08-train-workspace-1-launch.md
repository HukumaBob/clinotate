# Train Workspace, Plan 1 of 3: Launch — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A launch form with explained, schema-driven training settings, presets, a run name and note, and a dataset card, replacing the five-field form.

**Architecture:** The backend owns a per-adapter settings schema (`params.py`) that validates a run's `settings` and is served to the frontend at `GET /training/settings-schema`; `TrainingRun` gains `name`/`note`; the worker passes the validated settings to `model.train()`. The frontend renders the form generically from the schema. The page shell, history and compare views are Plans 2 and 3; this plan keeps the current page layout (the form column is widened) and builds components that move unchanged into the new tabs.

**Tech Stack:** FastAPI, SQLAlchemy, Alembic, Pydantic v2, Celery ml-worker with Ultralytics 8.4.123, React + Vite + vitest, `openapi-typescript`.

**Spec:** [docs/superpowers/specs/2026-10-08-train-workspace-design.md](../specs/2026-10-08-train-workspace-design.md) (sections "Settings schema", "Data model and API", "Worker", and the "Tab 'New run'" / "Left rail: dataset" parts of "Screen"). Base-model catalog and fine-tuning it builds on: [2026-10-08-training-base-models-design.md](../specs/2026-10-08-training-base-models-design.md).

## Global Constraints

- Work directly on `master`; no branches, no worktrees (CLAUDE.md). Untracked `yolo_qc_playground_architecture.pdf` is never committed.
- English only in code, comments, UI copy, commit messages. Dark theme only (no light-background Tailwind classes).
- TDD: a failing test before every implementation step.
- Backend tests use `import app.db as db_module` + `db_module.SessionLocal()`, never `from app.db import SessionLocal`; they run against `endoscopy_test`.
- ml-worker tests run via `docker cp` + `docker compose exec` (Dockerfile does not COPY `tests/`; container `endoscopy-platform-ml-worker-1`, interpreter `/app/.venv/bin/python`). `docker cp` is a test mechanism, not a deploy.
- Never leave rows in the real `endoscopy` DB or objects in MinIO; clean up unprompted, sweeping every table, after backing up to the scratchpad. Do not truncate the dev DB. Do not start/stop dev servers or touch :5173/:5174 without asking.
- All HTTP in the frontend via `apiClient`; never hand-edit `frontend/src/shared/api/generated/`. After backend schema/route changes: `cd backend && PYTHONPATH=. uv run python scripts/export_openapi.py`, check `git diff --stat openapi.json`, then `cd frontend && npm run generate-api`.
- Settings keys that would let a request redirect the trainer (`data`, `project`, `name`, `exist_ok`, `resume`, `pretrained`, `device`, `model`) must never be accepted anywhere.
- Commit trailer: `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`.
- Known pre-existing failures (ignore, do not chase): `tests/test_training_models.py::test_training_run_defaults` and `::test_model_version_links_to_run`; jest-dom `TS2339` matcher type errors under `tsc`.

## Review Focus

1. A request carrying `settings: {"project": "/x"}`, `{"data": ...}` or `{"resume": true}` must be rejected (422), never forwarded to `model.train()`.
2. `true` for an int field (`epochs`) and `1` for a bool field must be rejected (Python's `bool` is an `int`).
3. A classification dataset must neither show nor accept detection-only fields (`mosaic`, `degrees`, ...); preset values for inapplicable keys are dropped for that task.
4. Applying a preset must set every field to default first, then the preset's values — no leakage from a previously applied preset or hand edits.
5. `optimizer: auto` makes Ultralytics ignore `lr0` and `momentum` (confirmed in `engine/trainer.py:build_optimizer`): the help text must say so.
6. An empty optional field (`freeze`) must be omitted from the request, never sent as `""`, `0` or `null`; `cache: "false"` must reach Ultralytics as boolean `False`.
7. A stale settings-schema response for a previously selected dataset must not overwrite the current one (same race that hit the base-model catalog).
8. A run created through the new body must store the full resolved settings (defaults included) in `TrainingRun.config`, and `total_epochs` must equal `settings.epochs`.

## File Structure

- Create `backend/app/training/params.py` — per-adapter settings schema, presets, validation. Pure, no DB.
- Create `backend/alembic/versions/d5e6f7a8b9c0_add_training_run_name_note.py`.
- Modify `backend/app/training/models.py`, `schemas.py`, `service.py`, `router.py`.
- Create `backend/tests/test_training_params.py`; modify `backend/tests/test_training_api.py`, `test_training_service.py`.
- Modify `ml-worker/app/ultralytics_yolo_adapter.py`; tests in `ml-worker/tests/test_ultralytics_yolo_adapter.py`.
- Create `frontend/src/features/training/{settingsLogic.ts, SettingsForm.tsx, DatasetCard.tsx, RunSummary.tsx, testFixtures.ts}` and their tests.
- Rewrite `frontend/src/features/training/TrainConfigForm.tsx`; modify `TrainPage.tsx`; update `TrainConfigForm.test.tsx`, `TrainPage.test.tsx`.
- Modify `ROADMAP.md`; regenerate `openapi.json`.

---

### Task 1: Backend settings schema and validation

**Files:**
- Create: `backend/app/training/params.py`
- Test: `backend/tests/test_training_params.py`

**Interfaces:**
- Consumes: `catalog.ADAPTER_NAME`, `TaskType`.
- Produces:
  - `params.ADAPTER_NAME` (re-export of `catalog.ADAPTER_NAME`)
  - `class InvalidSettings(Exception)` with `.errors: list[str]`; `str(exc)` is `"; ".join(errors)`
  - `params.settings_schema(adapter: str, task_type: TaskType) -> dict` shaped `{"groups": [{"id","label","fields":[{"key","label","type","default","help","min","max","step","choices","optional"}]}], "presets": [{"id","label","description","values"}]}` (fields not applicable to the task are absent; preset values for absent fields are dropped)
  - `params.resolve_settings(adapter: str, task_type: TaskType, raw: dict | None) -> dict` — defaults for every applicable field with a non-null default, overridden by validated `raw`; optional fields set to `None` are omitted; raises `InvalidSettings`

- [ ] **Step 1: Write the failing tests**

```python
# backend/tests/test_training_params.py
import pytest

from app.datasets.models import TaskType
from app.training import params

ADAPTER = params.ADAPTER_NAME
DET, SEG, CLS = TaskType.DETECTION, TaskType.SEGMENTATION, TaskType.CLASSIFICATION


def _fields(schema):
    return {f["key"]: f for g in schema["groups"] for f in g["fields"]}


def test_groups_are_ordered_and_non_empty():
    schema = params.settings_schema(ADAPTER, DET)

    assert [g["id"] for g in schema["groups"]] == [
        "basic",
        "optimization",
        "augmentation",
        "finetune",
        "system",
    ]
    assert all(g["fields"] for g in schema["groups"])


def test_basic_group_carries_the_core_fields_with_defaults():
    fields = _fields(params.settings_schema(ADAPTER, DET))

    assert fields["epochs"]["default"] == 50
    assert fields["batch"]["default"] == 8
    assert fields["imgsz"]["default"] == 640
    assert fields["imgsz"]["step"] == 32
    assert fields["optimizer"]["choices"] == ["auto", "SGD", "Adam", "AdamW"]
    assert fields["freeze"]["optional"] is True and fields["freeze"]["default"] is None


def test_every_field_is_explained():
    for task in (DET, SEG, CLS):
        for field in _fields(params.settings_schema(ADAPTER, task)).values():
            assert field["help"].strip(), field["key"]
            assert field["label"].strip(), field["key"]


def test_task_specific_fields_only_where_they_apply():
    det = _fields(params.settings_schema(ADAPTER, DET))
    seg = _fields(params.settings_schema(ADAPTER, SEG))
    cls = _fields(params.settings_schema(ADAPTER, CLS))

    assert "copy_paste" in seg and "copy_paste" not in det and "copy_paste" not in cls
    assert "erasing" in cls and "dropout" in cls and "auto_augment" in cls
    assert "erasing" not in det and "erasing" not in seg
    assert "mosaic" in det and "mosaic" in seg and "mosaic" not in cls
    assert "degrees" in det and "degrees" not in cls
    assert "hsv_h" in cls and "fliplr" in cls


@pytest.mark.parametrize(
    "key", ["data", "project", "name", "exist_ok", "resume", "pretrained", "device", "model"]
)
def test_forbidden_keys_are_not_in_the_schema(key):
    for task in (DET, SEG, CLS):
        assert key not in _fields(params.settings_schema(ADAPTER, task))


@pytest.mark.parametrize("task", [DET, SEG, CLS])
def test_defaults_resolve_for_every_task(task):
    resolved = params.resolve_settings(ADAPTER, task, {})

    assert resolved["epochs"] == 50
    assert resolved["cache"] == "false"
    assert "freeze" not in resolved


def test_resolve_overrides_defaults_and_keeps_the_rest():
    resolved = params.resolve_settings(ADAPTER, DET, {"epochs": 12, "hsv_h": 0.01})

    assert resolved["epochs"] == 12
    assert resolved["hsv_h"] == 0.01
    assert resolved["batch"] == 8 and resolved["imgsz"] == 640


def test_unknown_key_is_rejected():
    with pytest.raises(params.InvalidSettings, match="bogus"):
        params.resolve_settings(ADAPTER, DET, {"bogus": 1})


@pytest.mark.parametrize(
    "raw", [{"project": "/x"}, {"data": "y"}, {"resume": True}, {"pretrained": False}]
)
def test_trainer_redirecting_keys_are_rejected(raw):
    with pytest.raises(params.InvalidSettings):
        params.resolve_settings(ADAPTER, DET, raw)


def test_key_not_applicable_to_the_task_is_rejected():
    with pytest.raises(params.InvalidSettings, match="mosaic"):
        params.resolve_settings(ADAPTER, CLS, {"mosaic": 1.0})
    with pytest.raises(params.InvalidSettings, match="erasing"):
        params.resolve_settings(ADAPTER, DET, {"erasing": 0.4})


@pytest.mark.parametrize(
    "raw",
    [
        {"epochs": 0},
        {"epochs": 1001},
        {"batch": 257},
        {"imgsz": 650},  # not a multiple of 32
        {"imgsz": 16},
        {"hsv_s": 1.5},
        {"lr0": 0},
    ],
)
def test_out_of_range_values_are_rejected(raw):
    with pytest.raises(params.InvalidSettings):
        params.resolve_settings(ADAPTER, DET, raw)


def test_bool_and_int_are_not_interchangeable():
    with pytest.raises(params.InvalidSettings):
        params.resolve_settings(ADAPTER, DET, {"epochs": True})
    with pytest.raises(params.InvalidSettings):
        params.resolve_settings(ADAPTER, DET, {"cos_lr": 1})
    with pytest.raises(params.InvalidSettings):
        params.resolve_settings(ADAPTER, DET, {"lr0": False})


def test_int_fields_accept_whole_floats_only():
    assert params.resolve_settings(ADAPTER, DET, {"epochs": 10.0})["epochs"] == 10
    with pytest.raises(params.InvalidSettings):
        params.resolve_settings(ADAPTER, DET, {"epochs": 10.5})


def test_float_fields_accept_ints():
    assert params.resolve_settings(ADAPTER, DET, {"lrf": 1})["lrf"] == 1.0


def test_non_finite_numbers_are_rejected():
    with pytest.raises(params.InvalidSettings):
        params.resolve_settings(ADAPTER, DET, {"lr0": float("nan")})
    with pytest.raises(params.InvalidSettings):
        params.resolve_settings(ADAPTER, DET, {"lr0": float("inf")})


def test_choice_values_are_checked():
    assert params.resolve_settings(ADAPTER, DET, {"optimizer": "AdamW"})["optimizer"] == "AdamW"
    with pytest.raises(params.InvalidSettings):
        params.resolve_settings(ADAPTER, DET, {"optimizer": "Lion"})
    with pytest.raises(params.InvalidSettings):
        params.resolve_settings(ADAPTER, DET, {"cache": True})


def test_optional_freeze_is_omitted_when_null_and_range_checked_when_set():
    assert "freeze" not in params.resolve_settings(ADAPTER, DET, {"freeze": None})
    assert params.resolve_settings(ADAPTER, DET, {"freeze": 10})["freeze"] == 10
    with pytest.raises(params.InvalidSettings):
        params.resolve_settings(ADAPTER, DET, {"freeze": -1})


def test_a_required_field_cannot_be_null():
    with pytest.raises(params.InvalidSettings):
        params.resolve_settings(ADAPTER, DET, {"epochs": None})


def test_every_problem_is_reported_together():
    with pytest.raises(params.InvalidSettings) as caught:
        params.resolve_settings(ADAPTER, DET, {"epochs": 0, "bogus": 1})

    assert len(caught.value.errors) == 2
    assert "epochs" in str(caught.value) and "bogus" in str(caught.value)


def test_settings_must_be_a_mapping():
    with pytest.raises(params.InvalidSettings):
        params.resolve_settings(ADAPTER, DET, ["epochs"])


def test_preset_ids_and_their_values_are_valid_for_every_task():
    for task in (DET, SEG, CLS):
        schema = params.settings_schema(ADAPTER, task)
        assert [p["id"] for p in schema["presets"]] == [
            "quick_check",
            "standard",
            "fine_detail",
            "fine_tune",
        ]
        fields = _fields(schema)
        for preset in schema["presets"]:
            assert preset["label"].strip() and preset["description"].strip()
            assert set(preset["values"]) <= set(fields), (task, preset["id"])
            # A preset only fills the form, so what it holds must pass validation.
            params.resolve_settings(ADAPTER, task, preset["values"])


def test_preset_values_for_inapplicable_fields_are_dropped():
    det = {p["id"]: p for p in params.settings_schema(ADAPTER, DET)["presets"]}
    cls = {p["id"]: p for p in params.settings_schema(ADAPTER, CLS)["presets"]}

    assert "mosaic" in det["fine_detail"]["values"]
    assert "mosaic" not in cls["fine_detail"]["values"]
    assert cls["fine_detail"]["values"]["imgsz"] == 800


def test_preset_contents():
    presets = {p["id"]: p["values"] for p in params.settings_schema(ADAPTER, DET)["presets"]}

    assert presets["quick_check"] == {"epochs": 3, "batch": 4}
    assert presets["standard"] == {}
    assert presets["fine_tune"]["freeze"] == 10
    assert presets["fine_tune"]["optimizer"] == "AdamW"


def test_unknown_adapter_has_no_fields():
    assert params.settings_schema("no_such_adapter", DET)["groups"] == []
    with pytest.raises(params.InvalidSettings):
        params.resolve_settings("no_such_adapter", DET, {"epochs": 1})
```

- [ ] **Step 2: Run to verify failure**

Run: `cd backend && uv run pytest tests/test_training_params.py -v`
Expected: FAIL (`ModuleNotFoundError: app.training.params`).

- [ ] **Step 3: Implement**

```python
# backend/app/training/params.py
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
```

- [ ] **Step 4: Run to verify pass**

Run: `cd backend && uv run pytest tests/test_training_params.py -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/app/training/params.py backend/tests/test_training_params.py
git commit -m "feat: per-adapter training settings schema with validation and presets

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Run name/note, settings-based create, schema endpoint, PATCH

**Files:**
- Create: `backend/alembic/versions/d5e6f7a8b9c0_add_training_run_name_note.py`
- Modify: `backend/app/training/models.py`, `schemas.py`, `service.py`, `router.py`
- Modify tests: `backend/tests/test_training_api.py`, `backend/tests/test_training_service.py`
- Regenerate: `openapi.json`

**Interfaces:**
- Consumes: `params.settings_schema`, `params.resolve_settings`, `params.InvalidSettings` (Task 1).
- Produces:
  - `TrainingRun.name: str | None`, `TrainingRun.note: str | None`
  - `TrainingRunCreate`: `dataset_id`, `base_model | base_model_version_id` (exactly one), `name: str | None`, `note: str | None`, `settings: dict`
  - `TrainingRunRead` gains `name`, `note`
  - `TrainingRunUpdate` (`name`, `note`), `PATCH /training/runs/{id}`
  - `SettingFieldRead`, `SettingGroupRead`, `PresetRead`, `SettingsSchemaRead`; `GET /training/settings-schema?dataset_id=N`
  - `service.create_training_run(session, *, dataset_id, base_model=None, base_model_version_id=None, settings=None, name=None, note=None, created_by)` — stores the full resolved settings in `config`, `total_epochs = settings["epochs"]`
  - `service.update_run_meta(session, run_id, fields: dict) -> TrainingRun`; `service.get_settings_schema(session, dataset_id) -> dict`

- [ ] **Step 1: Write the failing tests**

In `backend/tests/test_training_api.py`, change the shared helper and add tests (reuse `_session`, `client`, `_register_and_login`, `_make_dataset`, `_succeeded_export`, `_cleanup`, `_user_id`, `_stub_send_task`, `_create`):

```python
def _create(headers, dataset_id, **overrides):
    body = {"dataset_id": dataset_id, "settings": {"epochs": 1, "batch": 2}, **overrides}
    return client.post("/training/runs", json=body, headers=headers)
```

Also change the two older posts (`test_create_run_returns_409_without_export`, `test_create_run_returns_202`) to send `"settings": {"epochs": 10, "batch": 8}` instead of top-level `epochs`/`batch`. Then add:

```python
def test_create_run_stores_the_full_resolved_settings(monkeypatch):
    email = "train-set1@example.com"
    headers = _register_and_login(email)
    session = _session()
    user_id = _user_id(session, email)
    dataset = _make_dataset(session, user_id)
    _succeeded_export(session, dataset.id, user_id)
    _stub_send_task(monkeypatch)
    try:
        response = _create(
            headers, dataset.id, base_model="yolo11n.pt", settings={"epochs": 7, "hsv_h": 0.01}
        )

        assert response.status_code == 202
        run = session.get(TrainingRun, response.json()["id"])
        session.refresh(run)
        assert run.config["epochs"] == 7
        assert run.config["hsv_h"] == 0.01
        assert run.config["batch"] == 8 and run.config["imgsz"] == 640  # defaults included
        assert run.total_epochs == 7
    finally:
        _cleanup(session, dataset.id)
        session.close()


@pytest.mark.parametrize(
    "settings",
    [{"project": "/x"}, {"data": "y"}, {"resume": True}, {"epochs": True}, {"imgsz": 650},
     {"mosaic_typo": 1}, {"erasing": 0.4}],
)
def test_create_run_rejects_invalid_settings(monkeypatch, settings):
    email = "train-set2@example.com"
    headers = _register_and_login(email)
    session = _session()
    user_id = _user_id(session, email)
    dataset = _make_dataset(session, user_id)  # detection: erasing is classification-only
    _succeeded_export(session, dataset.id, user_id)
    sent = _stub_send_task(monkeypatch)
    try:
        response = _create(headers, dataset.id, base_model="yolo11n.pt", settings=settings)

        assert response.status_code == 422
        assert isinstance(response.json()["detail"], str) and response.json()["detail"]
        assert sent == []
        assert session.query(TrainingRun).filter(TrainingRun.dataset_id == dataset.id).count() == 0
    finally:
        _cleanup(session, dataset.id)
        session.close()


def test_create_run_stores_a_trimmed_name_and_note_and_blank_becomes_null(monkeypatch):
    email = "train-set3@example.com"
    headers = _register_and_login(email)
    session = _session()
    user_id = _user_id(session, email)
    dataset = _make_dataset(session, user_id)
    _succeeded_export(session, dataset.id, user_id)
    _stub_send_task(monkeypatch)
    try:
        response = _create(
            headers, dataset.id, base_model="yolo11n.pt", name="  big frames  ", note="try 800px"
        )

        assert response.json()["name"] == "big frames"
        assert response.json()["note"] == "try 800px"
    finally:
        _cleanup(session, dataset.id)
        session.close()


def test_patch_run_updates_and_clears_name_and_note(monkeypatch):
    email = "train-set4@example.com"
    headers = _register_and_login(email)
    session = _session()
    user_id = _user_id(session, email)
    dataset = _make_dataset(session, user_id)
    _succeeded_export(session, dataset.id, user_id)
    _stub_send_task(monkeypatch)
    try:
        run_id = _create(headers, dataset.id, base_model="yolo11n.pt", name="a", note="b").json()["id"]

        renamed = client.patch(f"/training/runs/{run_id}", json={"name": "renamed"}, headers=headers)
        assert renamed.status_code == 200
        assert renamed.json()["name"] == "renamed" and renamed.json()["note"] == "b"  # note untouched

        cleared = client.patch(f"/training/runs/{run_id}", json={"note": None}, headers=headers)
        assert cleared.json()["note"] is None and cleared.json()["name"] == "renamed"

        assert client.patch("/training/runs/99999999", json={"name": "x"}, headers=headers).status_code == 404
    finally:
        _cleanup(session, dataset.id)
        session.close()


def test_settings_schema_matches_the_datasets_task_type():
    email = "train-set5@example.com"
    headers = _register_and_login(email)
    session = _session()
    user_id = _user_id(session, email)
    dataset = _make_dataset(session, user_id)
    other = _make_dataset(session, user_id)
    other.task_type = TaskType.CLASSIFICATION
    session.commit()
    try:
        det = client.get(f"/training/settings-schema?dataset_id={dataset.id}", headers=headers)
        cls = client.get(f"/training/settings-schema?dataset_id={other.id}", headers=headers)

        assert det.status_code == 200
        det_keys = {f["key"] for g in det.json()["groups"] for f in g["fields"]}
        cls_keys = {f["key"] for g in cls.json()["groups"] for f in g["fields"]}
        assert "mosaic" in det_keys and "mosaic" not in cls_keys
        assert "erasing" in cls_keys
        assert [p["id"] for p in det.json()["presets"]][:2] == ["quick_check", "standard"]
        assert client.get("/training/settings-schema?dataset_id=99999999", headers=headers).status_code == 404
    finally:
        _cleanup(session, dataset.id)
        _cleanup(session, other.id)
        session.close()
```

(add `import pytest` at the top of the file if missing.) In `backend/tests/test_training_service.py` rename every `config=...` keyword passed to `service.create_training_run(...)` to `settings=...` (5 call sites). Existing assertions about `run.config`/`total_epochs` keep working because resolved defaults include them.

- [ ] **Step 2: Run to verify failure**

Run: `cd backend && uv run pytest tests/test_training_api.py tests/test_training_service.py -v -k "settings or patch or resolved or trimmed or schema or create"`
Expected: FAIL (unknown `settings` body field is ignored → config lacks `epochs: 7`; `PATCH`/schema routes 404/405; `name` missing from the response).

- [ ] **Step 3: Implement**

`models.py` — in `TrainingRun`, after `base_model_version_id`:

```python
    # Free-form labels the person gives a run so the history stays readable
    # ("why did I run this?"). Never used by the trainer.
    name: Mapped[str | None] = mapped_column(String(200), nullable=True)
    note: Mapped[str | None] = mapped_column(Text, nullable=True)
```

Migration:

```python
# backend/alembic/versions/d5e6f7a8b9c0_add_training_run_name_note.py
"""add training run name and note

Revision ID: d5e6f7a8b9c0
Revises: c4d5e6f7a8b9
Create Date: 2026-10-08 18:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "d5e6f7a8b9c0"
down_revision: Union[str, Sequence[str], None] = "c4d5e6f7a8b9"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column("training_runs", sa.Column("name", sa.String(length=200), nullable=True))
    op.add_column("training_runs", sa.Column("note", sa.Text(), nullable=True))


def downgrade() -> None:
    op.drop_column("training_runs", "note")
    op.drop_column("training_runs", "name")
```

`schemas.py` — replace `TrainingRunCreate`'s `epochs`/`batch`/`imgsz`/`advanced` with the new fields (keep the existing base-model validator and imports), and add the new models:

```python
def _clean_text(value: str | None) -> str | None:
    if value is None:
        return None
    value = value.strip()
    return value or None


class TrainingRunCreate(BaseModel):
    dataset_id: int
    base_model: str | None = Field(default=None, min_length=1, max_length=200)
    base_model_version_id: int | None = None
    name: str | None = Field(default=None, max_length=200)
    note: str | None = Field(default=None, max_length=5000)
    # Validated against the adapter's schema (app.training.params); an unknown
    # key, an out-of-range value or a key the task does not use is a 422.
    settings: dict = Field(default_factory=dict)

    @model_validator(mode="after")
    def _exactly_one_base(self):
        if (self.base_model is None) == (self.base_model_version_id is None):
            raise ValueError("Provide exactly one of base_model and base_model_version_id")
        return self

    @field_validator("name", "note")
    @classmethod
    def _blank_is_none(cls, value: str | None) -> str | None:
        return _clean_text(value)


class TrainingRunUpdate(BaseModel):
    name: str | None = Field(default=None, max_length=200)
    note: str | None = Field(default=None, max_length=5000)

    @field_validator("name", "note")
    @classmethod
    def _blank_is_none(cls, value: str | None) -> str | None:
        return _clean_text(value)


class SettingFieldRead(BaseModel):
    key: str
    label: str
    type: Literal["int", "float", "bool", "choice"]
    default: bool | int | float | str | None
    help: str
    min: float | None
    max: float | None
    step: float | None
    choices: list[str] | None
    optional: bool


class SettingGroupRead(BaseModel):
    id: str
    label: str
    fields: list[SettingFieldRead]


class PresetRead(BaseModel):
    id: str
    label: str
    description: str
    values: dict[str, bool | int | float | str]


class SettingsSchemaRead(BaseModel):
    groups: list[SettingGroupRead]
    presets: list[PresetRead]
```

Add `name: str | None` and `note: str | None` to `TrainingRunRead` (after `base_model_version_id`); add `field_validator` to the pydantic import if missing.

`service.py` — add `from app.training import catalog, params`, then:

```python
def _clean_text(value: str | None) -> str | None:
    if value is None:
        return None
    value = value.strip()
    return value or None


def get_settings_schema(session: Session, dataset_id: int) -> dict:
    dataset = session.get(Dataset, dataset_id)
    if dataset is None:
        raise DatasetNotFound(f"Dataset {dataset_id} not found")
    return params.settings_schema(ADAPTER_NAME, dataset.task_type)


def update_run_meta(session: Session, run_id: int, fields: dict) -> TrainingRun:
    run = get_run(session, run_id)
    for key in ("name", "note"):
        if key in fields:
            setattr(run, key, _clean_text(fields[key]))
    session.commit()
    session.refresh(run)
    return run
```

In `create_training_run`, change the signature to
`(session, *, dataset_id, base_model=None, base_model_version_id=None, settings=None, name=None, note=None, created_by)`, resolve the settings right after the existing base-model resolution (same place the `InvalidBaseModel` checks run), and build the run from the result:

```python
    resolved_settings = params.resolve_settings(ADAPTER_NAME, dataset.task_type, settings)
    ...
    run = TrainingRun(
        dataset_id=dataset_id,
        adapter=ADAPTER_NAME,
        base_model=resolved_base,
        base_model_version_id=parent_id,
        task_type=dataset.task_type,
        config=resolved_settings,
        total_epochs=int(resolved_settings["epochs"]),
        name=_clean_text(name),
        note=_clean_text(note),
        created_by_id=created_by.id,
    )
```

(`params.InvalidSettings` propagates to the router.) `router.py`: import `params`, `TrainingRunUpdate`, `SettingsSchemaRead`; rewrite `create_run`'s call (drop the `config = {...}` block) and add the mappings and routes:

```python
    try:
        return service.create_training_run(
            session,
            dataset_id=body.dataset_id,
            base_model=body.base_model,
            base_model_version_id=body.base_model_version_id,
            settings=body.settings,
            name=body.name,
            note=body.note,
            created_by=current_user,
        )
    except service.DatasetNotExported as exc: ...        # unchanged
    except service.RunAlreadyActive as exc: ...          # unchanged
    except service.InvalidBaseModel as exc: ...          # unchanged (422)
    except params.InvalidSettings as exc:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail=str(exc))


@router.patch("/runs/{run_id}", response_model=TrainingRunRead)
def update_run(
    run_id: int,
    body: TrainingRunUpdate,
    session: Session = Depends(get_session),
):
    try:
        return service.update_run_meta(session, run_id, body.model_dump(exclude_unset=True))
    except service.TrainingRunNotFound as exc:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(exc))


@router.get("/settings-schema", response_model=SettingsSchemaRead)
def settings_schema(
    dataset_id: int = Query(),
    session: Session = Depends(get_session),
):
    try:
        return service.get_settings_schema(session, dataset_id)
    except service.DatasetNotFound as exc:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(exc))
```

Grep for any other caller of `create_training_run` or `TrainingRunCreate` fields (`grep -rn "create_training_run\|advanced\|body.epochs" backend/`) and update them.

- [ ] **Step 4: Run to verify pass, regenerate OpenAPI**

Run: `cd backend && uv run pytest tests/test_training_api.py tests/test_training_service.py tests/test_training_params.py tests/test_training_catalog.py -v` — Expected: PASS (the two known `test_training_models.py` failures excluded).
Run: `cd backend && uv run alembic heads` — Expected: `d5e6f7a8b9c0 (head)`. Do NOT run `alembic upgrade` here (the controller applies it to the dev DB in Task 7).
Run: `cd backend && PYTHONPATH=. uv run python scripts/export_openapi.py && cd .. && git diff --stat openapi.json` — Expected: changed.

- [ ] **Step 5: Commit**

```bash
git add backend openapi.json
git commit -m "feat: settings-based run creation, run name and note, settings schema endpoint

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Worker passes the validated settings to Ultralytics

**Files:**
- Modify: `ml-worker/app/ultralytics_yolo_adapter.py`
- Test: `ml-worker/tests/test_ultralytics_yolo_adapter.py`

**Interfaces:**
- Consumes: `TrainingRequest.config` — the run's full resolved settings (Task 2).
- Produces: `train_kwargs(config: dict) -> dict` (module-level, pure); `model.train(...)` receives every setting except reserved keys, with `cache == "false"` mapped to `False` and `batch`/`imgsz` defaulting to 8/640 when a (legacy) config lacks them.

- [ ] **Step 1: Write the failing tests**

```python
# in ml-worker/tests/test_ultralytics_yolo_adapter.py
from app.ultralytics_yolo_adapter import train_kwargs


def test_train_kwargs_passes_every_setting_through():
    kwargs = train_kwargs({"epochs": 5, "batch": 4, "imgsz": 800, "hsv_h": 0.005, "freeze": 10})

    assert kwargs == {"epochs": 5, "batch": 4, "imgsz": 800, "hsv_h": 0.005, "freeze": 10}


def test_train_kwargs_never_forwards_keys_that_redirect_the_trainer():
    kwargs = train_kwargs(
        {"epochs": 1, "data": "/x", "project": "/y", "name": "n", "exist_ok": False,
         "resume": True, "pretrained": False, "model": "m.pt", "device": "cpu", "save_dir": "/z"}
    )

    assert kwargs == {"epochs": 1, "batch": 8, "imgsz": 640}


def test_train_kwargs_maps_the_cache_string_false_to_a_boolean():
    assert train_kwargs({"cache": "false"})["cache"] is False
    assert train_kwargs({"cache": "ram"})["cache"] == "ram"
    assert train_kwargs({"cache": "disk"})["cache"] == "disk"


def test_train_kwargs_keeps_batch_and_imgsz_defaults_for_a_legacy_config():
    assert train_kwargs({"epochs": 3})["batch"] == 8
    assert train_kwargs({"epochs": 3})["imgsz"] == 640
    assert train_kwargs({"batch": 2, "imgsz": 320})["batch"] == 2
```

Plus one integration test: read how the file's `_make_fake_yolo(...)` builds its fake `train` (it already stands in for `YOLO` in the neighbouring tests), make the fake record the keyword arguments it receives (for example on a class attribute `last_kwargs`), then assert that a request with `config={"epochs": 1, "hsv_h": 0.005, "freeze": 10, "cache": "false"}` reaches `model.train` with `hsv_h=0.005`, `freeze=10`, `cache=False`, `project=str(output_dir)`, `name="run"`, `exist_ok=True` and the dataset `data=` argument, and that no `epochs=`/`batch=`/`imgsz=` key appears twice (a `TypeError: multiple values for keyword argument` would fail the test).

- [ ] **Step 2: Run to verify failure**

Run (docker cp workflow): `docker cp ml-worker/app/. endoscopy-platform-ml-worker-1:/app/app/ && docker cp ml-worker/tests/. endoscopy-platform-ml-worker-1:/app/tests/ && docker compose exec -T ml-worker /app/.venv/bin/python -m pytest tests/test_ultralytics_yolo_adapter.py -v`
Expected: FAIL (`ImportError: cannot import name 'train_kwargs'`).

- [ ] **Step 3: Implement**

Add near `weights_for_task`:

```python
# Keys that would let a stored config redirect the trainer or change where it
# writes. The backend schema never accepts them; refusing them here as well
# means a hand-edited row cannot reach model.train() either.
_RESERVED_TRAIN_KEYS = frozenset(
    {"data", "project", "name", "exist_ok", "resume", "pretrained", "model", "device", "save_dir"}
)


def train_kwargs(config: dict) -> dict:
    """The settings to hand to model.train(), minus anything reserved.

    `cache` is stored as the string "false" (the settings schema is typed,
    and a choice field cannot hold a boolean); Ultralytics wants a real False.
    batch/imgsz keep the defaults a run created before the settings schema
    would have used.
    """
    kwargs = {key: value for key, value in config.items() if key not in _RESERVED_TRAIN_KEYS}
    if kwargs.get("cache") == "false":
        kwargs["cache"] = False
    kwargs.setdefault("batch", 8)
    kwargs.setdefault("imgsz", 640)
    return kwargs
```

In `UltralyticsYoloAdapter.train`, replace the explicit `epochs=...`, `batch=...`, `imgsz=...` arguments in the `model.train(...)` call with `**train_kwargs(request.config),` (keep `data=`, `project=`, `name="run"`, `exist_ok=True` as they are; keep `total_epochs = int(request.config.get("epochs", 1))` — it is only used for the progress callback and must equal the `epochs` Ultralytics receives, which `train_kwargs` guarantees because it forwards `epochs` untouched; a config without `epochs` keeps today's behaviour of failing in Ultralytics with its own default of 100, so also `kwargs.setdefault("epochs", 1)` to keep the two in step).

- [ ] **Step 4: Run to verify pass**

Re-run the Step 2 command, then `... pytest tests/test_ultralytics_yolo_adapter.py tests/test_training_adapter.py tests/test_tasks_training.py -v`.
Expected: PASS. Before and after, compare `docker compose exec -T postgres psql -U endoscopy -t -A -c "select count(*) from training_runs"`: unchanged (these tests must not leave rows).

- [ ] **Step 5: Commit**

```bash
git add ml-worker
git commit -m "feat: forward validated training settings to Ultralytics

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Frontend settings logic and dataset card

**Files:**
- Create: `frontend/src/features/training/settingsLogic.ts`, `settingsLogic.test.ts`, `DatasetCard.tsx`, `DatasetCard.test.tsx`, `testFixtures.ts`

**Interfaces:**
- Consumes: generated types `components["schemas"]["SettingsSchemaRead"]`, `SettingFieldRead` (run `cd frontend && npm run generate-api` first).
- Produces:
  - `type SettingValue = number | boolean | string | null`; `type SettingsValues = Record<string, SettingValue>`
  - `allFields(schema)`, `defaultValues(schema): SettingsValues`, `applyPreset(schema, presetId): SettingsValues` (defaults first, then the preset's values), `isChanged(field, value): boolean`, `changedSettings(schema, values): Record<string, number | boolean | string>`, `validateSettings(schema, values): Record<string, string>`
  - `DatasetOption` (moved here from `TrainConfigForm.tsx` and extended): `{ id, name, exported, taskType, itemCount, splitCounts, classes: { name; instances }[] }`
  - `DatasetCard({ dataset: DatasetOption | null })`
  - `testFixtures.ts`: `settingsSchemaFixture: SettingsSchema` — groups `basic` (epochs 50, batch 8, imgsz 640 step 32), `optimization` (optimizer choice, lr0), `augmentation` (hsv_h 0.015), `finetune` (freeze optional, default null), and presets `quick_check` (`{epochs: 3, batch: 4}`), `standard` (`{}`), `fine_tune` (`{freeze: 10, optimizer: "AdamW", lr0: 0.0005}`)

- [ ] **Step 1: Write the failing tests**

```ts
// settingsLogic.test.ts
import { describe, expect, it } from "vitest";

import {
  allFields,
  applyPreset,
  changedSettings,
  defaultValues,
  isChanged,
  validateSettings,
} from "./settingsLogic";
import { settingsSchemaFixture as schema } from "./testFixtures";

describe("settingsLogic", () => {
  it("starts from the schema defaults, with null for an unset optional field", () => {
    const values = defaultValues(schema);

    expect(values.epochs).toBe(50);
    expect(values.optimizer).toBe("auto");
    expect(values.freeze).toBeNull();
  });

  it("a preset fills its values on top of the defaults, never on top of earlier edits", () => {
    const quick = applyPreset(schema, "quick_check");
    expect(quick.epochs).toBe(3);
    expect(quick.batch).toBe(4);
    expect(quick.imgsz).toBe(640);

    // applying another preset must not keep what the first one set
    const fineTune = applyPreset(schema, "fine_tune");
    expect(fineTune.epochs).toBe(50);
    expect(fineTune.batch).toBe(8);
    expect(fineTune.freeze).toBe(10);
    expect(fineTune.optimizer).toBe("AdamW");
  });

  it("the standard preset restores every default", () => {
    expect(applyPreset(schema, "standard")).toEqual(defaultValues(schema));
  });

  it("an unknown preset id leaves the defaults", () => {
    expect(applyPreset(schema, "nope")).toEqual(defaultValues(schema));
  });

  it("reports only the settings that differ from their defaults", () => {
    const values = { ...defaultValues(schema), epochs: 30, freeze: 10, optimizer: "auto" };

    expect(changedSettings(schema, values)).toEqual({ epochs: 30, freeze: 10 });
  });

  it("an empty optional field is never sent", () => {
    const values = { ...defaultValues(schema), freeze: null };

    expect(changedSettings(schema, values)).toEqual({});
    expect("freeze" in changedSettings(schema, values)).toBe(false);
  });

  it("isChanged compares against the field default, treating null and undefined alike", () => {
    const freeze = allFields(schema).find((f) => f.key === "freeze")!;
    expect(isChanged(freeze, null)).toBe(false);
    expect(isChanged(freeze, 10)).toBe(true);
  });

  it("validates ranges, whole numbers, steps and required fields", () => {
    const base = defaultValues(schema);

    expect(validateSettings(schema, base)).toEqual({});
    expect(validateSettings(schema, { ...base, epochs: 0 }).epochs).toMatch(/at least 1/);
    expect(validateSettings(schema, { ...base, epochs: 1001 }).epochs).toMatch(/at most 1000/);
    expect(validateSettings(schema, { ...base, epochs: 2.5 }).epochs).toMatch(/whole number/);
    expect(validateSettings(schema, { ...base, imgsz: 650 }).imgsz).toMatch(/multiple of 32/);
    expect(validateSettings(schema, { ...base, epochs: null }).epochs).toMatch(/required/i);
    expect(validateSettings(schema, { ...base, freeze: null })).toEqual({});
    expect(validateSettings(schema, { ...base, freeze: -1 }).freeze).toMatch(/at least 0/);
  });
});
```

```tsx
// DatasetCard.test.tsx
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { DatasetCard } from "./DatasetCard";

const dataset = {
  id: 496,
  name: "009",
  exported: true,
  taskType: "detection",
  itemCount: 110,
  splitCounts: { train: 77, val: 22, test: 11 },
  classes: [
    { name: "polyp", instances: 105 },
    { name: "colono_shea", instances: 40 },
  ],
};

describe("DatasetCard", () => {
  it("shows the task, the frame counts per split and every class with its instances", () => {
    render(<DatasetCard dataset={dataset} />);

    expect(screen.getByText(/detection/i)).toBeInTheDocument();
    expect(screen.getByText(/110 frames/i)).toBeInTheDocument();
    expect(screen.getByText(/train 77/i)).toBeInTheDocument();
    expect(screen.getByText(/val 22/i)).toBeInTheDocument();
    expect(screen.getByText(/test 11/i)).toBeInTheDocument();
    expect(screen.getByText("polyp")).toBeInTheDocument();
    expect(screen.getByText("105")).toBeInTheDocument();
  });

  it("warns when the dataset has no export yet", () => {
    render(<DatasetCard dataset={{ ...dataset, exported: false }} />);

    expect(screen.getByRole("status")).toHaveTextContent(/export it on the dataset screen/i);
  });

  it("does not warn for an exported dataset", () => {
    render(<DatasetCard dataset={dataset} />);

    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("says so when the dataset has no classes", () => {
    render(<DatasetCard dataset={{ ...dataset, classes: [] }} />);

    expect(screen.getByText(/no classes/i)).toBeInTheDocument();
  });

  it("renders nothing without a dataset", () => {
    const { container } = render(<DatasetCard dataset={null} />);

    expect(container).toBeEmptyDOMElement();
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd frontend && npm run generate-api && npx vitest run src/features/training/settingsLogic.test.ts src/features/training/DatasetCard.test.tsx`
Expected: FAIL (modules do not exist).

- [ ] **Step 3: Implement**

`testFixtures.ts` (a typed `SettingsSchema` constant; fields carry `key,label,type,default,help,min,max,step,choices,optional` for every entry; groups and presets as described in Interfaces; `help` strings are real sentences, e.g. epochs "Passes over the training set.").

```ts
// settingsLogic.ts
import type { components } from "../../shared/api/generated/schema";

export type SettingsSchema = components["schemas"]["SettingsSchemaRead"];
export type SettingField = components["schemas"]["SettingFieldRead"];
export type SettingValue = number | boolean | string | null;
export type SettingsValues = Record<string, SettingValue>;

export function allFields(schema: SettingsSchema): SettingField[] {
  return schema.groups.flatMap((group) => group.fields);
}

export function defaultValues(schema: SettingsSchema): SettingsValues {
  const values: SettingsValues = {};
  for (const field of allFields(schema)) {
    values[field.key] = field.default ?? null;
  }
  return values;
}

/** A preset is a set of changes against the defaults, so applying one starts
 * from the defaults: nothing a previous preset or a hand edit set can leak in. */
export function applyPreset(schema: SettingsSchema, presetId: string): SettingsValues {
  const values = defaultValues(schema);
  const preset = schema.presets.find((candidate) => candidate.id === presetId);
  if (preset) {
    for (const [key, value] of Object.entries(preset.values)) {
      if (key in values) {
        values[key] = value;
      }
    }
  }
  return values;
}

export function isChanged(field: SettingField, value: SettingValue | undefined): boolean {
  return (value ?? null) !== (field.default ?? null);
}

/** Only what differs from the defaults: smaller request, and the run's stored
 * configuration is completed from the backend's defaults. An empty optional
 * field is left out entirely (never "" or 0). */
export function changedSettings(
  schema: SettingsSchema,
  values: SettingsValues,
): Record<string, number | boolean | string> {
  const changed: Record<string, number | boolean | string> = {};
  for (const field of allFields(schema)) {
    const value = values[field.key];
    if (value !== null && value !== undefined && isChanged(field, value)) {
      changed[field.key] = value;
    }
  }
  return changed;
}

function formatLimit(value: number): string {
  return String(value);
}

export function validateSettings(
  schema: SettingsSchema,
  values: SettingsValues,
): Record<string, string> {
  const errors: Record<string, string> = {};
  for (const field of allFields(schema)) {
    const value = values[field.key] ?? null;
    if (value === null) {
      if (!field.optional) {
        errors[field.key] = "Required";
      }
      continue;
    }
    if (field.type !== "int" && field.type !== "float") {
      continue;
    }
    const number = Number(value);
    if (!Number.isFinite(number)) {
      errors[field.key] = "Must be a number";
    } else if (field.type === "int" && !Number.isInteger(number)) {
      errors[field.key] = "Must be a whole number";
    } else if (field.type === "int" && field.step && field.step > 1 && number % field.step !== 0) {
      errors[field.key] = `Must be a multiple of ${field.step}`;
    } else if (field.min !== null && field.min !== undefined && number < field.min) {
      errors[field.key] = `Must be at least ${formatLimit(field.min)}`;
    } else if (field.max !== null && field.max !== undefined && number > field.max) {
      errors[field.key] = `Must be at most ${formatLimit(field.max)}`;
    }
  }
  return errors;
}
```

```tsx
// DatasetCard.tsx
export interface DatasetOption {
  id: number;
  name: string;
  exported: boolean;
  taskType: string;
  itemCount: number;
  splitCounts: Record<string, number>;
  classes: { name: string; instances: number }[];
}

export function DatasetCard({ dataset }: { dataset: DatasetOption | null }) {
  if (dataset === null) {
    return null;
  }
  const splits = ["train", "val", "test"].filter((split) => split in dataset.splitCounts);
  return (
    <div className="rounded border border-gray-800 bg-gray-950 p-3 text-xs text-gray-300">
      <div className="flex items-center justify-between">
        <span className="rounded bg-gray-800 px-2 py-0.5 text-gray-200">{dataset.taskType}</span>
        <span>{dataset.itemCount} frames</span>
      </div>
      <p className="mt-2 text-gray-400">
        {splits.map((split) => `${split} ${dataset.splitCounts[split]}`).join(" · ")}
      </p>
      <div className="mt-2">
        <p className="mb-1 uppercase tracking-wide text-gray-500">Classes</p>
        {dataset.classes.length === 0 ? (
          <p className="text-gray-500">No classes in this dataset.</p>
        ) : (
          <ul className="max-h-40 overflow-y-auto">
            {dataset.classes.map((entry) => (
              <li key={entry.name} className="flex justify-between gap-2 py-0.5">
                <span className="truncate">{entry.name}</span>
                <span className="text-gray-400">{entry.instances}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
      {!dataset.exported && (
        <p role="status" className="mt-2 rounded border border-yellow-800 bg-yellow-950 px-2 py-1 text-yellow-300">
          This dataset has no export yet. Export it on the Dataset screen before training.
        </p>
      )}
    </div>
  );
}
```

The split line must render each split as one text node such as `train 77` so the test's `getByText(/train 77/i)` matches: render each split in its own `<span>` joined with " · " separators instead of one joined string if the single-string form fails the test (adjust the JSX, not the test).

- [ ] **Step 4: Run to verify pass**

Run: `cd frontend && npx vitest run src/features/training/settingsLogic.test.ts src/features/training/DatasetCard.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/features/training
git commit -m "feat: settings logic and dataset card for the Train form

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Schema-driven settings form

**Files:**
- Create: `frontend/src/features/training/SettingsForm.tsx`, `SettingsForm.test.tsx`

**Interfaces:**
- Consumes: `SettingsSchema`, `SettingsValues`, `SettingValue`, `isChanged`, `allFields` (Task 4).
- Produces: `SettingsForm({ schema, values, errors, onChange(key, value), onReset(key), onApplyPreset(presetId) })`. Groups are `<details>` elements (the `basic` group open, others closed); each field renders `<label htmlFor="setting-<key>">`, the input for its type (number / checkbox / select), a one-line help paragraph, a "changed" marker (`aria-label="changed from default"`) with a Reset button when its value differs from the default, and its validation error. Preset buttons render above the groups with the preset description as `title`.

- [ ] **Step 1: Write the failing tests**

```tsx
// SettingsForm.test.tsx
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { SettingsForm } from "./SettingsForm";
import { defaultValues } from "./settingsLogic";
import { settingsSchemaFixture as schema } from "./testFixtures";

function setup(overrides = {}, errors = {}) {
  const props = {
    schema,
    values: { ...defaultValues(schema), ...overrides },
    errors,
    onChange: vi.fn(),
    onReset: vi.fn(),
    onApplyPreset: vi.fn(),
  };
  render(<SettingsForm {...props} />);
  return props;
}

describe("SettingsForm", () => {
  it("shows the basic group open and the others closed", () => {
    setup();

    expect(screen.getByLabelText("Epochs")).toBeVisible();
    expect(screen.getByLabelText("Batch size")).toBeVisible();
    expect(screen.getByLabelText("Hue shift")).not.toBeVisible();

    const augmentation = screen.getByText("Augmentation").closest("details")!;
    expect(augmentation).not.toHaveAttribute("open");
  });

  it("explains every field in a sentence next to it", () => {
    setup();

    const epochs = screen.getByLabelText("Epochs").closest("div")!;
    expect(within(epochs).getByText(/passes over the training set/i)).toBeInTheDocument();
  });

  it("reports edits with the field key and a numeric value, and empty as null", async () => {
    const user = userEvent.setup();
    const props = setup();

    await user.clear(screen.getByLabelText("Epochs"));
    expect(props.onChange).toHaveBeenLastCalledWith("epochs", null);

    await user.type(screen.getByLabelText("Epochs"), "7");
    expect(props.onChange).toHaveBeenLastCalledWith("epochs", 7);
  });

  it("renders choice fields as a select and reports the chosen option", async () => {
    const user = userEvent.setup();
    const props = setup();
    await user.click(screen.getByText("Optimization"));

    await user.selectOptions(screen.getByLabelText("Optimizer"), "AdamW");

    expect(props.onChange).toHaveBeenLastCalledWith("optimizer", "AdamW");
  });

  it("marks a changed field and resets it", async () => {
    const user = userEvent.setup();
    const props = setup({ epochs: 30 });

    const epochs = screen.getByLabelText("Epochs").closest("div")!;
    expect(within(epochs).getByLabelText("changed from default")).toBeInTheDocument();
    await user.click(within(epochs).getByRole("button", { name: /reset/i }));

    expect(props.onReset).toHaveBeenCalledWith("epochs");
    const batch = screen.getByLabelText("Batch size").closest("div")!;
    expect(within(batch).queryByLabelText("changed from default")).not.toBeInTheDocument();
  });

  it("applies a preset when its button is pressed and shows what it does on hover", async () => {
    const user = userEvent.setup();
    const props = setup();

    const button = screen.getByRole("button", { name: "Quick check" });
    expect(button).toHaveAttribute("title", expect.stringMatching(/\S/));
    await user.click(button);

    expect(props.onApplyPreset).toHaveBeenCalledWith("quick_check");
  });

  it("shows a validation error next to its field and flags the input", () => {
    setup({ epochs: 0 }, { epochs: "Must be at least 1" });

    expect(screen.getByText("Must be at least 1")).toBeInTheDocument();
    expect(screen.getByLabelText("Epochs")).toBeInvalid();
  });

  it("an empty optional field shows as empty, not as zero", async () => {
    const user = userEvent.setup();
    setup();
    await user.click(screen.getByText("Fine-tuning"));

    expect(screen.getByLabelText("Freeze first layers")).toHaveValue(null);
  });

  it("says that the learning rate is ignored with the auto optimizer", async () => {
    const user = userEvent.setup();
    setup();
    await user.click(screen.getByText("Optimization"));

    expect(screen.getByText(/only used with an explicit optimizer/i)).toBeInTheDocument();
  });
});
```

(The last test needs the fixture's `lr0.help` to carry that sentence; put it there.)

- [ ] **Step 2: Run to verify failure**

Run: `cd frontend && npx vitest run src/features/training/SettingsForm.test.tsx`
Expected: FAIL (module missing).

- [ ] **Step 3: Implement**

```tsx
// SettingsForm.tsx
import {
  isChanged,
  type SettingField,
  type SettingsSchema,
  type SettingsValues,
  type SettingValue,
} from "./settingsLogic";

interface SettingsFormProps {
  schema: SettingsSchema;
  values: SettingsValues;
  errors: Record<string, string>;
  onChange: (key: string, value: SettingValue) => void;
  onReset: (key: string) => void;
  onApplyPreset: (presetId: string) => void;
}

const INPUT =
  "rounded border border-gray-700 bg-gray-950 px-2 py-1 text-gray-100 aria-[invalid=true]:border-red-600";

function FieldInput({
  field,
  value,
  invalid,
  onChange,
}: {
  field: SettingField;
  value: SettingValue;
  invalid: boolean;
  onChange: (value: SettingValue) => void;
}) {
  const id = `setting-${field.key}`;
  if (field.type === "bool") {
    return (
      <input
        id={id}
        type="checkbox"
        checked={value === true}
        onChange={(event) => onChange(event.target.checked)}
      />
    );
  }
  if (field.type === "choice") {
    return (
      <select
        id={id}
        className={INPUT}
        value={typeof value === "string" ? value : ""}
        onChange={(event) => onChange(event.target.value)}
      >
        {(field.choices ?? []).map((choice) => (
          <option key={choice} value={choice}>
            {choice}
          </option>
        ))}
      </select>
    );
  }
  return (
    <input
      id={id}
      type="number"
      className={INPUT}
      aria-invalid={invalid}
      min={field.min ?? undefined}
      max={field.max ?? undefined}
      step={field.step ?? (field.type === "float" ? "any" : 1)}
      value={value === null || value === undefined ? "" : String(value)}
      onChange={(event) => onChange(event.target.value === "" ? null : Number(event.target.value))}
    />
  );
}

export function SettingsForm({
  schema,
  values,
  errors,
  onChange,
  onReset,
  onApplyPreset,
}: SettingsFormProps) {
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-1">
        <span className="text-xs uppercase tracking-wide text-gray-400">Presets</span>
        <div className="flex flex-wrap gap-2">
          {schema.presets.map((preset) => (
            <button
              key={preset.id}
              type="button"
              title={preset.description}
              className="rounded border border-gray-700 px-2 py-1 text-xs text-gray-300 hover:text-gray-100"
              onClick={() => onApplyPreset(preset.id)}
            >
              {preset.label}
            </button>
          ))}
        </div>
        <p className="text-xs text-gray-500">
          A preset fills the fields below; you can still change any of them.
        </p>
      </div>

      {schema.groups.map((group) => (
        <details
          key={group.id}
          open={group.id === "basic"}
          className="rounded border border-gray-800 bg-gray-950"
        >
          <summary className="cursor-pointer px-3 py-2 text-sm font-medium text-gray-200">
            {group.label}
          </summary>
          <div className="flex flex-col gap-3 px-3 pb-3">
            {group.fields.map((field) => {
              const value = values[field.key] ?? null;
              const changed = isChanged(field, value);
              const error = errors[field.key];
              return (
                <div key={field.key} className="flex flex-col gap-1">
                  <div className="flex items-center gap-2">
                    <label htmlFor={`setting-${field.key}`} className="text-xs text-gray-300">
                      {field.label}
                    </label>
                    {changed && (
                      <>
                        <span
                          aria-label="changed from default"
                          title="Changed from the default"
                          className="text-blue-400"
                        >
                          ●
                        </span>
                        <button
                          type="button"
                          className="text-xs text-gray-500 hover:text-gray-200"
                          onClick={() => onReset(field.key)}
                        >
                          Reset
                        </button>
                      </>
                    )}
                  </div>
                  <FieldInput
                    field={field}
                    value={value}
                    invalid={Boolean(error)}
                    onChange={(next) => onChange(field.key, next)}
                  />
                  <p className="text-xs text-gray-500">{field.help}</p>
                  {error && <p className="text-xs text-red-300">{error}</p>}
                </div>
              );
            })}
          </div>
        </details>
      ))}
    </div>
  );
}
```

Each field's wrapper is a `div`, so `getByLabelText(...).closest("div")` in the tests resolves to the field block that holds the label, marker, reset and help; if the label row's own `div` makes `closest("div")` land on the wrong element, adjust the test helper to climb to the field block (the outer `div.flex.flex-col`), not the markup's structure.

- [ ] **Step 4: Run to verify pass**

Run: `cd frontend && npx vitest run src/features/training/SettingsForm.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/features/training
git commit -m "feat: schema-driven settings form with presets and per-field help

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 6: New launch form and page wiring

**Files:**
- Create: `frontend/src/features/training/RunSummary.tsx`, `RunSummary.test.tsx`
- Rewrite: `frontend/src/features/training/TrainConfigForm.tsx`
- Modify: `frontend/src/features/training/TrainPage.tsx`
- Update tests: `TrainConfigForm.test.tsx`, `TrainPage.test.tsx`

**Interfaces:**
- Consumes: `SettingsForm`, `DatasetCard`, `DatasetOption`, `SettingsSchema`, `defaultValues`, `applyPreset`, `changedSettings`, `validateSettings`, `allFields`, `isChanged` (Tasks 4–5); `GET /training/settings-schema`; the new `POST /training/runs` body.
- Produces:
  - `TrainConfigValues = { datasetId: number; baseModel: string | null; baseModelVersionId: number | null; name: string; note: string; settings: Record<string, number | boolean | string> }`
  - `TrainConfigForm` props: `datasets: DatasetOption[]`, `disabled`, `onSubmit`, `baseModels?`, `baseModelsError?`, `settingsSchema?: SettingsSchema | null`, `settingsSchemaError?: string | null`, `onDatasetChange?: (id: number) => void`
  - `RunSummary({ datasetName, taskType, baseLabel, changes: {label; value; defaultValue}[] })`

- [ ] **Step 1: Write the failing tests**

```tsx
// RunSummary.test.tsx
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { RunSummary } from "./RunSummary";

describe("RunSummary", () => {
  it("names what will run and lists only the changed settings with their defaults", () => {
    render(
      <RunSummary
        datasetName="009"
        taskType="detection"
        baseLabel="yolo11s.pt"
        changes={[{ label: "Epochs", value: "30", defaultValue: "50" }]}
      />,
    );

    expect(screen.getByText(/what will run/i)).toBeInTheDocument();
    expect(screen.getByText(/009/)).toBeInTheDocument();
    expect(screen.getByText(/yolo11s\.pt/)).toBeInTheDocument();
    expect(screen.getByText("Epochs")).toBeInTheDocument();
    expect(screen.getByText(/30/)).toBeInTheDocument();
    expect(screen.getByText(/default 50/i)).toBeInTheDocument();
  });

  it("says when every setting is at its default", () => {
    render(<RunSummary datasetName="009" taskType="detection" baseLabel="yolo11n.pt" changes={[]} />);

    expect(screen.getByText(/default settings/i)).toBeInTheDocument();
  });
});
```

`TrainConfigForm.test.tsx`: keep the dataset-preselect, manual-choice, not-exported, disabled-while-active, base-model-group, version-submit, hint, reset-on-list-change and error tests, adding `settingsSchema={settingsSchemaFixture}` (and `baseModels` where they had it); datasets in the fixture list become full `DatasetOption`s (`taskType`, `itemCount`, `splitCounts`, `classes`). Replace the epochs/batch/advanced tests with these (and delete the old ones that typed into `/epochs/i` / `/image size/i` behind an Advanced toggle):

```tsx
  it("submits the dataset, base, name, note and only the changed settings", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    render(
      <TrainConfigForm
        datasets={datasets}
        disabled={false}
        onSubmit={onSubmit}
        baseModels={baseModels}
        settingsSchema={settingsSchemaFixture}
      />,
    );

    await user.type(screen.getByLabelText(/run name/i), "  big frames ");
    await user.type(screen.getByLabelText(/note/i), "try 800 px");
    await user.clear(screen.getByLabelText("Epochs"));
    await user.type(screen.getByLabelText("Epochs"), "25");
    await user.click(screen.getByRole("button", { name: /start training/i }));

    expect(onSubmit).toHaveBeenCalledWith({
      datasetId: 1,
      baseModel: "yolo11n.pt",
      baseModelVersionId: null,
      name: "big frames",
      note: "try 800 px",
      settings: { epochs: 25 },
    });
  });

  it("a preset fills the fields and replaces earlier edits", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    render(
      <TrainConfigForm datasets={datasets} disabled={false} onSubmit={onSubmit}
        baseModels={baseModels} settingsSchema={settingsSchemaFixture} />,
    );

    await user.clear(screen.getByLabelText("Epochs"));
    await user.type(screen.getByLabelText("Epochs"), "99");
    await user.click(screen.getByRole("button", { name: "Quick check" }));

    expect(screen.getByLabelText("Epochs")).toHaveValue(3);
    expect(screen.getByLabelText("Batch size")).toHaveValue(4);
    await user.click(screen.getByRole("button", { name: /start training/i }));
    expect(onSubmit).toHaveBeenCalledWith(
      expect.objectContaining({ settings: { epochs: 3, batch: 4 } }),
    );
  });

  it("an empty optional field is not sent", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    render(
      <TrainConfigForm datasets={datasets} disabled={false} onSubmit={onSubmit}
        baseModels={baseModels} settingsSchema={settingsSchemaFixture} />,
    );
    await user.click(screen.getByText("Fine-tuning"));
    await user.type(screen.getByLabelText("Freeze first layers"), "10");
    await user.clear(screen.getByLabelText("Freeze first layers"));
    await user.click(screen.getByRole("button", { name: /start training/i }));

    const sent = onSubmit.mock.calls[0][0];
    expect("freeze" in sent.settings).toBe(false);
  });

  it("blocks starting while a setting is invalid", async () => {
    const user = userEvent.setup();
    render(
      <TrainConfigForm datasets={datasets} disabled={false} onSubmit={vi.fn()}
        baseModels={baseModels} settingsSchema={settingsSchemaFixture} />,
    );

    await user.clear(screen.getByLabelText("Epochs"));
    await user.type(screen.getByLabelText("Epochs"), "0");

    expect(screen.getByRole("button", { name: /start training/i })).toBeDisabled();
    expect(screen.getByText(/at least 1/i)).toBeInTheDocument();
  });

  it("resets the settings when the schema changes with the dataset's task type", async () => {
    const user = userEvent.setup();
    const { rerender } = render(
      <TrainConfigForm datasets={datasets} disabled={false} onSubmit={vi.fn()}
        baseModels={baseModels} settingsSchema={settingsSchemaFixture} />,
    );
    await user.clear(screen.getByLabelText("Epochs"));
    await user.type(screen.getByLabelText("Epochs"), "7");

    rerender(
      <TrainConfigForm datasets={datasets} disabled={false} onSubmit={vi.fn()}
        baseModels={baseModels} settingsSchema={{ ...settingsSchemaFixture }} />,
    );

    expect(screen.getByLabelText("Epochs")).toHaveValue(50);
  });

  it("lists the changes in the 'what will run' panel and shows the dataset card", async () => {
    const user = userEvent.setup();
    render(
      <TrainConfigForm datasets={datasets} disabled={false} onSubmit={vi.fn()}
        baseModels={baseModels} settingsSchema={settingsSchemaFixture} />,
    );

    await user.clear(screen.getByLabelText("Epochs"));
    await user.type(screen.getByLabelText("Epochs"), "25");

    const summary = screen.getByText(/what will run/i).closest("section")!;
    expect(within(summary).getByText("Epochs")).toBeInTheDocument();
    expect(screen.getByText(/110 frames/i)).toBeInTheDocument();
  });

  it("shows an error and keeps Start disabled when the settings schema failed to load", () => {
    render(
      <TrainConfigForm datasets={datasets} disabled={false} onSubmit={vi.fn()}
        baseModels={baseModels} settingsSchemaError="Could not load training settings." />,
    );

    expect(screen.getByText("Could not load training settings.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /start training/i })).toBeDisabled();
  });
```

(the "resets on schema change" test relies on the form resetting when the `settingsSchema` prop identity changes; update the Task-5-era fixtures in this file to `DatasetOption` shape.)

`TrainPage.test.tsx`: every `apiClient.GET` mock gains a branch for `"/training/settings-schema"` returning `{ data: settingsSchemaFixture }`; the two existing "posts base_model only / base_model_version_id only" tests expect a body of `{ dataset_id, base_model | base_model_version_id, settings: {} }` (no `epochs`/`batch`/`imgsz`/`advanced`, and no `name`/`note` keys when blank). Add:

- the settings-schema request is made with `query: { dataset_id: 1 }` when the form announces dataset 1;
- changed settings reach the POST body (`settings: { epochs: 25 }`) together with `name` and `note` when typed;
- an out-of-order pair of `/training/settings-schema` responses (second dataset resolves first, then the first) leaves the second dataset's schema on screen;
- a rejected/failed schema request shows "Could not load training settings." and keeps Start disabled;
- the dataset options carry the new card data: selecting a dataset renders its card (`getByText(/110 frames/)`), built from `/datasets` rows that include `task_type`, `item_count`, `split_counts` and `balance_metrics.classes`.

- [ ] **Step 2: Run to verify failure**

Run: `cd frontend && npx vitest run src/features/training/RunSummary.test.tsx src/features/training/TrainConfigForm.test.tsx src/features/training/TrainPage.test.tsx`
Expected: FAIL.

- [ ] **Step 3: Implement**

`RunSummary.tsx`:

```tsx
interface Change {
  label: string;
  value: string;
  defaultValue: string;
}

interface RunSummaryProps {
  datasetName: string;
  taskType: string;
  baseLabel: string;
  changes: Change[];
}

export function RunSummary({ datasetName, taskType, baseLabel, changes }: RunSummaryProps) {
  return (
    <section className="rounded border border-gray-800 bg-gray-950 p-3 text-xs text-gray-300">
      <h3 className="mb-2 text-sm font-medium text-gray-200">What will run</h3>
      <p>
        {taskType} on <span className="text-gray-100">{datasetName}</span>, starting from{" "}
        <span className="text-gray-100">{baseLabel}</span>
      </p>
      {changes.length === 0 ? (
        <p className="mt-2 text-gray-500">Default settings.</p>
      ) : (
        <ul className="mt-2 flex flex-col gap-0.5">
          {changes.map((change) => (
            <li key={change.label} className="flex justify-between gap-2">
              <span>{change.label}</span>
              <span>
                {change.value} <span className="text-gray-500">(default {change.defaultValue})</span>
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
```

`TrainConfigForm.tsx` — rewrite on top of the current file (keep: the dataset-preselect effect, the `onDatasetChange` effect, `keyOf`/`optionText`, base-model `<select>` with its groups, the hint and the error line, the `disabled` start behaviour). Changes:

- import `DatasetOption`, `DatasetCard` from `./DatasetCard` and re-export the type (`export type { DatasetOption } from "./DatasetCard"`) so `TrainPage` and tests keep importing it from here; delete the local `DatasetOption`, the `epochs`/`batch`/`imgsz`/`advancedOpen` state and their three inputs.
- new props `settingsSchema = null`, `settingsSchemaError = null`.
- state: `values: SettingsValues`, `name`, `note`. `useEffect(() => { if (settingsSchema) setValues(defaultValues(settingsSchema)); }, [settingsSchema])` — the page passes a new object only when a new schema arrives, so edits survive unrelated re-renders.
- derived: `errors = settingsSchema ? validateSettings(settingsSchema, values) : {}`; `changes` = for each changed field `{label: field.label, value: String(values[key]), defaultValue: field.default === null ? "none" : String(field.default)}`; `selectedDataset = datasets.find(d => d.id === datasetId) ?? null`; `baseLabel` = text of the selected base option.
- layout: Dataset `<select>` (option text `${name} · ${taskType} · ${itemCount} frames`, not-exported ones still disabled with " — export it first"), then `<DatasetCard dataset={selectedDataset} />`, Base model block (unchanged), Run name `<input id="train-name" maxLength={200}>` labelled "Run name (optional)", Note `<textarea id="train-note" maxLength={5000}>` labelled "Note (optional)", then — if `settingsSchema` — `<SettingsForm …/>` with `onChange={(key, value) => setValues(v => ({ ...v, [key]: value }))}`, `onReset={(key) => setValues(v => ({ ...v, [key]: default of that field }))}`, `onApplyPreset={(id) => setValues(applyPreset(settingsSchema, id))}`; else the `settingsSchemaError` text (red) or "Loading settings…". Then `<RunSummary …/>` and the Start button (`type="submit"`, disabled when `disabled || datasetId === "" || baseKey === "" || !settingsSchema || Object.keys(errors).length > 0`).
- `handleSubmit`: as today plus `name: name.trim()`, `note: note.trim()`, `settings: changedSettings(settingsSchema, values)`; return early when `settingsSchema` is null.

`TrainPage.tsx`:

- `refreshDatasets` maps `taskType: dataset.task_type`, `itemCount: dataset.item_count`, `splitCounts: dataset.split_counts`, `classes: ((dataset.balance_metrics as { classes?: { name: string; instances: number }[] }).classes ?? []).map(({ name, instances }) => ({ name, instances }))`.
- add state `settingsSchema: SettingsSchema | null` and `settingsSchemaError: string | null`, a request counter ref and `loadSettingsSchema` shaped exactly like `loadBaseModels` (clear schema and error first; newest response wins; failure or thrown fetch sets `"Could not load training settings."`; the endpoint is `GET /training/settings-schema` with `params: { query: { dataset_id } }`).
- `const handleDatasetChange = useCallback((datasetId: number) => { loadBaseModels(datasetId); loadSettingsSchema(datasetId); }, [loadBaseModels, loadSettingsSchema]);` passed as `onDatasetChange`; pass `settingsSchema` and `settingsSchemaError` too.
- `handleSubmit` body: `{ dataset_id, ...(version ? { base_model_version_id } : { base_model }), ...(values.name ? { name: values.name } : {}), ...(values.note ? { note: values.note } : {}), settings: values.settings }`.
- layout: the form column was one third of the grid; the form is now much longer. Change `grid-cols-3` to `grid-cols-5`, the form column to `col-span-2`, and the right column from `col-span-2` to `col-span-3`. Plan 2 replaces this shell.

- [ ] **Step 4: Run to verify pass**

Run: `cd frontend && npx vitest run src/features/training && npx tsc -p tsconfig.app.json --noEmit 2>&1 | grep -v TS2339 | grep features/training`
Expected: all training tests PASS; no type errors under `features/training` other than the pre-existing jest-dom matcher ones.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/features/training
git commit -m "feat: new launch form with explained settings, presets, run name and note

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 7: Live verification and ROADMAP

No new code unless the live pass finds a defect (then use superpowers:systematic-debugging, fix test-first, log it as a deviation). Controller-executed; the user has authorised migrations, an `ml-worker` rebuild and short GPU runs for this phase's predecessor, but **ask again before touching services or the real DB**, since approval does not carry over.

- [ ] **Step 1: Deploy.** Ask first. Apply the migration (`cd backend && uv run alembic upgrade head`; `alembic current` must show `d5e6f7a8b9c0`). Rebuild and recreate `ml-worker` (`docker compose build ml-worker && docker compose up -d ml-worker`) and confirm `grep -c train_kwargs /app/app/ultralytics_yolo_adapter.py` inside it. The backend dev server auto-reloads; confirm `/openapi.json` lists `/training/settings-schema`. Do not touch :5173/:5174.
- [ ] **Step 2: Back up before creating rows** (scratchpad): `training_runs`, `model_versions` as CSV, `MODEL_TRAIN` job count and max id, the `models/` MinIO listing.
- [ ] **Step 3: Drive the form in a real browser** (`manualcheck@example.com` / `manual-check-pass`) for a detection, a segmentation and a classification dataset: the Dataset select shows task and frame counts; the card shows splits, classes and the missing-export warning; each task's form shows only its own fields (no `mosaic` on classification, `copy_paste` only on segmentation); every field has help text; presets fill the fields and replace earlier edits; reset and the changed marker work; invalid input disables Start; switching dataset resets the form. Take a screenshot of the new form and read it as an image to judge layout against the spec's sizing rules (no stretched or tiny blocks), then delete the screenshot file.
- [ ] **Step 4: Real short runs, size `n` only.** Two runs through the UI: one with the "Quick check" preset on a detection dataset, and one classification run with a changed augmentation setting (for example `hsv_h` and an explicit `AdamW` with `lr0`). For each, read the run's `config` from the database (full resolved settings, not just the changed ones), and read Ultralytics' printed arguments in `log_text`: the changed values (`hsv_h=…`, `optimizer=AdamW`, `lr0=…`, `cache=False`) must appear. Confirm the run's `name`/`note` were stored.
- [ ] **Step 5: Clean up unprompted** (versions through the API, then the runs and jobs by precise predicate, then MinIO prefixes `models/<run id>/`), and compare the tables against the Step 2 backup.
- [ ] **Step 6: ROADMAP.** Add "Phase 2b: Train workspace, plan 1 (launch) — DONE (date)" with the spec and plan links, the commit range, what Steps 3–5 actually verified, every deviation found, and the open items (`optimizer: auto` ignoring `lr0` is confirmed in `engine/trainer.py`; the log cleaning and the carriage-return question belong to Plan 2; the preset numbers are still guesses; the old page shell is intentionally intermediate).
- [ ] **Step 7: Commit** `docs: record Train workspace plan 1`.

---

## Self-Review

- **Spec coverage:** settings schema with groups, fields, defaults and help (Task 1); presets as data, filtered per task (Task 1); validation including the forbidden keys (Tasks 1–2); `name`/`note`, `PATCH`, new `POST` body, `GET /settings-schema` (Task 2); worker pass-through, `cache`, reserved keys (Task 3); dataset card and the Dataset select text (Tasks 4, 6); schema-driven form with changed markers, reset, preset buttons, inline errors, help text, collapsed groups (Task 5); "What will run" panel, name/note fields, Start gating, only-changed settings sent (Task 6); live verification, cleanup and ROADMAP (Task 7). Plans 2 and 3 items (runs table, run details, compare, live curve, log cleaning, run delete, copy of per-class/confusion onto runs, URL state, `GET /training/runs` filters) are intentionally absent.
- **Placeholder scan:** none; the two places where code depends on what the neighbouring test file already contains (`_make_fake_yolo` recording kwargs, `closest("div")` field-block lookup) are called out with the exact behaviour to achieve.
- **Type consistency:** `resolve_settings`/`settings_schema` names and shapes match across Tasks 1, 2 and the Pydantic read models; `SettingValue`/`SettingsValues`/`DatasetOption`/`TrainConfigValues` agree across Tasks 4–6; the request body keys (`settings`, `name`, `note`, `base_model | base_model_version_id`) match Task 2's `TrainingRunCreate`.
