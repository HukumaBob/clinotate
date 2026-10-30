import pytest

import app.main  # noqa: F401 -- registers every model on Base.metadata
from app.datasets.models import TaskType
from app.training import catalog


@pytest.mark.parametrize(
    "task_type, suffix",
    [
        (TaskType.DETECTION, ""),
        (TaskType.SEGMENTATION, "-seg"),
        (TaskType.CLASSIFICATION, "-cls"),
    ],
)
def test_five_sizes_with_the_task_suffix(task_type, suffix):
    models = catalog.pretrained_models(catalog.ADAPTER_NAME, task_type)

    assert [m.weights for m in models] == [
        f"yolo11{size}{suffix}.pt" for size in ("n", "s", "m", "l", "x")
    ]
    assert {m.family for m in models} == {"yolo11"}
    assert [m.size for m in models] == ["n", "s", "m", "l", "x"]


def test_only_l_and_x_carry_the_vram_note():
    models = catalog.pretrained_models(catalog.ADAPTER_NAME, TaskType.DETECTION)

    notes = {m.size: m.note for m in models}
    assert notes == {
        "n": None,
        "s": None,
        "m": None,
        "l": catalog.VRAM_NOTE,
        "x": catalog.VRAM_NOTE,
    }
    assert catalog.VRAM_NOTE == "may not fit in 8 GB"


def test_unknown_adapter_has_no_models():
    assert catalog.pretrained_models("no_such_adapter", TaskType.DETECTION) == []


def test_resolve_accepts_the_exact_catalog_name():
    assert (
        catalog.resolve_pretrained(catalog.ADAPTER_NAME, TaskType.SEGMENTATION, "yolo11m-seg.pt")
        == "yolo11m-seg.pt"
    )


def test_resolve_normalises_the_legacy_unsuffixed_name():
    assert (
        catalog.resolve_pretrained(catalog.ADAPTER_NAME, TaskType.SEGMENTATION, "yolo11s.pt")
        == "yolo11s-seg.pt"
    )
    assert (
        catalog.resolve_pretrained(catalog.ADAPTER_NAME, TaskType.CLASSIFICATION, "yolo11n.pt")
        == "yolo11n-cls.pt"
    )


@pytest.mark.parametrize(
    "task_type, name",
    [
        (TaskType.DETECTION, "yolo11n-seg.pt"),  # wrong task suffix
        (TaskType.SEGMENTATION, "yolo11n-cls.pt"),
        (TaskType.DETECTION, "yolov8n.pt"),  # other family
        (TaskType.DETECTION, "../../etc/passwd"),
        (TaskType.DETECTION, ""),
    ],
)
def test_resolve_rejects_anything_not_in_the_catalog(task_type, name):
    assert catalog.resolve_pretrained(catalog.ADAPTER_NAME, task_type, name) is None


def test_adapters_for_detection_lists_both():
    options = catalog.adapters_for(TaskType.DETECTION)

    assert options == [
        {"id": "ultralytics_yolo", "label": "YOLO11", "supported": True},
        {"id": "dinov3_classifier", "label": "DINOv3 crop classifier", "supported": True},
    ]


def test_adapters_for_classification_marks_dinov3_unsupported():
    options = {o["id"]: o["supported"] for o in catalog.adapters_for(TaskType.CLASSIFICATION)}

    assert options == {"ultralytics_yolo": True, "dinov3_classifier": False}


def test_adapter_name_alias_is_the_yolo_adapter():
    assert catalog.ADAPTER_NAME == catalog.YOLO_ADAPTER == "ultralytics_yolo"


def test_dinov3_catalog_lists_s_b_l_with_vram_note_on_l():
    for task in (TaskType.DETECTION, TaskType.SEGMENTATION):
        models = catalog.pretrained_models(catalog.DINOV3_ADAPTER, task)
        assert [m.weights for m in models] == [
            "facebook/dinov3-vitb16-pretrain-lvd1689m",
            "facebook/dinov3-vits16-pretrain-lvd1689m",
            "facebook/dinov3-vitl16-pretrain-lvd1689m",
        ]
        assert {m.family for m in models} == {"dinov3"}
        assert {m.size: m.note for m in models} == {
            "b": None,
            "s": None,
            "l": catalog.VRAM_NOTE,
        }


def test_dinov3_catalog_empty_for_classification():
    assert catalog.pretrained_models(catalog.DINOV3_ADAPTER, TaskType.CLASSIFICATION) == []
