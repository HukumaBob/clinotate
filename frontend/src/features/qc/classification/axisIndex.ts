import type { ClassificationDocument } from "./types";

/** One axis's processed frames sorted by time, as parallel arrays. */
export interface AxisIndex {
  timestamps: number[];
  classIds: number[];
  confidences: number[];
}

export function buildAxisIndexes(doc: ClassificationDocument): AxisIndex[] {
  const entries = Object.values(doc.frames).sort((a, b) => a.timestamp_ms - b.timestamp_ms);
  return doc.axes.map((_, axis) => ({
    timestamps: entries.map((entry) => entry.timestamp_ms),
    classIds: entries.map((entry) => entry.axes[axis].class_id),
    confidences: entries.map((entry) => entry.axes[axis].confidence),
  }));
}

/** Label of the nearest processed frame at or before `timeMs`; null before the first. */
export function labelAt(
  index: AxisIndex,
  timeMs: number,
): { classId: number; confidence: number } | null {
  const { timestamps } = index;
  if (timestamps.length === 0 || timeMs < timestamps[0]) return null;
  let low = 0;
  let high = timestamps.length - 1;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (timestamps[mid] <= timeMs) low = mid;
    else high = mid - 1;
  }
  return { classId: index.classIds[low], confidence: index.confidences[low] };
}
