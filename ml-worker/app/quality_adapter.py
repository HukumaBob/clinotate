import io

import cv2
import numpy as np
from PIL import Image


class QualityAdapter:
    """No-reference image-quality scorer for Rank Quality. Primary metric
    is TOPIQ (via pyiqa) -- a modern deep-learning no-reference IQA metric
    correlating well with human quality judgment. Falls back to Laplacian
    variance (OpenCV, no torch/pyiqa dependency) if pyiqa/torch fail to
    load, e.g. a version mismatch or missing model weights download.

    Score convention: lower score = worse quality, matching TOPIQ's native
    scale (roughly 0-1, higher is better). The Laplacian fallback uses raw
    variance directly (not inverted), since a sharp image already has high
    Laplacian variance and a blurry/flat image has low variance -- the
    same "higher = better" polarity as TOPIQ.
    """

    def __init__(self) -> None:
        self._metric = None

    def _get_metric(self):
        if self._metric is None:
            import pyiqa

            self._metric = pyiqa.create_metric("topiq_nr")
        return self._metric

    def score(self, frame_bytes: bytes) -> float:
        image = Image.open(io.BytesIO(frame_bytes)).convert("RGB")
        try:
            metric = self._get_metric()
            import torch
            from torchvision import transforms

            tensor = transforms.ToTensor()(image).unsqueeze(0)
            with torch.no_grad():
                result = metric(tensor)
            value = result.item() if hasattr(result, "item") else result[0]
            # Round off float32 tensor-to-Python precision noise (e.g.
            # 0.7 round-tripping as 0.699999988079071): irrelevant at this
            # precision for a quality-ranking score, but left unrounded it
            # makes exact-value comparisons (tests, caching, UI display)
            # needlessly brittle.
            return round(float(value), 6)
        except Exception:
            return self._laplacian_fallback_score(image)

    def _laplacian_fallback_score(self, image: Image.Image) -> float:
        gray = cv2.cvtColor(np.array(image), cv2.COLOR_RGB2GRAY)
        variance = cv2.Laplacian(gray, cv2.CV_64F).var()
        return float(variance)
