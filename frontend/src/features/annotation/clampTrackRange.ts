export interface TrackRangeBounds {
  // Frames actually available behind/ahead of the current frame within its
  // sequence.
  maxBackward: number;
  maxForward: number;
  // The combined (backward + forward) cap from Settings, or Infinity while
  // it hasn't loaded yet.
  combinedCap: number;
}

export interface TrackRangeValue {
  backward: number;
  forward: number;
}

// Single source of truth for keeping backward/forward within both the
// per-sequence bounds (can't track past the start/end of the sequence) and
// the combined GPU-safety cap from Settings -- used both for live edits
// (TrackControls' onChange) and for the one-time recompute on frame change
// (FrameEditor's per-frame effect), so a value that's valid at rest is
// always valid after either kind of update.
export function clampTrackRange(
  { backward, forward }: TrackRangeValue,
  { maxBackward, maxForward, combinedCap }: TrackRangeBounds,
): TrackRangeValue {
  const clampedBackward = Math.max(0, Math.min(backward, maxBackward));
  const clampedForward = Math.max(0, Math.min(forward, maxForward));

  const total = clampedBackward + clampedForward;
  if (total <= combinedCap) {
    return { backward: clampedBackward, forward: clampedForward };
  }

  // Over the combined cap even after per-sequence clamping -- shrink
  // forward first (it's the field FrameEditor auto-fills to "rest of the
  // sequence", while backward defaults to 0 and is an opt-in the user set
  // deliberately), then fall back to backward if forward alone can't
  // absorb the whole overage.
  const overBy = total - combinedCap;
  const forwardGivesUp = Math.min(overBy, clampedForward);
  const remainingOver = overBy - forwardGivesUp;
  const backwardGivesUp = Math.min(remainingOver, clampedBackward);

  return {
    backward: clampedBackward - backwardGivesUp,
    forward: clampedForward - forwardGivesUp,
  };
}
