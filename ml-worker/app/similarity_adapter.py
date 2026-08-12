import io

import numpy as np
import torch
from PIL import Image
from torchvision import transforms

_PREPROCESS = transforms.Compose(
    [
        transforms.Resize(256),
        transforms.CenterCrop(224),
        transforms.ToTensor(),
        transforms.Normalize(mean=[0.485, 0.456, 0.406], std=[0.229, 0.224, 0.225]),
    ]
)


class SimilarityAdapter:
    """Embeds frames with DINOv2 (ViT-B/14) for near-duplicate detection in
    Find Similar. DINOv2 is a self-supervised, vision-only model --
    stronger than classification-pretrained CNNs (e.g. ResNet-18, used by
    the reference project this feature was adapted from) at encoding
    pixel/geometry structure, which is what near-duplicate detection
    actually needs rather than semantic class information."""

    def __init__(self) -> None:
        self._model = None

    def _get_model(self):
        if self._model is None:
            self._model = torch.hub.load("facebookresearch/dinov2", "dinov2_vitb14")
            self._model.eval()
            if torch.cuda.is_available():
                self._model = self._model.cuda()
        return self._model

    def embed(self, frame_bytes: bytes) -> np.ndarray:
        model = self._get_model()
        image = Image.open(io.BytesIO(frame_bytes)).convert("RGB")
        tensor = _PREPROCESS(image).unsqueeze(0)
        if torch.cuda.is_available():
            tensor = tensor.cuda()

        with torch.no_grad():
            features = model(tensor)

        vector = features.squeeze(0).cpu().numpy().astype(np.float64)
        norm = np.linalg.norm(vector)
        return vector / norm if norm > 0 else vector
