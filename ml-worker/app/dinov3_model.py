"""DINOv3 crop classifier: frozen/partially fine-tuned ViT backbone + linear head.

Hub ids (gated; accept the licence on the Hub and set HF_TOKEN):
  ViT-S/16  facebook/dinov3-vits16-pretrain-lvd1689m  (hidden 384, 12 blocks)
  ViT-B/16  facebook/dinov3-vitb16-pretrain-lvd1689m  (hidden 768, 12 blocks)
  ViT-L/16  facebook/dinov3-vitl16-pretrain-lvd1689m  (hidden 1024, 24 blocks)

Loader: ``transformers.AutoModel.from_pretrained`` returns ``DINOv3ViTModel`` with
top-level children ``embeddings``, ``rope_embeddings``, ``model`` (encoder blocks in
``model.layer``) and ``norm``. ``last_hidden_state`` is 1 CLS + ``num_register_tokens``
register tokens + patch tokens.
"""

from __future__ import annotations

from pathlib import Path

import numpy as np
import torch
from torch import nn

IMAGENET_MEAN = (0.485, 0.456, 0.406)
IMAGENET_STD = (0.229, 0.224, 0.225)
FORMAT_VERSION = 1


def load_backbone(hub_id: str, dtype=None) -> nn.Module:
    from transformers import AutoModel

    try:
        kwargs = {} if dtype is None else {"dtype": dtype}
        return AutoModel.from_pretrained(hub_id, **kwargs)
    except Exception as exc:
        raise RuntimeError(
            f"Could not load {hub_id}: {exc}. DINOv3 weights are gated: accept the "
            "licence on the Hub for this model and check HF_TOKEN."
        ) from exc


def to_tensor(crop: np.ndarray) -> torch.Tensor:
    """RGB uint8 HxWx3 -> normalised float32 CHW tensor."""
    t = torch.from_numpy(np.ascontiguousarray(crop)).permute(2, 0, 1).to(torch.float32) / 255.0
    mean = torch.tensor(IMAGENET_MEAN, dtype=torch.float32).view(3, 1, 1)
    std = torch.tensor(IMAGENET_STD, dtype=torch.float32).view(3, 1, 1)
    return (t - mean) / std


class CropClassifier(nn.Module):
    def __init__(
        self,
        backbone: nn.Module,
        n_classes: int,
        hidden_size: int | None = None,
        dropout: float = 0.0,
    ):
        super().__init__()
        self.backbone = backbone
        hidden = hidden_size if hidden_size is not None else backbone.config.hidden_size
        self.n_prefix = 1 + int(getattr(backbone.config, "num_register_tokens", 0) or 0)
        self.head = nn.Sequential(nn.Dropout(dropout), nn.Linear(2 * hidden, n_classes))

    def features(self, x: torch.Tensor) -> torch.Tensor:
        hs = self.backbone(pixel_values=x).last_hidden_state
        return torch.cat([hs[:, 0], hs[:, self.n_prefix :].mean(dim=1)], dim=-1)

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        return self.head(self.features(x))

    def set_trainable(self, unfreeze_blocks: int) -> list[str]:
        if unfreeze_blocks < 0:
            raise ValueError("unfreeze_blocks must be >= 0")
        for p in self.backbone.parameters():
            p.requires_grad = False
        if unfreeze_blocks > 0:
            blocks = list(self.backbone.model.layer)
            for block in blocks[max(0, len(blocks) - unfreeze_blocks) :]:
                for p in block.parameters():
                    p.requires_grad = True
            for p in self.backbone.norm.parameters():
                p.requires_grad = True
        for p in self.head.parameters():
            p.requires_grad = True
        return [n for n, p in self.named_parameters() if p.requires_grad]


def save_checkpoint(
    path: Path,
    model: CropClassifier,
    *,
    backbone_id: str,
    class_names: list[str],
    preprocess: dict,
) -> None:
    trainable = {n for n, p in model.named_parameters() if p.requires_grad}
    state = {
        k: v.detach().cpu().clone() for k, v in model.state_dict().items() if k in trainable
    }
    torch.save(
        {
            "backbone_id": backbone_id,
            "class_names": list(class_names),
            "preprocess": preprocess,
            "trained_state": state,
            "format_version": FORMAT_VERSION,
        },
        path,
    )


def load_trained_state(model: CropClassifier, path: Path) -> dict:
    ckpt = torch.load(path, map_location="cpu", weights_only=True)
    state = ckpt["trained_state"]
    result = model.load_state_dict(state, strict=False)
    # strict=False tolerates the frozen backbone being absent from the file, but
    # an entry in the file that the model does not have must never be dropped.
    if result.unexpected_keys:
        raise RuntimeError(
            f"Checkpoint has keys the model does not: {sorted(result.unexpected_keys)}"
        )
    return {k: ckpt[k] for k in ("backbone_id", "class_names", "preprocess")}
