import cv2
import numpy as np

# Kernel/blur radii are computed as strength * _RELATIVE_KERNEL_FRACTION *
# min(height, width), so the same strength value behaves consistently
# across differently-sized source videos rather than using a fixed pixel
# count. Real endoscopy frames in this platform range from ~260x240 (older
# scope hardware) up to 4K -- at 0.015 (an earlier estimate tuned only
# against the 1000-2000px band), a 260px-short-side frame gets a kernel of
# just 2-4px even at strength=1.0, too small to close realistically-sized
# holes/speckles. 0.05 keeps the low end of that range usable (~13px
# kernel at strength=1.0 on a 260px frame) while staying a fraction of the
# frame, not a fixed pixel count, so it still scales sanely up to 4K.
_RELATIVE_KERNEL_FRACTION = 0.05


def postprocess_mask(mask: np.ndarray, strength: float) -> np.ndarray:
    """Cleans up jagged contours, speckles, and holes in a binary
    segmentation mask using OpenCV morphology + largest-connected-component
    + Gaussian contour smoothing.

    `mask` is a 2D boolean (or {0,1}) array. `strength` in [0, 1]; 0 is a
    no-op identity (returns `mask` unchanged, byte-for-byte). Kernel/blur
    sizes scale with `strength` and with the frame's `min(height, width)`,
    not a fixed pixel count, so the same strength behaves consistently
    across differently-sized source videos.
    """
    if not 0.0 <= strength <= 1.0:
        raise ValueError(f"strength must be in [0, 1], got {strength}")
    if strength == 0.0:
        return mask

    height, width = mask.shape
    kernel_size = max(1, round(strength * _RELATIVE_KERNEL_FRACTION * min(height, width)))
    kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (kernel_size, kernel_size))

    binary = (mask.astype(np.uint8)) * 255
    opened = cv2.morphologyEx(binary, cv2.MORPH_OPEN, kernel)
    closed = cv2.morphologyEx(opened, cv2.MORPH_CLOSE, kernel)

    num_labels, labels, stats, _ = cv2.connectedComponentsWithStats(closed, connectivity=8)
    if num_labels <= 1:
        # No foreground component survived opening/closing -- nothing to
        # keep, and nothing left to smooth.
        return closed > 0

    # Label 0 is background; pick the largest non-background component by area.
    largest_label = 1 + int(np.argmax(stats[1:, cv2.CC_STAT_AREA]))
    largest_only = np.where(labels == largest_label, 255, 0).astype(np.uint8)

    blur_radius = kernel_size
    # GaussianBlur requires an odd kernel size.
    if blur_radius % 2 == 0:
        blur_radius += 1
    blurred = cv2.GaussianBlur(largest_only, (blur_radius, blur_radius), 0)
    _, smoothed = cv2.threshold(blurred, 127, 255, cv2.THRESH_BINARY)

    return smoothed > 0
