import contextlib
import gc
import io
import tempfile
from dataclasses import dataclass
from pathlib import Path

import numpy as np
import torch
from PIL import Image

from sam2.sam2_image_predictor import SAM2ImagePredictor
from sam2.sam2_video_predictor import SAM2VideoPredictor


@contextlib.contextmanager
def _clear_cuda_cache_on_error():
    """Mirrors sam3_adapter.py's identical helper: any exception raised
    during GPU-bound work (CUDA OOM in particular) must trigger
    gc.collect() + torch.cuda.empty_cache() before propagating, since
    PyTorch's caching allocator does not return memory to the OS just
    because a Python reference goes out of scope on error. See
    .superpowers/sdd/predict-flakiness-report.md for the confirmed
    mechanism this guards against (documented for Sam3Adapter, but the
    underlying PyTorch/CUDA behavior is identical for any adapter)."""
    try:
        yield
    except Exception:
        gc.collect()
        torch.cuda.empty_cache()
        raise


@dataclass
class MaskResult:
    mask_png: bytes
    score: float


def _mask_png_to_logits(mask_png_bytes: bytes) -> np.ndarray:
    """Converts a user-drawn rough-mask PNG (arbitrary size) into the
    1x256x256 mask-logit array SAM2ImagePredictor.predict(mask_input=...)
    expects, mirroring the resize-and-threshold conversion
    SAM2VideoPredictor.add_new_mask() already does internally for the
    video path (see sam2/sam2_video_predictor.py's add_new_mask): resize
    to 256x256, binarize at the midpoint, then map {0, 1} to {-32, 32}
    logits so the mask decoder treats it as a confident (not near-zero)
    prompt."""
    mask_image = Image.open(io.BytesIO(mask_png_bytes)).convert("L")
    mask_image = mask_image.resize((256, 256), resample=Image.BILINEAR)
    mask_array = np.array(mask_image)
    binary = mask_array >= 128
    logits = np.where(binary, 32.0, -32.0).astype(np.float32)
    return logits[None, :, :]


def _prompts_to_predict_kwargs(prompts: list[dict]) -> dict:
    """Splits this project's point/box/mask prompt dicts into the separate
    point_coords/point_labels/box/mask_input kwargs SAM2ImagePredictor.predict()
    accepts together in one call (confirmed by reading
    sam2/sam2_image_predictor.py's predict() and _prep_prompts() — points,
    box, and mask are independent optional arguments, not mutually
    exclusive types like SAM-3's box/text/point prompt forms)."""
    point_coords = []
    point_labels = []
    box = None
    mask_input = None

    for prompt in prompts:
        if prompt["type"] == "point":
            point_coords.append(prompt["coords"])
            point_labels.append(int(bool(prompt["label"])))
        elif prompt["type"] == "box":
            box = prompt["coords"]
        elif prompt["type"] == "mask":
            import base64

            mask_input = _mask_png_to_logits(base64.b64decode(prompt["mask_png"]))
        else:
            raise ValueError(f"Unknown prompt type: {prompt['type']!r}")

    kwargs = {}
    if point_coords:
        kwargs["point_coords"] = np.array(point_coords)
        kwargs["point_labels"] = np.array(point_labels)
    if box is not None:
        kwargs["box"] = np.array(box)
    if mask_input is not None:
        kwargs["mask_input"] = mask_input
    return kwargs


class Sam2Adapter:
    def __init__(
        self,
        image_model_id: str = "facebook/sam2.1-hiera-large",
        video_model_id: str = "facebook/sam2.1-hiera-large",
    ) -> None:
        """Both predictors are lazy-loaded, same rationale as Sam3Adapter:
        this GPU has only enough VRAM headroom for one large model family
        at a time, so building both eagerly in __init__ would OOM callers
        who only ever use one of predict()/track()."""
        self._image_predictor = None
        self._video_predictor = None
        self._image_model_id = image_model_id
        self._video_model_id = video_model_id

    def _release_video_predictor(self) -> None:
        if self._video_predictor is not None:
            self._video_predictor = None
            gc.collect()
            torch.cuda.empty_cache()

    def _release_image_predictor(self) -> None:
        if self._image_predictor is not None:
            self._image_predictor = None
            gc.collect()
            torch.cuda.empty_cache()

    def _get_image_predictor(self):
        if self._image_predictor is None:
            self._release_video_predictor()
            try:
                self._image_predictor = SAM2ImagePredictor.from_pretrained(self._image_model_id)
            except Exception:
                self._image_predictor = None
                gc.collect()
                torch.cuda.empty_cache()
                raise
        return self._image_predictor

    def _get_video_predictor(self):
        if self._video_predictor is None:
            self._release_image_predictor()
            try:
                self._video_predictor = SAM2VideoPredictor.from_pretrained(self._video_model_id)
            except Exception:
                self._video_predictor = None
                gc.collect()
                torch.cuda.empty_cache()
                raise
        return self._video_predictor

    def predict(self, frame_bytes: bytes, prompts: list[dict]) -> MaskResult:
        predictor = self._get_image_predictor()
        image = Image.open(io.BytesIO(frame_bytes)).convert("RGB")
        kwargs = _prompts_to_predict_kwargs(prompts)

        with _clear_cuda_cache_on_error():
            predictor.set_image(np.array(image))
            masks, scores, _ = predictor.predict(**kwargs, multimask_output=True)

        if len(masks) == 0:
            raise ValueError("SAM 2.1 returned no masks for the given prompts")

        best_index = int(np.argmax(scores))
        mask_array = masks[best_index].astype(np.uint8) * 255

        mask_image = Image.fromarray(mask_array, mode="L")
        buffer = io.BytesIO()
        mask_image.save(buffer, format="PNG")

        return MaskResult(mask_png=buffer.getvalue(), score=float(scores[best_index]))
