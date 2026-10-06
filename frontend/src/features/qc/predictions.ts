export interface Detection {
  class_id: number;
  confidence: number;
  /** [x, y, w, h], normalised 0..1, (x, y) the top-left corner. */
  bbox: [number, number, number, number];
  polygon?: [number, number][];
}

export interface TimingStats {
  mean: number;
  p50: number;
  p95: number;
  max: number;
}

/** Aggregates of the model's per-frame timings, in milliseconds. Absent on
 * runs made before timing was recorded. Model time only: video decoding is
 * not included. */
export interface Timing {
  frames_measured: number;
  preprocess_ms: TimingStats;
  inference_ms: TimingStats;
  postprocess_ms: TimingStats;
  total_ms: TimingStats;
  model_fps: number;
}

export interface PredictionsDocument {
  task_type: "detection" | "segmentation";
  model: { name: string; version_id: number | null };
  fps: number;
  frame_stride: number;
  classes: string[];
  frames: Record<string, { timestamp_ms: number; detections: Detection[] }>;
  timing?: Timing;
}

/** Processed frames sorted by time, so playback can binary-search them. */
export interface FrameIndex {
  timestamps: number[];
  detections: Detection[][];
}

/** The Ultralytics default. A slider replaces this in sub-project 2. */
export const DISPLAY_CONFIDENCE_THRESHOLD = 0.25;

export function buildFrameIndex(doc: PredictionsDocument): FrameIndex {
  const entries = Object.values(doc.frames).sort((a, b) => a.timestamp_ms - b.timestamp_ms);
  return {
    timestamps: entries.map((entry) => entry.timestamp_ms),
    detections: entries.map((entry) => entry.detections),
  };
}

/** Detections of the nearest processed frame at or before `timeMs`.
 * With a stride above 1 most playback times fall between processed
 * frames; holding the previous frame's result (rather than showing
 * nothing) keeps the overlay from flickering. */
export function detectionsAt(index: FrameIndex, timeMs: number): Detection[] {
  const { timestamps, detections } = index;
  if (timestamps.length === 0 || timeMs < timestamps[0]) return [];
  let low = 0;
  let high = timestamps.length - 1;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (timestamps[mid] <= timeMs) low = mid;
    else high = mid - 1;
  }
  return detections[low];
}

export function countByClass(index: FrameIndex, classCount: number, threshold: number): number[] {
  const counts = new Array<number>(classCount).fill(0);
  for (const frame of index.detections) {
    for (const detection of frame) {
      if (detection.confidence >= threshold && detection.class_id < classCount) {
        counts[detection.class_id] += 1;
      }
    }
  }
  return counts;
}

/** One palette for every run, so a class keeps its colour between runs.
 * The golden angle spreads neighbouring ids far apart on the hue wheel. */
export function colorForClass(classId: number): string {
  const hue = (classId * 137.508) % 360;
  return `hsl(${hue.toFixed(0)}, 85%, 60%)`;
}
