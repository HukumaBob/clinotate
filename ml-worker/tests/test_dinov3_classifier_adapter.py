"""Pure tests for the DINOv3 crop-classifier adapter: no DB, no network, CPU only.

The backbone is the tiny stand-in from test_dinov3_model (same attribute
layout as DINOv3ViTModel), injected through the adapter's _load_backbone seam.
"""

import json
from pathlib import Path

import cv2
import numpy as np
import pytest
import torch

import app.dinov3_classifier_adapter as adapter_module
from app.classifier_metrics import confusion_matrix, summarize
from app.dinov3_classifier_adapter import DEFAULTS, Dinov3ClassifierAdapter
from app.dinov3_crops import crop_region, load_samples, read_rgb
from app.dinov3_model import CropClassifier, load_trained_state, to_tensor
from app.training_adapter import TrainingRequest
from test_dinov3_model import FakeBackbone  # tests/ is on sys.path (rootdir-prepend)

COLOURS = [(220, 30, 30), (30, 220, 30), (30, 30, 220)]
NAMES = ["adenoma", "hyperplastic", "serrated"]


def _write_dataset(root: Path, counts: dict, *, cat_ids=(1, 2, 3), colours=COLOURS,
                   jitter=0, seed=0) -> Path:
    """counts = {"train": [n_class0, n_class1, ...], "val": [...]}; one image per region."""
    rng = np.random.default_rng(seed)
    images, anns = [], []
    for split, per_class in counts.items():
        (root / "images" / split).mkdir(parents=True, exist_ok=True)
        for cls, n in enumerate(per_class):
            for k in range(n):
                img = np.full((48, 48, 3), 128, dtype=np.uint8)
                colour = np.array(colours[cls], dtype=np.int64)
                if jitter:
                    colour = colour + rng.integers(-jitter, jitter + 1, size=3)
                img[8:40, 8:40] = np.clip(colour, 0, 255).astype(np.uint8)
                name = f"{split}_{cls}_{k}.png"
                cv2.imwrite(str(root / "images" / split / name), cv2.cvtColor(img, cv2.COLOR_RGB2BGR))
                image_id = len(images) + 1
                images.append({"id": image_id, "file_name": name, "split": split,
                               "width": 48, "height": 48})
                anns.append({"id": len(anns) + 1, "image_id": image_id,
                             "category_id": cat_ids[cls], "bbox": [8, 8, 32, 32],
                             "segmentation": [[8, 8, 40, 8, 40, 40, 8, 40]]})
    cats = [{"id": cid, "name": NAMES[i]} for i, cid in enumerate(cat_ids)]
    (root / "annotations.json").write_text(
        json.dumps({"images": images, "annotations": anns, "categories": cats}))
    return root


BASE = {"backbone": "stub", "workers": 0, "imgsz": 32, "batch": 8, "lr": 0.05,
        "epochs": 15}


@pytest.fixture
def backbone(monkeypatch):
    torch.manual_seed(123)
    bb = FakeBackbone()
    monkeypatch.setattr(adapter_module, "_load_backbone", lambda hub_id: bb)
    monkeypatch.setattr(adapter_module, "_device", lambda: torch.device("cpu"))
    return bb


@pytest.fixture
def dataset(tmp_path):
    return _write_dataset(tmp_path / "ds", {"train": [4, 4, 4], "val": [3, 3, 3]})


def _run(dataset_dir, tmp_path, config=None, *, base_model="stub", should_stop=None,
         sub="out"):
    out = tmp_path / sub
    out.mkdir(exist_ok=True)
    logs, epochs = [], []
    req = TrainingRequest(dataset_dir=dataset_dir, task_type="classification",
                          base_model=base_model, config={**BASE, **(config or {})},
                          output_dir=out)
    result = Dinov3ClassifierAdapter().train(
        req, logs.append, lambda e, t, m: epochs.append((e, t, m)),
        should_stop or (lambda: False))
    return result, logs, epochs


def _val_macro_f1(backbone, weights_path, dataset_dir, imgsz=32):
    return _reevaluate(backbone, weights_path, dataset_dir, imgsz)[0]


def _reevaluate(backbone, weights_path, dataset_dir, imgsz=32):
    """(val macro-F1, mean val CE loss) of a checkpoint loaded onto ``backbone``."""
    samples, names = load_samples(dataset_dir, lambda m: None)
    model = CropClassifier(backbone, len(names))
    load_trained_state(model, weights_path)
    model.eval()
    val = [s for s in samples if s.split == "val"]
    x = torch.stack([to_tensor(crop_region(read_rgb(s.image_path), s.bbox, s.polygon,
                                           margin=0.15, mask_mode="none", imgsz=imgsz))
                     for s in val])
    y = torch.tensor([s.class_id for s in val])
    with torch.no_grad():
        logits = model(x)
    loss = torch.nn.functional.cross_entropy(logits, y).item()
    cm = confusion_matrix(y.numpy(), logits.argmax(1).numpy(), len(names))
    return summarize(cm, names).macro_f1, loss


def test_frozen_run_learns_separable_classes(backbone, dataset, tmp_path):
    result, _, epochs = _run(dataset, tmp_path)
    assert len(epochs) <= 15
    assert result.metrics["val/macro_f1"] >= 0.9
    assert result.weights_path.is_file()


def test_on_epoch_called_with_trainer_keys_each_epoch(backbone, dataset, tmp_path):
    result, logs, epochs = _run(dataset, tmp_path, {"epochs": 3})
    assert [(e, t) for e, t, _ in epochs] == [(1, 3), (2, 3), (3, 3)]
    keys = {"train/loss", "val/loss", "val/macro_f1", "val/balanced_accuracy", "val/accuracy"}
    for _, _, m in epochs:
        assert set(m) == keys
        assert all(type(v) is float for v in m.values())
    # Result is JSON-serialisable plain Python.
    json.dumps([result.metrics, result.per_class, result.confusion, result.class_names])
    assert set(result.metrics) == {"val/macro_f1", "val/balanced_accuracy", "val/accuracy",
                                   "best_epoch"}
    assert type(result.metrics["best_epoch"]) is int
    assert all(type(result.metrics[k]) is float for k in keys - {"train/loss", "val/loss"})
    assert result.history == []
    assert result.artifacts == [tmp_path / "out" / "metrics.json"]
    doc = json.loads(result.artifacts[0].read_text())
    assert len(doc["history"]) == 3 and doc["metrics"] == result.metrics
    assert sum("macro-F1" in line for line in logs) >= 3
    assert any("trainable parameters" in line for line in logs)


def test_best_checkpoint_is_the_best_val_macro_f1_epoch(backbone, dataset, tmp_path):
    result, _, epochs = _run(dataset, tmp_path, {"epochs": 8, "lr": 0.01, "patience": 100})
    f1s = [m["val/macro_f1"] for _, _, m in epochs]
    best = int(np.argmax(f1s)) + 1  # argmax = earliest on ties
    assert result.metrics["best_epoch"] == best
    assert result.metrics["val/macro_f1"] == f1s[best - 1]
    assert result.weights_path == tmp_path / "out" / "best.pt"
    assert _val_macro_f1(backbone, result.weights_path, dataset) == pytest.approx(f1s[best - 1])


def test_should_stop_ends_run_at_epoch_boundary_with_weights(backbone, dataset, tmp_path):
    calls = []

    def should_stop():
        calls.append(1)
        return len(calls) >= 2

    result, _, epochs = _run(dataset, tmp_path, {"epochs": 10}, should_stop=should_stop)
    assert len(epochs) == 2
    assert result.weights_path.is_file()
    assert 1 <= result.metrics["best_epoch"] <= 2


def test_early_stopping_by_patience(backbone, dataset, tmp_path):
    # lr=0: nothing improves after epoch 1, so patience=2 stops at epoch 3.
    result, _, epochs = _run(dataset, tmp_path, {"epochs": 30, "lr": 0.0, "patience": 2})
    assert len(epochs) == 3
    assert result.metrics["best_epoch"] == 1


def test_partial_mode_updates_only_unfrozen_parameters(backbone, dataset, tmp_path):
    before = {k: v.clone() for k, v in backbone.state_dict().items()}
    result, logs, _ = _run(dataset, tmp_path, {"mode": "partial", "unfreeze_blocks": 2,
                                               "epochs": 2, "backbone_lr": 0.01})
    after = backbone.state_dict()
    unfrozen = ("model.layer.2.", "model.layer.3.", "norm.")
    for k, v in before.items():
        if k.startswith(unfrozen):
            continue
        assert torch.equal(v, after[k]), f"frozen parameter {k} changed"
    assert any(not torch.equal(before[k], after[k]) for k in before
               if k.startswith(("model.layer.2.", "model.layer.3.")))
    state = torch.load(result.weights_path, map_location="cpu", weights_only=True)["trained_state"]
    assert any(k.startswith("backbone.model.layer.3.") for k in state)
    assert not any(k.startswith("backbone.model.layer.1.") for k in state)


def _minority_recall(tmp_path, backbone_seed, balance, sub):
    ds = _write_dataset(tmp_path / f"imb{backbone_seed}",
                        {"train": [40, 4], "val": [10, 10]}, cat_ids=(1, 2),
                        colours=[(150, 120, 110), (170, 110, 120)], jitter=25,
                        seed=backbone_seed)
    result, _, _ = _run(ds, tmp_path, {"class_balance": balance, "epochs": 10,
                                       "patience": 100, "seed": backbone_seed}, sub=sub)
    return result.per_class[1]["recall"]


def test_weighted_loss_vs_none_changes_minority_recall(backbone, tmp_path):
    seeds = (0, 1, 2)
    weighted = [_minority_recall(tmp_path, s, "weighted_loss", f"w{s}") for s in seeds]
    plain = [_minority_recall(tmp_path, s, "none", f"n{s}") for s in seeds]
    # Averaged over 3 seeds to stay robust; observed ~0.6-0.8 vs ~0.0-0.2.
    assert np.mean(weighted) > np.mean(plain)


def test_balanced_sampler_runs(backbone, dataset, tmp_path):
    result, _, _ = _run(dataset, tmp_path, {"class_balance": "balanced_sampler"})
    assert result.metrics["val/macro_f1"] >= 0.9


def test_class_without_val_samples_is_logged_and_excluded_from_macro(backbone, tmp_path):
    ds = _write_dataset(tmp_path / "ds", {"train": [4, 4, 4], "val": [3, 3, 0]})
    result, logs, _ = _run(ds, tmp_path)
    absent_lines = [line for line in logs if "serrated" in line and "validation" in line]
    assert len(absent_lines) == 1
    rows = {r["class"]: r for r in result.per_class}
    assert rows["serrated"]["support"] == 0
    present = [rows["adenoma"]["f1"], rows["hyperplastic"]["f1"]]
    assert result.metrics["val/macro_f1"] == pytest.approx(sum(present) / 2)


def test_class_without_train_samples_is_logged(backbone, tmp_path):
    ds = _write_dataset(tmp_path / "ds", {"train": [4, 4, 0], "val": [3, 3, 3]})
    _, logs, _ = _run(ds, tmp_path, {"epochs": 2})
    assert any("serrated" in line and "training" in line for line in logs)


def test_no_regions_raises_readable_error(backbone, tmp_path):
    ds = _write_dataset(tmp_path / "ds", {"train": [0, 0, 0]})
    with pytest.raises(RuntimeError, match="No usable regions in the dataset: "):
        _run(ds, tmp_path)


def test_no_regions_error_mentions_skipped_summary(backbone, tmp_path):
    ds = _write_dataset(tmp_path / "ds", {"train": [2, 0, 0]})
    doc = json.loads((ds / "annotations.json").read_text())
    for ann in doc["annotations"]:
        ann["bbox"] = [8, 8, 0, 0]
    (ds / "annotations.json").write_text(json.dumps(doc))
    with pytest.raises(RuntimeError, match="No usable regions in the dataset: .*empty box"):
        _run(ds, tmp_path)


def test_missing_val_split_raises_readable_error(backbone, tmp_path):
    ds = _write_dataset(tmp_path / "ds", {"train": [3, 3, 3]})
    with pytest.raises(RuntimeError, match="no validation split"):
        _run(ds, tmp_path)


def test_missing_train_split_raises_readable_error(backbone, tmp_path):
    ds = _write_dataset(tmp_path / "ds", {"val": [3, 3, 3]})
    with pytest.raises(RuntimeError, match="no training split"):
        _run(ds, tmp_path)


def test_single_class_dataset_raises_instead_of_scoring_a_perfect_one(backbone, tmp_path):
    ds = _write_dataset(tmp_path / "ds", {"train": [4], "val": [3]}, cat_ids=(1,))
    with pytest.raises(RuntimeError, match=r"at least two classes with training samples.*has 1 \(adenoma\)"):
        _run(ds, tmp_path)


def test_two_classes_where_one_has_no_train_samples_raises(backbone, tmp_path):
    ds = _write_dataset(tmp_path / "ds", {"train": [4, 0], "val": [3, 3]}, cat_ids=(1, 2))
    with pytest.raises(RuntimeError, match=r"at least two classes with training samples.*has 1 \(adenoma\)"):
        _run(ds, tmp_path)


@pytest.mark.parametrize("amp", [True, False])
def test_frozen_feature_caching_follows_the_amp_setting(backbone, dataset, tmp_path, monkeypatch, amp):
    seen = []
    real = adapter_module._autocast
    monkeypatch.setattr(adapter_module, "_autocast",
                        lambda device, enabled: (seen.append(enabled), real(device, enabled))[1])
    _run(dataset, tmp_path, {"amp": amp, "epochs": 1})
    # CPU-only here, so amp is never effective: no autocast may be requested on.
    assert seen and not any(seen)


def test_missing_backbone_config_raises(backbone, dataset, tmp_path):
    req = TrainingRequest(dataset_dir=dataset, task_type="classification", base_model="x",
                          config={"workers": 0}, output_dir=tmp_path)
    with pytest.raises(RuntimeError, match="config is missing 'backbone'"):
        Dinov3ClassifierAdapter().train(req, lambda m: None, lambda *a: None, lambda: False)


def test_fine_tune_from_checkpoint_path_restores_head(backbone, dataset, tmp_path):
    first, _, first_epochs = _run(dataset, tmp_path, {"epochs": 3, "lr": 0.01}, sub="a")
    # lr=0: epoch 1 of the fine-tune evaluates exactly the restored head.
    _, logs, epochs = _run(dataset, tmp_path, {"epochs": 1, "lr": 0.0},
                           base_model=str(first.weights_path), sub="b")
    assert epochs[0][2]["val/macro_f1"] == pytest.approx(first.metrics["val/macro_f1"])
    assert epochs[0][2]["val/loss"] == pytest.approx(
        first_epochs[first.metrics["best_epoch"] - 1][2]["val/loss"], rel=1e-5)
    assert not any("re-initialis" in line for line in logs)


def test_fine_tune_with_other_classes_reinitialises_head(backbone, dataset, tmp_path):
    first, _, _ = _run(dataset, tmp_path, {"epochs": 1}, sub="a")
    ds2 = _write_dataset(tmp_path / "ds2", {"train": [3, 3], "val": [2, 2]}, cat_ids=(1, 2))
    result, logs, _ = _run(ds2, tmp_path, {"epochs": 1}, base_model=str(first.weights_path),
                           sub="b")
    assert result.class_names == ["adenoma", "hyperplastic"]
    assert any("re-initialis" in line for line in logs)


def test_frozen_child_of_partial_parent_keeps_inherited_backbone_tensors(
        backbone, dataset, tmp_path):
    parent, _, _ = _run(dataset, tmp_path, {"mode": "partial", "unfreeze_blocks": 2,
                                            "epochs": 2, "backbone_lr": 0.05}, sub="a")
    child, _, epochs = _run(dataset, tmp_path, {"mode": "frozen", "epochs": 3, "lr": 0.01},
                            base_model=str(parent.weights_path), sub="b")
    state = torch.load(child.weights_path, map_location="cpu", weights_only=True)["trained_state"]
    parent_state = torch.load(parent.weights_path, map_location="cpu",
                              weights_only=True)["trained_state"]
    block_keys = {k for k in parent_state if k.startswith("backbone.model.layer.")}
    assert block_keys and block_keys <= set(state)
    # A fresh backbone with the pristine base weights, as the Hub would give at inference.
    torch.manual_seed(123)
    fresh = FakeBackbone()
    best = epochs[child.metrics["best_epoch"] - 1][2]
    f1, loss = _reevaluate(fresh, child.weights_path, dataset)
    assert f1 == pytest.approx(best["val/macro_f1"])
    assert loss == pytest.approx(best["val/loss"], rel=1e-5)


def test_base_model_neither_file_nor_backbone_is_logged(backbone, dataset, tmp_path):
    _, logs, _ = _run(dataset, tmp_path, {"epochs": 1}, base_model="facebook/something-else")
    assert any("base_model is not a file and not the backbone id" in line for line in logs)


def test_fine_tune_from_other_backbone_raises(backbone, dataset, tmp_path):
    first, _, _ = _run(dataset, tmp_path, {"epochs": 1}, sub="a")
    with pytest.raises(RuntimeError, match="backbone"):
        _run(dataset, tmp_path, {"epochs": 1, "backbone": "other"},
             base_model=str(first.weights_path), sub="b")


def test_result_class_names_follow_class_id_order(backbone, tmp_path):
    ds = _write_dataset(tmp_path / "ds", {"train": [4, 4, 4], "val": [3, 3, 3]},
                        cat_ids=(9, 2, 5))
    result, _, _ = _run(ds, tmp_path, {"epochs": 2})
    # NAMES[i] goes to cat_ids[i]; dense order is by category id: 2, 5, 9.
    assert result.class_names == ["hyperplastic", "serrated", "adenoma"]
    assert [r["class"] for r in result.per_class] == result.class_names
    ckpt = torch.load(result.weights_path, map_location="cpu", weights_only=True)
    assert ckpt["class_names"] == result.class_names


def test_confusion_has_no_background(backbone, dataset, tmp_path):
    result, _, _ = _run(dataset, tmp_path, {"epochs": 2})
    assert result.confusion["labels"] == result.class_names
    assert "background" not in result.confusion["labels"]
    matrix = result.confusion["matrix"]
    assert len(matrix) == 3 and all(len(row) == 3 for row in matrix)
    assert sum(map(sum, matrix)) == 9
    assert all(type(v) is int for row in matrix for v in row)


def test_frozen_tta_flips_doubles_train_cache(backbone, dataset, tmp_path):
    _, logs, _ = _run(dataset, tmp_path, {"epochs": 1, "frozen_tta_flips": True})
    assert any("24 train" in line for line in logs)


def test_missing_config_keys_fall_back_to_defaults(backbone, dataset, tmp_path):
    assert DEFAULTS == {
        "backbone": None, "mode": "frozen", "epochs": 30, "batch": 32, "imgsz": 224,
        "crop_margin": 0.15, "mask_mode": "none", "unfreeze_blocks": 2, "lr": 1e-3,
        "backbone_lr": 1e-5, "layer_decay": 0.75, "weight_decay": 0.05,
        "class_balance": "weighted_loss", "label_smoothing": 0.0, "patience": 10,
        "seed": 0, "workers": 4, "amp": True, "frozen_tta_flips": False, "dropout": 0.0,
    }
    out = tmp_path / "out"
    out.mkdir()
    req = TrainingRequest(dataset_dir=dataset, task_type="classification", base_model="stub",
                          config={"backbone": "stub", "epochs": 1, "workers": 0},
                          output_dir=out)
    epochs = []
    result = Dinov3ClassifierAdapter().train(req, lambda m: None,
                                             lambda *a: epochs.append(a), lambda: False)
    assert len(epochs) == 1
    used = json.loads(result.artifacts[0].read_text())["config"]
    assert used == {**DEFAULTS, "backbone": "stub", "epochs": 1, "workers": 0}
    ckpt = torch.load(result.weights_path, map_location="cpu", weights_only=True)
    assert ckpt["preprocess"]["imgsz"] == 224 and ckpt["preprocess"]["crop_margin"] == 0.15


def test_defaults_match_backend_schema_literals():
    # Mirror of backend/tests/test_training_params.py::_DINOV3_DEFAULTS
    # (test_dinov3_defaults_match_worker_defaults) -- keep the two identical.
    from app.dinov3_classifier_adapter import DEFAULTS

    expected = {
        "mode": "frozen",
        "epochs": 30,
        "batch": 32,
        "imgsz": 224,
        "crop_margin": 0.15,
        "mask_mode": "none",
        "unfreeze_blocks": 2,
        "lr": 1e-3,
        "backbone_lr": 1e-5,
        "layer_decay": 0.75,
        "weight_decay": 0.05,
        "class_balance": "weighted_loss",
        "label_smoothing": 0.0,
        "patience": 10,
        "seed": 0,
        "workers": 4,
        "amp": True,
        "frozen_tta_flips": False,
        "dropout": 0.0,
    }
    assert {k: v for k, v in DEFAULTS.items() if k != "backbone"} == expected
