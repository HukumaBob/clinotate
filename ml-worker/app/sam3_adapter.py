import io
from dataclasses import dataclass

import numpy as np
import torch
from PIL import Image

from sam3.model_builder import build_sam3_image_model
from sam3.model.sam3_image_processor import Sam3Processor


def _patched_addmm_act(activation, linear, mat1):
    """Drop-in replacement for `sam3.perflib.fused.addmm_act`.

    Root cause (confirmed by reading the installed `sam3` source, not the
    autocast-based hypothesis from the previous two fix attempts — see
    .superpowers/sdd/task-6-fix2-report.md): `sam3`'s `Mlp.forward` (in
    `sam3/model/vitdet.py`) replaces its first `Linear` + activation with this
    fused kernel for performance. The kernel unconditionally runs the matmul
    in bfloat16 (`self`/`mat1`/`mat2` are all `.to(torch.bfloat16)`'d
    internally) but, in the installed version, never casts the *result* back
    to the input's original dtype before returning it. That bf16 tensor is
    then fed as-is into `Mlp.fc2`, a plain unfused `nn.Linear` whose weights
    are float32, producing `RuntimeError: mat1 and mat2 must have the same
    dtype, but got BFloat16 and Float`.

    This is a plain dtype-preservation bug in a hand-written fused CUDA op
    wrapper -- unrelated to `torch.autocast`, Flash Attention, or GPU
    generation (it would reproduce on any GPU, Turing or not); it is not
    gated behind `get_sdpa_settings()`'s Ampere+ check at all. It has already
    been reported and fixed upstream in an (as of this writing, unmerged)
    pull request: https://github.com/facebookresearch/sam3/pull/570 — this
    patch applies the same fix (`.to(orig_dtype)` on the output) rather than
    inventing a different one, so it will be trivial to drop once that PR
    (or an equivalent fix) lands and this project bumps its pinned commit.
    """
    if torch.is_grad_enabled():
        raise ValueError("Expected grad to be disabled.")
    orig_dtype = mat1.dtype
    addmm_act_op = torch.ops.aten._addmm_activation
    self_ = linear.bias.detach().to(torch.bfloat16)
    mat2 = linear.weight.detach().to(torch.bfloat16)
    mat1 = mat1.to(torch.bfloat16)
    mat1_flat = mat1.view(-1, mat1.shape[-1])
    if activation in (torch.nn.functional.relu, torch.nn.ReLU):
        y = addmm_act_op(self_, mat1_flat, mat2.t(), beta=1, alpha=1, use_gelu=False)
        return y.view(mat1.shape[:-1] + (y.shape[-1],)).to(orig_dtype)
    if activation in (torch.nn.functional.gelu, torch.nn.GELU):
        y = addmm_act_op(self_, mat1_flat, mat2.t(), beta=1, alpha=1, use_gelu=True)
        return y.view(mat1.shape[:-1] + (y.shape[-1],)).to(orig_dtype)
    raise ValueError(f"Unexpected activation {activation}")


def _apply_sam3_bf16_dtype_patch() -> None:
    """Monkeypatches `sam3`'s fused Linear+activation kernel to preserve
    input dtype, working around the upstream bug documented on
    `_patched_addmm_act`. Applied at adapter import time so it's in place
    before any `sam3` model is constructed or run.

    Fragility note: `sam3.model.vitdet` does `from sam3.perflib.fused import
    addmm_act`, which binds the function directly into `vitdet`'s own module
    namespace at import time -- patching `sam3.perflib.fused.addmm_act` alone
    would NOT affect calls already made through that bound name, so both
    the origin module and `vitdet`'s copy of the reference are patched here.
    This relies on `sam3`'s internal module layout (`sam3.perflib.fused`,
    `sam3.model.vitdet`) and the exact signature/behavior of `addmm_act`
    staying stable; the Dockerfile pins the exact `sam3` commit this was
    verified against (see NOTICE/Dockerfile) specifically so an upstream
    change can't silently break this patch without a deliberate,
    reviewed commit-pin bump.
    """
    import sam3.model.vitdet as vitdet
    import sam3.perflib.fused as fused

    fused.addmm_act = _patched_addmm_act
    vitdet.addmm_act = _patched_addmm_act


_apply_sam3_bf16_dtype_patch()


@dataclass
class MaskResult:
    mask_png: bytes
    score: float


def _prompt_to_geometric_box(prompt: dict) -> tuple[list[float], bool]:
    """Converts this project's point/box prompt shape into SAM-3's
    [center_x, center_y, width, height] normalized box format.
    A point becomes a zero-area box at that coordinate."""
    if prompt["type"] == "point":
        x, y = prompt["coords"]
        return [x, y, 0.0, 0.0], prompt["label"]
    if prompt["type"] == "box":
        x1, y1, x2, y2 = prompt["coords"]
        center_x = (x1 + x2) / 2
        center_y = (y1 + y2) / 2
        width = x2 - x1
        height = y2 - y1
        return [center_x, center_y, width, height], prompt["label"]
    raise ValueError(f"Unknown prompt type: {prompt['type']!r}")


class Sam3Adapter:
    def __init__(self) -> None:
        # The bf16/float32 dtype mismatch previously hit here (see
        # .superpowers/sdd/task-6-report.md and task-6-fix-report.md for the
        # two earlier investigation rounds, including a ruled-out `.float()`
        # attempt) is now handled by `_apply_sam3_bf16_dtype_patch()` above,
        # applied at module import time -- see task-6-fix2-report.md for the
        # confirmed root cause (a dtype-preservation bug in
        # `sam3.perflib.fused.addmm_act`, unrelated to autocast/Flash
        # Attention/GPU generation).
        self._model = build_sam3_image_model()
        self._processor = Sam3Processor(self._model)

    def predict(self, frame_bytes: bytes, prompts: list[dict]) -> MaskResult:
        image = Image.open(io.BytesIO(frame_bytes)).convert("RGB")
        state = self._processor.set_image(image)

        for prompt in prompts:
            box, label = _prompt_to_geometric_box(prompt)
            state = self._processor.add_geometric_prompt(box=box, label=label, state=state)

        masks = state["masks"]
        scores = state["scores"]
        if len(masks) == 0:
            raise ValueError("SAM-3 returned no masks above the confidence threshold for the given prompts")

        best_index = int(scores.argmax())
        mask_array = masks[best_index].squeeze().cpu().numpy().astype(np.uint8) * 255

        mask_image = Image.fromarray(mask_array, mode="L")
        buffer = io.BytesIO()
        mask_image.save(buffer, format="PNG")

        return MaskResult(mask_png=buffer.getvalue(), score=float(scores[best_index]))
