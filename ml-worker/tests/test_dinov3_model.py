"""Pure unit tests for the DINOv3 crop classifier (no DB, no network)."""

from types import SimpleNamespace

import numpy as np
import pytest
import torch
from torch import nn

from app import dinov3_model
from app.dinov3_model import (
    CropClassifier,
    IMAGENET_MEAN,
    IMAGENET_STD,
    load_backbone,
    load_trained_state,
    save_checkpoint,
    to_tensor,
)

HIDDEN = 8
REGISTERS = 2
N_PATCH = 6


class _Block(nn.Module):
    def __init__(self):
        super().__init__()
        self.lin = nn.Linear(HIDDEN, HIDDEN)

    def forward(self, x):
        return x + self.lin(x)


class _Inner(nn.Module):
    def __init__(self):
        super().__init__()
        self.layer = nn.ModuleList([_Block() for _ in range(4)])


class FakeBackbone(nn.Module):
    """Mirrors DINOv3ViTModel attribute names: config, embeddings, model.layer, norm."""

    def __init__(self):
        super().__init__()
        self.config = SimpleNamespace(hidden_size=HIDDEN, num_register_tokens=REGISTERS)
        self.embeddings = nn.Linear(3, HIDDEN)
        self.model = _Inner()
        self.norm = nn.LayerNorm(HIDDEN)
        self.ballast = nn.Parameter(torch.zeros(50_000))  # makes the backbone clearly big

    def forward(self, pixel_values=None):
        b = pixel_values.shape[0]
        seq = 1 + REGISTERS + N_PATCH
        x = self.embeddings(pixel_values.mean(dim=(2, 3)))  # [B, H]
        x = x[:, None, :].expand(b, seq, HIDDEN) + torch.arange(seq)[None, :, None] * 0.1
        for blk in self.model.layer:
            x = blk(x)
        return SimpleNamespace(last_hidden_state=self.norm(x))


def _model(n_classes=3):
    torch.manual_seed(0)
    return CropClassifier(FakeBackbone(), n_classes=n_classes)


def _x():
    torch.manual_seed(1)
    return torch.randn(2, 3, 16, 16)


def test_features_concat_cls_and_patch_mean_shape():
    m = _model()
    feats = m.features(_x())
    assert feats.shape == (2, 2 * HIDDEN)
    with torch.no_grad():
        hs = m.backbone(pixel_values=_x()).last_hidden_state
    assert torch.allclose(feats[:, :HIDDEN], hs[:, 0])
    # patch mean skips CLS + register tokens
    assert torch.allclose(feats[:, HIDDEN:], hs[:, 1 + REGISTERS :].mean(dim=1), atol=1e-6)
    assert m(_x()).shape == (2, 3)


def test_set_trainable_zero_freezes_backbone_only_head_trains():
    m = _model()
    names = m.set_trainable(0)
    assert names and all(n.startswith("head") for n in names)
    assert not any(p.requires_grad for p in m.backbone.parameters())
    assert all(p.requires_grad for p in m.head.parameters())


def test_set_trainable_n_unfreezes_last_n_blocks_and_norm():
    m = _model()
    names = m.set_trainable(2)
    assert any(n.startswith("backbone.model.layer.3.") for n in names)
    assert any(n.startswith("backbone.model.layer.2.") for n in names)
    assert not any("model.layer.1." in n or "model.layer.0." in n for n in names)
    assert any(n.startswith("backbone.norm.") for n in names)
    assert any(n.startswith("head") for n in names)
    assert not any(n.startswith("backbone.embeddings") for n in names)
    assert set(names) == {n for n, p in m.named_parameters() if p.requires_grad}
    assert len(m.set_trainable(99)) > len(names)  # clamped, not an error
    with pytest.raises(ValueError):
        m.set_trainable(-1)


def test_checkpoint_roundtrip_restores_head_and_unfrozen_blocks(tmp_path):
    m = _model()
    m.set_trainable(2)
    with torch.no_grad():  # simulate training
        for p in m.parameters():
            if p.requires_grad:
                p.add_(0.5)
    m.eval()
    path = tmp_path / "ckpt.pt"
    pre = {"size": 16}
    save_checkpoint(path, m, backbone_id="facebook/x", class_names=["a", "b", "c"], preprocess=pre)
    fresh = _model()  # same pretrained backbone (same seed), untrained head/blocks
    fresh.eval()
    meta = load_trained_state(fresh, path)
    assert meta == {"backbone_id": "facebook/x", "class_names": ["a", "b", "c"], "preprocess": pre}
    with torch.no_grad():
        assert torch.allclose(m(_x()), fresh(_x()), atol=1e-6)


def test_frozen_checkpoint_contains_no_backbone_tensors(tmp_path):
    m = _model()
    m.set_trainable(0)
    path = tmp_path / "ckpt.pt"
    save_checkpoint(path, m, backbone_id="b", class_names=["a", "b", "c"], preprocess={})
    ckpt = torch.load(path, map_location="cpu", weights_only=True)
    assert ckpt["format_version"] == 1
    assert ckpt["trained_state"] and all(k.startswith("head") for k in ckpt["trained_state"])
    backbone_bytes = sum(p.numel() * p.element_size() for p in m.backbone.parameters())
    assert path.stat().st_size < backbone_bytes


def test_load_trained_state_rejects_unknown_keys(tmp_path):
    m = _model()
    path = tmp_path / "ckpt.pt"
    torch.save(
        {"backbone_id": "b", "class_names": [], "preprocess": {}, "format_version": 1,
         "trained_state": {"nope.weight": torch.zeros(1)}},
        path,
    )
    with pytest.raises(RuntimeError):
        load_trained_state(m, path)


def test_to_tensor_normalises_rgb_uint8():
    crop = np.full((4, 5, 3), 255, dtype=np.uint8)
    t = to_tensor(crop)
    assert t.shape == (3, 4, 5) and t.dtype == torch.float32
    for c in range(3):
        assert t[c, 0, 0].item() == pytest.approx((1 - IMAGENET_MEAN[c]) / IMAGENET_STD[c], rel=1e-5)


def test_load_backbone_failure_message_mentions_licence(monkeypatch):
    import transformers

    def boom(*a, **k):
        raise OSError("401 gated")

    monkeypatch.setattr(transformers.AutoModel, "from_pretrained", boom)
    with pytest.raises(RuntimeError) as ei:
        load_backbone("facebook/dinov3-vits16-pretrain-lvd1689m")
    msg = str(ei.value)
    assert "facebook/dinov3-vits16-pretrain-lvd1689m" in msg
    assert "licence" in msg and "HF_TOKEN" in msg


def test_save_checkpoint_extra_keys_include_frozen_tensors(tmp_path):
    m = _model()
    m.set_trainable(0)
    path = tmp_path / "ckpt.pt"
    extra = ["backbone.model.layer.3.lin.weight", "backbone.norm.weight"]
    save_checkpoint(path, m, backbone_id="b", class_names=["a", "b", "c"], preprocess={},
                    extra_keys=extra)
    state = torch.load(path, map_location="cpu", weights_only=True)["trained_state"]
    assert set(extra) <= set(state)
    assert any(k.startswith("head") for k in state)
    assert not any(k.startswith("backbone.model.layer.0.") for k in state)
    assert torch.equal(state[extra[0]], m.state_dict()[extra[0]])


def test_save_checkpoint_unknown_extra_key_raises(tmp_path):
    m = _model()
    with pytest.raises(ValueError):
        save_checkpoint(tmp_path / "c.pt", m, backbone_id="b", class_names=[], preprocess={},
                        extra_keys=["nope.weight"])
