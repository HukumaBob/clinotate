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
