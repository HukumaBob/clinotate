"""Degrade a frame before the model sees it (stress tests).

Pure and deterministic given (spec, seed): noise uses a generator seeded with
the frame index, so a rerun of the same run reproduces the same pixels.
Kinds and strength ranges are validated by the backend
(backend/app/inference/schemas.py PerturbationSpec); keep them in step.
"""

import cv2
import numpy as np


def apply_perturbation(image: np.ndarray, spec: dict | None, seed: int = 0) -> np.ndarray:
    if spec is None:
        return image
    kind = spec["kind"]
    strength = float(spec["strength"])
    if kind == "gaussian_noise":
        noise = np.random.default_rng(seed).normal(0.0, strength, image.shape)
        return np.clip(image.astype(np.float32) + noise, 0, 255).astype(np.uint8)
    if kind == "blur":
        return cv2.GaussianBlur(image, (0, 0), sigmaX=strength)
    if kind == "brightness":
        return np.clip(image.astype(np.int16) + int(round(strength)), 0, 255).astype(np.uint8)
    if kind == "jpeg":
        ok, buffer = cv2.imencode(".jpg", image, [cv2.IMWRITE_JPEG_QUALITY, int(strength)])
        if not ok:
            raise ValueError("JPEG encoding failed")
        return cv2.imdecode(buffer, cv2.IMREAD_COLOR)
    raise ValueError(f"Unknown perturbation kind: {kind}")
