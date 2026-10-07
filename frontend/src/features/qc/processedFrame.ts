import type { PredictionsDocument } from "./predictions";

export interface ProcessedFrame {
  frameIndex: number;
  timestampMs: number;
}

/** The frames the model actually processed, sorted by time. Flags may only
 * point at these: with a stride above 1 the other frames were never seen. */
export function buildProcessedFrames(doc: PredictionsDocument): ProcessedFrame[] {
  return Object.entries(doc.frames)
    .map(([key, frame]) => ({ frameIndex: Number(key), timestampMs: frame.timestamp_ms }))
    .sort((a, b) => a.timestampMs - b.timestampMs);
}

/** The processed frame at or before `timeMs` (the one whose predictions the
 * overlay shows), or null before the first frame. */
export function processedFrameAt(frames: ProcessedFrame[], timeMs: number): ProcessedFrame | null {
  if (frames.length === 0 || timeMs < frames[0].timestampMs) return null;
  let low = 0;
  let high = frames.length - 1;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (frames[mid].timestampMs <= timeMs) low = mid;
    else high = mid - 1;
  }
  return frames[low];
}
