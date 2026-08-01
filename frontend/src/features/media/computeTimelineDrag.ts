export function pixelToSeconds(
  clientX: number,
  timelineRect: { left: number; width: number },
  durationSeconds: number
): number {
  if (timelineRect.width <= 0) return 0;
  const fraction = (clientX - timelineRect.left) / timelineRect.width;
  const clampedFraction = Math.min(1, Math.max(0, fraction));
  return clampedFraction * durationSeconds;
}

export function findSnapSeconds(
  rawSeconds: number,
  clientX: number,
  timelineRect: { left: number; width: number },
  durationSeconds: number,
  snapCandidates: number[],
  snapPixels: number
): number {
  let best: { seconds: number; distance: number } | null = null;
  for (const candidate of snapCandidates) {
    if (candidate < 0 || candidate > durationSeconds) continue;
    const candidateX = timelineRect.left + (candidate / durationSeconds) * timelineRect.width;
    const distance = Math.abs(candidateX - clientX);
    if (distance <= snapPixels && (best === null || distance < best.distance)) {
      best = { seconds: candidate, distance };
    }
  }
  return best !== null ? best.seconds : rawSeconds;
}
