import app.main  # noqa: F401 -- registers every model on Base.metadata for create_all
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


@pytest.mark.parametrize(
    "raw",
    [
        {"epochs": 10**400},
        {"epochs": -(10**400)},
        {"lr0": 10**400},
        {"lr0": -(10**400)},
        {"imgsz": 10**400},
    ],
)
def test_huge_integers_are_rejected_not_overflowed(raw):
    with pytest.raises(params.InvalidSettings):
        params.resolve_settings(ADAPTER, DET, raw)


def test_large_but_valid_integer_still_resolves():
    assert params.resolve_settings(ADAPTER, DET, {"seed": 2147483647})["seed"] == 2147483647
