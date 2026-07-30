/**
 * A <video> element with a natural aspect ratio that differs from its
 * bounding box renders with letterboxing (black bars) inside its own
 * box to preserve that ratio -- the same way object-fit: contain works.
 * Crop percentages are defined against the actual video frame, not the
 * element's bounding box, so any overlay drawn on top must be
 * positioned against this computed rect, not the element's full size.
 */
export function computeVideoMediaRect(
  videoWidth: number,
  videoHeight: number,
  clientWidth: number,
  clientHeight: number
): { left: number; top: number; width: number; height: number } | null {
  if (videoWidth <= 0 || videoHeight <= 0 || clientWidth <= 0 || clientHeight <= 0) {
    return null;
  }

  const videoRatio = videoWidth / videoHeight;
  const clientRatio = clientWidth / clientHeight;

  if (videoRatio > clientRatio) {
    // Video is relatively wider than its box -- letterboxed top/bottom.
    const height = clientWidth / videoRatio;
    return { left: 0, top: (clientHeight - height) / 2, width: clientWidth, height };
  }

  // Video is relatively taller than (or equal to) its box -- letterboxed left/right.
  const width = clientHeight * videoRatio;
  return { left: (clientWidth - width) / 2, top: 0, width, height: clientHeight };
}
