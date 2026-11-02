"""DINOv3 crop classifier behind TrainingAdapter: a hand-written PyTorch loop.

Two modes. ``frozen``: every crop is embedded once by the frozen backbone and
the head is trained on the cached features. ``partial``: the last
``unfreeze_blocks`` blocks train too, with layer-wise LR decay, AMP fp16,
gradient checkpointing and light, colour-preserving augmentation.
Model selection and early stopping use validation macro-F1.
"""

from __future__ import annotations

import contextlib
import json
import math
import random
from pathlib import Path

import cv2
import numpy as np
import torch
from torch import nn
from torch.utils.data import DataLoader, Dataset, TensorDataset, WeightedRandomSampler

from app import dinov3_model
from app.classifier_metrics import class_weights, confusion_matrix, summarize, to_result_confusion
from app.dinov3_crops import crop_region, load_samples, read_rgb
from app.dinov3_model import IMAGENET_MEAN, IMAGENET_STD, CropClassifier, save_checkpoint, to_tensor
from app.training_adapter import TrainingRequest, TrainingResult

# Every config key with its default. ``backbone`` (a Hub id) is always set by
# the backend; it is the one key without a usable default.
DEFAULTS: dict = {
    "backbone": None,
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

EMBED_BATCH = 32  # bounds VRAM while caching frozen features
SMALL_VAL_REGIONS = 50  # below this, select and early-stop on val loss, not macro-F1


def _load_backbone(hub_id: str) -> nn.Module:
    return dinov3_model.load_backbone(hub_id)


def _device() -> torch.device:
    return torch.device("cuda" if torch.cuda.is_available() else "cpu")


def _autocast(device: torch.device, enabled: bool):
    if device.type == "cuda" and enabled:
        return torch.autocast("cuda", dtype=torch.float16)
    return contextlib.nullcontext()


def _augment(crop: np.ndarray, rng: np.random.Generator) -> np.ndarray:
    """Flips, rotation <= 15 deg, scale 0.9-1.1, brightness/contrast +-10%.

    Brightness is a uniform multiplier and contrast stretches around the grey
    mean, so hue is untouched: colour is a diagnostic cue.
    """
    if rng.random() < 0.5:
        crop = crop[:, ::-1]
    if rng.random() < 0.5:
        crop = crop[::-1]
    h, w = crop.shape[:2]
    m = cv2.getRotationMatrix2D((w / 2, h / 2), rng.uniform(-15, 15), rng.uniform(0.9, 1.1))
    crop = cv2.warpAffine(np.ascontiguousarray(crop), m, (w, h), flags=cv2.INTER_LINEAR,
                          borderMode=cv2.BORDER_REFLECT_101)
    out = crop.astype(np.float32) * rng.uniform(0.9, 1.1)
    mean = out.mean()
    out = (out - mean) * rng.uniform(0.9, 1.1) + mean
    return np.clip(out, 0, 255).astype(np.uint8)


class _Crops(Dataset):
    def __init__(self, samples, cfg, *, flip=False, augment=False):
        self.samples, self.cfg, self.flip, self.augment = samples, cfg, flip, augment
        self.epoch = 0

    def __len__(self):
        return len(self.samples)

    def __getitem__(self, i):
        s = self.samples[i]
        crop = crop_region(read_rgb(s.image_path), s.bbox, s.polygon,
                           margin=self.cfg["crop_margin"], mask_mode=self.cfg["mask_mode"],
                           imgsz=self.cfg["imgsz"])
        if self.flip:
            crop = crop[:, ::-1]
        if self.augment:
            crop = _augment(crop, np.random.default_rng([self.cfg["seed"], self.epoch, i]))
        return to_tensor(crop), s.class_id


def _generator(seed: int) -> torch.Generator:
    g = torch.Generator()
    g.manual_seed(seed)
    return g


LICENCE_FILENAME = "DINOv3-LICENSE.md"
LICENCE_URL = "https://ai.meta.com/resources/models-and-libraries/dinov3-license/"


def _fetch_licence(hub_id: str) -> bytes:
    """The authoritative licence file of the (gated) Hub model repo. Test seam."""
    from huggingface_hub import hf_hub_download

    return Path(hf_hub_download(repo_id=hub_id, filename="LICENSE.md")).read_bytes()


def _write_licence_file(output_dir: Path, hub_id: str, on_log) -> Path:
    """Write Meta's DINOv3 licence next to the weights (redistribution requires it).

    Never fails the run: if the Hub text cannot be fetched, a pointer file says
    where to get it. The exception text is logged, the token never is.
    """
    path = Path(output_dir) / LICENCE_FILENAME
    try:
        path.write_bytes(_fetch_licence(hub_id))
    except Exception as exc:  # noqa: BLE001 -- must not fail a finished training run
        on_log(f"Could not fetch the DINOv3 licence text from the Hub: "
               f"{type(exc).__name__}: {_redact(exc)}; wrote a pointer file instead")
        path.write_text(
            "# DINOv3 licence\n\n"
            "This model was built on Meta's DINOv3 (Hub repository "
            f"`{hub_id}`).\n\n"
            "Redistributing it requires including Meta's DINOv3 licence text. "
            "The text could not be bundled automatically; obtain it from\n\n"
            f"- {LICENCE_URL}\n"
            f"- the `LICENSE.md` file of the Hub repository `{hub_id}`\n\n"
            "and ship it alongside these weights.\n",
            encoding="utf-8")
    return path


def _redact(exc: Exception) -> str:
    import re

    return re.sub(r"hf_[A-Za-z0-9]+", "hf_***", str(exc))[:300]


def _load_into(model, path: Path, backbone_id: str, class_names, on_log) -> set[str]:
    """Load a parent checkpoint; return the state_dict keys taken from it."""
    ckpt = torch.load(path, map_location="cpu", weights_only=True)
    if ckpt.get("backbone_id") != backbone_id:
        raise RuntimeError(
            f"Cannot fine-tune: the parent checkpoint was trained on backbone "
            f"{ckpt.get('backbone_id')!r}, but this run uses {backbone_id!r}."
        )
    if list(ckpt.get("class_names", [])) == list(class_names):
        dinov3_model.load_trained_state(model, path)
        return set(ckpt["trained_state"])
    state = {k: v for k, v in ckpt["trained_state"].items() if not k.startswith("head.")}
    result = model.load_state_dict(state, strict=False)
    if result.unexpected_keys:
        raise RuntimeError(f"Checkpoint has keys the model does not: {sorted(result.unexpected_keys)}")
    on_log("Parent checkpoint has different classes "
           f"({ckpt.get('class_names')} vs {list(class_names)}): head re-initialised")
    return set(state)


def _param_groups(model: CropClassifier, cfg) -> list[dict]:
    groups = [{"params": list(model.head.parameters()), "lr": cfg["lr"]}]
    blocks = list(model.backbone.model.layer)
    for i, block in enumerate(blocks):
        params = [p for p in block.parameters() if p.requires_grad]
        if params:
            lr = cfg["backbone_lr"] * cfg["layer_decay"] ** (len(blocks) - 1 - i)
            groups.append({"params": params, "lr": lr})
    norm = [p for p in model.backbone.norm.parameters() if p.requires_grad]
    if norm:
        groups.append({"params": norm, "lr": cfg["backbone_lr"]})
    return groups


class Dinov3ClassifierAdapter:
    name = "dinov3_classifier"

    def train(self, request: TrainingRequest, on_log, on_epoch, should_stop) -> TrainingResult:
        cfg = {**DEFAULTS, **request.config}
        if not cfg["backbone"]:
            raise RuntimeError("config is missing 'backbone'")
        seed = int(cfg["seed"])
        random.seed(seed)
        np.random.seed(seed)
        torch.manual_seed(seed)

        log_lines: list[str] = []

        def capture(msg):
            log_lines.append(msg)
            on_log(msg)

        samples, class_names = load_samples(request.dataset_dir, capture)
        if not samples:
            why = log_lines[-1] if log_lines else "annotations.json lists no annotated regions"
            raise RuntimeError(f"No usable regions in the dataset: {why}")
        train = [s for s in samples if s.split == "train"]
        val = [s for s in samples if s.split == "val"]
        test = [s for s in samples if s.split == "test"]
        if not train:
            raise RuntimeError("The dataset has no training split: no region landed in 'train'.")
        if not val:
            raise RuntimeError(
                "The dataset has no validation split, so the classifier cannot be selected or "
                "early-stopped. Export from at least two videos so the split can give val."
            )
        n = len(class_names)
        counts = np.bincount([s.class_id for s in train], minlength=n)
        trained = [class_names[i] for i in range(n) if counts[i] > 0]
        if len(trained) < 2:
            named = f" ({', '.join(trained)})" if trained else ""
            raise RuntimeError(
                "A classifier needs at least two classes with training samples; "
                f"this dataset has {len(trained)}{named}"
            )
        missing = [class_names[i] for i in range(n) if counts[i] == 0]
        if missing:
            on_log(f"Classes with no training samples (excluded from the loss): {', '.join(missing)}")

        device = _device()
        use_amp = bool(cfg["amp"]) and device.type == "cuda"
        model = CropClassifier(_load_backbone(cfg["backbone"]), n, dropout=float(cfg["dropout"]))
        base = Path(request.base_model) if request.base_model else None
        # Tensors inherited from a parent must be saved even if frozen in this run:
        # at inference the rest of the backbone comes from the Hub.
        inherited: set[str] = set()
        if base is not None and base.is_file():
            inherited = _load_into(model, base, cfg["backbone"], class_names, on_log)
        elif request.base_model and request.base_model != cfg["backbone"]:
            on_log("base_model is not a file and not the backbone id; "
                   "starting from the Hub backbone")
        partial = cfg["mode"] == "partial"
        model.set_trainable(int(cfg["unfreeze_blocks"]) if partial else 0)
        model.to(device)
        n_trainable = sum(p.numel() for p in model.parameters() if p.requires_grad)
        on_log(f"Mode {cfg['mode']}: {n_trainable} trainable parameters, "
               f"{len(train)} train / {len(val)} val regions, {n} classes")

        workers = int(cfg["workers"])
        batch = int(cfg["batch"])
        if cfg["class_balance"] == "weighted_loss":
            weight = torch.tensor(class_weights(counts), dtype=torch.float32)
        else:
            weight = torch.tensor((counts > 0).astype(np.float32))
        loss_fn = nn.CrossEntropyLoss(weight=weight.to(device),
                                      label_smoothing=float(cfg["label_smoothing"]))
        val_loss_fn = nn.CrossEntropyLoss()

        def sampler_for(labels):
            if cfg["class_balance"] != "balanced_sampler":
                return None
            w = [1.0 / counts[c] for c in labels]
            return WeightedRandomSampler(w, num_samples=len(w), replacement=True,
                                         generator=_generator(seed))

        if partial:
            bb = model.backbone
            if getattr(bb, "supports_gradient_checkpointing", False) and hasattr(
                bb, "gradient_checkpointing_enable"
            ):
                # Non-reentrant: the first unfrozen block's input carries no grad
                # (frozen blocks below), which the reentrant variant would drop.
                bb.gradient_checkpointing_enable(gradient_checkpointing_kwargs={"use_reentrant": False})
                on_log("Gradient checkpointing enabled")
            train_ds = _Crops(train, cfg, augment=True)
            sampler = sampler_for([s.class_id for s in train])
            train_loader = DataLoader(train_ds, batch_size=batch, shuffle=sampler is None,
                                      sampler=sampler, num_workers=workers,
                                      generator=_generator(seed))
            val_loader = DataLoader(_Crops(val, cfg), batch_size=batch, num_workers=workers)
            test_loader = (DataLoader(_Crops(test, cfg), batch_size=batch, num_workers=workers)
                           if test else None)
            forward = model
            groups = _param_groups(model, cfg)
        else:
            def embed(items, flip=False):
                loader = DataLoader(_Crops(items, cfg, flip=flip), batch_size=EMBED_BATCH,
                                    num_workers=workers)
                feats, labels = [], []
                model.eval()
                with torch.no_grad():
                    for x, y in loader:
                        with _autocast(device, use_amp):
                            f = model.features(x.to(device))
                        feats.append(f.float().cpu())
                        labels.append(y)
                return torch.cat(feats), torch.cat(labels)

            tx, ty = embed(train)
            if cfg["frozen_tta_flips"]:
                fx, fy = embed(train, flip=True)
                tx, ty = torch.cat([tx, fx]), torch.cat([ty, fy])
            vx, vy = embed(val)
            on_log(f"Cached features: {len(tx)} train / {len(vx)} val crops")
            sampler = sampler_for(ty.tolist())
            train_loader = DataLoader(TensorDataset(tx, ty), batch_size=batch,
                                      shuffle=sampler is None, sampler=sampler,
                                      generator=_generator(seed))
            val_loader = DataLoader(TensorDataset(vx, vy), batch_size=batch)
            if test:
                sx, sy = embed(test)
                test_loader = DataLoader(TensorDataset(sx, sy), batch_size=batch)
            else:
                test_loader = None
            train_ds = None
            forward = model.head
            groups = [{"params": list(model.head.parameters()), "lr": cfg["lr"]}]

        epochs = int(cfg["epochs"])
        optimizer = torch.optim.AdamW(groups, weight_decay=float(cfg["weight_decay"]))
        scheduler = torch.optim.lr_scheduler.CosineAnnealingLR(optimizer, T_max=max(1, epochs))
        scaler = torch.amp.GradScaler("cuda", enabled=use_amp and partial)
        preprocess = {"imgsz": int(cfg["imgsz"]), "crop_margin": float(cfg["crop_margin"]),
                      "mask_mode": str(cfg["mask_mode"]), "mean": list(IMAGENET_MEAN),
                      "std": list(IMAGENET_STD)}
        out_dir = Path(request.output_dir)
        best_path = out_dir / "best.pt"
        best = None  # (epoch, summary, cm)
        best_loss = math.inf
        best_state: dict[str, torch.Tensor] = {}
        # With a handful of validation regions one flipped prediction moves
        # macro-F1 by several points, so a lucky early epoch would win and stop
        # the run; the loss is smooth enough to select on.
        by_loss = len(val) < SMALL_VAL_REGIONS
        criterion = "val loss" if by_loss else "val macro-F1"
        if by_loss:
            on_log(f"Only {len(val)} validation regions: selecting the best epoch by val loss "
                   f"instead of macro-F1 (fewer than {SMALL_VAL_REGIONS})")
        history: list[dict] = []
        since_best = 0
        patience = int(cfg["patience"])

        def save():
            save_checkpoint(best_path, model, backbone_id=cfg["backbone"],
                            class_names=class_names, preprocess=preprocess,
                            extra_keys=inherited)
            best_state.clear()
            best_state.update({name: p.detach().cpu().clone()
                               for name, p in model.named_parameters() if p.requires_grad})

        for epoch in range(1, epochs + 1):
            if partial:
                model.train()
                train_ds.epoch = epoch
            else:
                model.head.train()
            losses = []
            for x, y in train_loader:
                x, y = x.to(device), y.to(device)
                optimizer.zero_grad(set_to_none=True)
                # Head-only training stays fp32: GradScaler is off in frozen mode.
                with _autocast(device, use_amp and partial):
                    loss = loss_fn(forward(x).float(), y)
                scaler.scale(loss).backward()
                scaler.step(optimizer)
                scaler.update()
                losses.append(loss.item())
            scheduler.step()

            model.eval()
            preds, targets, val_losses = [], [], []
            with torch.no_grad():
                for x, y in val_loader:
                    x, y = x.to(device), y.to(device)
                    with _autocast(device, use_amp):
                        logits = forward(x).float()
                    val_losses.append(val_loss_fn(logits, y).item() * len(y))
                    preds.append(logits.argmax(1).cpu())
                    targets.append(y.cpu())
            cm = confusion_matrix(torch.cat(targets).numpy(), torch.cat(preds).numpy(), n)
            summary = summarize(cm, class_names)
            if epoch == 1 and summary.absent:
                on_log("Classes with no validation samples (excluded from macro averages): "
                       + ", ".join(summary.absent))
            metrics = {
                "train/loss": float(np.mean(losses)) if losses else math.nan,
                "val/loss": float(sum(val_losses) / len(val)),
                "val/macro_f1": float(summary.macro_f1),
                "val/balanced_accuracy": float(summary.balanced_accuracy),
                "val/accuracy": float(summary.accuracy),
            }
            history.append({"epoch": epoch, **metrics})
            on_log(f"Epoch {epoch}/{epochs}: train loss {metrics['train/loss']:.4f}, "
                   f"val loss {metrics['val/loss']:.4f}, val macro-F1 {metrics['val/macro_f1']:.4f}")
            improved = (
                best is None
                or (metrics["val/loss"] < best_loss if by_loss else summary.macro_f1 > best[1].macro_f1)
            )
            if improved:
                best = (epoch, summary, cm)
                best_loss = metrics["val/loss"]
                since_best = 0
                save()
            else:
                since_best += 1
            on_epoch(epoch, epochs, metrics)
            if should_stop():
                on_log(f"Stop requested: ending after epoch {epoch}")
                break
            if patience > 0 and since_best >= patience:
                on_log(f"No {criterion} improvement for {patience} epochs: stopping early")
                break

        if best is None or not best_path.is_file():  # defensive: epochs == 0
            save()
        best_epoch, summary, cm = best if best else (0, summarize(np.zeros((n, n)), class_names), np.zeros((n, n)))
        result_metrics = {
            "val/macro_f1": float(summary.macro_f1),
            "val/balanced_accuracy": float(summary.balanced_accuracy),
            "val/accuracy": float(summary.accuracy),
            "best_epoch": int(best_epoch),
        }
        test_per_class = None
        if test_loader is not None and best_state:
            # Score the selected epoch, not the last one, on the held-out split.
            model.load_state_dict(best_state, strict=False)
            model.eval()
            preds, targets = [], []
            with torch.no_grad():
                for x, y in test_loader:
                    with _autocast(device, use_amp):
                        logits = forward(x.to(device)).float()
                    preds.append(logits.argmax(1).cpu())
                    targets.append(y)
            test_cm = confusion_matrix(torch.cat(targets).numpy(), torch.cat(preds).numpy(), n)
            test_summary = summarize(test_cm, class_names)
            result_metrics.update({
                "test/macro_f1": float(test_summary.macro_f1),
                "test/balanced_accuracy": float(test_summary.balanced_accuracy),
                "test/accuracy": float(test_summary.accuracy),
                "test/regions": len(test),
            })
            test_per_class = test_summary.per_class
            on_log(f"Test ({len(test)} regions) at epoch {best_epoch}: macro-F1 "
                   f"{test_summary.macro_f1:.4f}, accuracy {test_summary.accuracy:.4f}")
        safe_cfg = {k: v for k, v in cfg.items() if "token" not in k.lower()}
        metrics_path = out_dir / "metrics.json"
        metrics_path.write_text(json.dumps({
            "metrics": result_metrics, "per_class": summary.per_class,
            "test_per_class": test_per_class,
            "class_names": class_names, "config": safe_cfg, "history": history,
        }, indent=2))
        licence_path = _write_licence_file(out_dir, str(cfg["backbone"]), on_log)
        return TrainingResult(
            weights_path=best_path,
            metrics=result_metrics,
            per_class=summary.per_class,
            confusion=to_result_confusion(cm, class_names),
            class_names=list(class_names),
            artifacts=[metrics_path, licence_path],
            history=[],
        )
