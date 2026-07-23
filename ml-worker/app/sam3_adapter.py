import io
from dataclasses import dataclass

import numpy as np
from PIL import Image

from sam3.model_builder import build_sam3_image_model
from sam3.model.sam3_image_processor import Sam3Processor


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
