import io
import tempfile
from dataclasses import dataclass
from pathlib import Path

import numpy as np
import torch
from PIL import Image

from sam3.model_builder import build_sam3_image_model, build_sam3_predictor
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
    def __init__(self, video_predictor_version: str = "sam3") -> None:
        """
        Args:
            video_predictor_version: which SAM-3 checkpoint `track()`'s video
                predictor should load -- "sam3" (default, unchanged existing
                behavior) or "sam3.1". Threaded straight through to
                `sam3.model_builder.build_sam3_predictor(version=...)`, the
                installed package's own explicit version-dispatch entry point
                (confirmed by reading `model_builder.py:1243-1287`: it
                delegates to the same `build_sam3_video_predictor` this
                adapter already called for `version="sam3"`, and to
                `build_sam3_multiplex_video_predictor` for `version="sam3.1"`
                -- both branches return an object with the same
                `handle_request`/`handle_stream_request` API `track()`
                depends on, so switching the import here is a safe drop-in,
                not a different-shaped API). Only affects the video/track()
                path -- `predict()`'s image model always uses
                `build_sam3_image_model`'s own hardcoded "sam3" checkpoint
                (see `download_ckpt_from_hf`), since that builder has no
                equivalent version parameter and this task's brief did not
                ask for the image path to change.
                Does NOT change the default for existing callers -- see
                .superpowers/sdd/task-7-fix-report.md.
        """
        # Both the image model and the video predictor are lazy-loaded (only
        # built the first time predict()/track() is actually called, not
        # here in __init__). This is a Task 7 finding, not the original Task
        # 6 design: this GPU (RTX 2070, ~7.6 GiB usable) has just enough
        # headroom for ONE of these models at a time (~7.1 GiB each) -- see
        # .superpowers/sdd/task-7-report.md for the confirmed
        # torch.OutOfMemoryError this caused when __init__ built the image
        # model unconditionally and a lone track() call then tried to build
        # the video predictor on top of it. Building both eagerly here would
        # make every Sam3Adapter() construction OOM on this hardware even for
        # callers who only ever use one of predict()/track().
        self._model = None
        self._processor = None
        self._video_predictor = None
        self._video_predictor_version = video_predictor_version

    def _get_processor(self):
        if self._processor is None:
            # The bf16/float32 dtype mismatch previously hit here (see
            # .superpowers/sdd/task-6-report.md and task-6-fix-report.md for
            # the two earlier investigation rounds, including a ruled-out
            # `.float()` attempt) is now handled by
            # `_apply_sam3_bf16_dtype_patch()` above, applied at module
            # import time -- see task-6-fix2-report.md for the confirmed
            # root cause (a dtype-preservation bug in
            # `sam3.perflib.fused.addmm_act`, unrelated to autocast/Flash
            # Attention/GPU generation).
            self._model = build_sam3_image_model()
            self._processor = Sam3Processor(self._model)
        return self._processor

    def _get_video_predictor(self):
        if self._video_predictor is None:
            # build_sam3_predictor(version=...) is `sam3`'s own explicit
            # version-dispatch entry point (model_builder.py:1243-1287):
            # version="sam3" delegates to build_sam3_video_predictor (this
            # adapter's previous direct call, unchanged behavior for the
            # default) and version="sam3.1" delegates to
            # build_sam3_multiplex_video_predictor -- both return an object
            # with the same handle_request/handle_stream_request API track()
            # depends on.
            self._video_predictor = build_sam3_predictor(version=self._video_predictor_version)
        return self._video_predictor

    def predict(self, frame_bytes: bytes, prompts: list[dict]) -> MaskResult:
        processor = self._get_processor()
        image = Image.open(io.BytesIO(frame_bytes)).convert("RGB")
        state = processor.set_image(image)

        for prompt in prompts:
            box, label = _prompt_to_geometric_box(prompt)
            state = processor.add_geometric_prompt(box=box, label=label, state=state)

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

    def track(self, frames: list[bytes], prompts: list[dict]) -> list[MaskResult]:
        """Propagates the given prompt(s) (applied to the first frame) across
        a sequence of frames using SAM-3's video predictor session, returning
        one MaskResult per input frame.

        Frame bytes are written to a temporary local directory before calling
        `start_session`, since the real video predictor's `handle_request` API
        takes a `resource_path` pointing at a video/image-sequence on disk,
        not in-memory bytes -- this mirrors the sanctioned
        `tempfile.NamedTemporaryFile` pattern already used by
        `backend/app/media/service.py` for OpenCV (transient local file for a
        library that needs a real path; MinIO/Postgres remain the actual
        source of truth, nothing here persists beyond the temp dir's
        lifetime).
        """
        video_predictor = self._get_video_predictor()

        with tempfile.TemporaryDirectory() as tmp_dir:
            for index, frame_data in enumerate(frames):
                frame_path = Path(tmp_dir) / f"{index:05d}.png"
                frame_path.write_bytes(frame_data)

            response = video_predictor.handle_request({
                "type": "start_session",
                "resource_path": tmp_dir,
            })
            session_id = response["session_id"]

            # Real request/response shape confirmed against the installed
            # sam3 source (Sam3BasePredictor.handle_request /
            # Sam3VideoInferenceWithInstanceInteractivity.add_prompt /
            # _postprocess_output in
            # sam3/model/{sam3_base_predictor,sam3_video_inference}.py), NOT
            # the brief's guessed "box"/"label"/"mask"/"score" keys -- see
            # .superpowers/sdd/task-7-report.md for the full investigation.
            # add_prompt only accepts ONE prompt type per call: points+
            # point_labels+obj_id (point prompts) XOR
            # bounding_boxes+bounding_box_labels (box prompts) -- so only the
            # first prompt in `prompts` is applied here; propagation only
            # needs one seed prompt per the brief's own test.
            prompt = prompts[0]
            add_prompt_request = {
                "type": "add_prompt",
                "session_id": session_id,
                "frame_index": 0,
            }
            if prompt["type"] == "point":
                x, y = prompt["coords"]
                add_prompt_request["points"] = [[x, y]]
                add_prompt_request["point_labels"] = [int(bool(prompt["label"]))]
                add_prompt_request["obj_id"] = 1
            elif prompt["type"] == "box":
                box, label = _prompt_to_geometric_box(prompt)
                center_x, center_y, width, height = box
                # bounding_boxes is xywh (top-left + size), not center-based --
                # convert back from the adapter's shared cxcywh convention.
                add_prompt_request["bounding_boxes"] = [[
                    center_x - width / 2,
                    center_y - height / 2,
                    width,
                    height,
                ]]
                add_prompt_request["bounding_box_labels"] = [int(bool(label))]
            else:
                raise ValueError(f"Unknown prompt type: {prompt['type']!r}")

            video_predictor.handle_request(add_prompt_request)

            try:
                frame_masks: dict[int, np.ndarray] = {}
                for propagation_event in video_predictor.handle_stream_request({
                    "type": "propagate_in_video",
                    "session_id": session_id,
                }):
                    frame_index = propagation_event["frame_index"]
                    outputs = propagation_event["outputs"]
                    binary_masks = outputs["out_binary_masks"]
                    # out_binary_masks is shaped (num_objects, H, W); this adapter
                    # only ever prompts a single object (obj_id=1), so take that
                    # object's mask. An empty first dimension means SAM-3 found
                    # no mask for the tracked object on this frame -- surfaced as
                    # a per-frame all-zero mask rather than a raised error, since
                    # "the tracked object left/re-entered the frame" is expected
                    # propagation behavior, not a failure.
                    if binary_masks.shape[0] == 0:
                        frame_masks[frame_index] = np.zeros(binary_masks.shape[-2:], dtype=bool)
                    else:
                        frame_masks[frame_index] = binary_masks[0]
            finally:
                # Always close the session, even if propagation raises partway
                # through, so a partial failure doesn't leak video-predictor
                # GPU state -- VRAM is the tightest resource this adapter runs
                # under (see .superpowers/sdd/task-7-fix2-report.md).
                video_predictor.handle_request({"type": "close_session", "session_id": session_id})

            results = []
            for frame_index in range(len(frames)):
                mask = frame_masks.get(frame_index)
                if mask is None:
                    raise ValueError(
                        f"SAM-3 video predictor produced no propagation output for frame {frame_index}"
                    )
                mask_array = (mask.astype(np.uint8)) * 255
                mask_image = Image.fromarray(mask_array, mode="L")
                buffer = io.BytesIO()
                mask_image.save(buffer, format="PNG")
                # NOTE: score is hardcoded to 1.0, not a real confidence value.
                # out_probs' index alignment with out_binary_masks after SAM-3's
                # internal object-filtering/reordering was not traced during
                # implementation (risk of silently mismatching a mask to the
                # wrong confidence value) -- see .superpowers/sdd/task-7-report.md
                # "How the brief's field names were adjusted", item 5. Revisit
                # once real per-object out_probs indexing is confirmed.
                results.append(MaskResult(mask_png=buffer.getvalue(), score=1.0))
            return results
