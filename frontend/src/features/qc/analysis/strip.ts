import type { PredictionsDocument } from "../predictions";

export type StripLevel = "strong" | "moderate" | "weak" | "none";

export interface StripBucket {
  level: StripLevel;
  /** Best raw confidence of the processed frames in the bucket; 0 when none. */
  maxConfidence: number;
}

export const STRONG_CONFIDENCE = 0.7;

export const LEVEL_COLORS: Record<StripLevel, string> = {
  strong: "#22c55e",
  moderate: "#f59e0b",
  weak: "#475569",
  none: "#111827",
};

function levelFor(maxConfidence: number, threshold: number): StripLevel {
  if (maxConfidence <= 0) return "none";
  if (maxConfidence < threshold) return "weak";
  return maxConfidence >= STRONG_CONFIDENCE ? "strong" : "moderate";
}

/** One bucket per horizontal pixel of the strip. Uses the raw document, not
 * the NMS-filtered view: NMS never changes a maximum, and "weak" (the model
 * saw something below the threshold) must stay visible when the threshold
 * is high. A bucket with no processed frame inherits the previous bucket,
 * matching how the overlay holds the previous frame between stride steps. */
export function buildStrip(
  doc: PredictionsDocument,
  durationMs: number,
  buckets: number,
  threshold: number,
): StripBucket[] {
  if (buckets <= 0 || durationMs <= 0) return [];

  const maxima: (number | null)[] = new Array(buckets).fill(null);
  for (const frame of Object.values(doc.frames)) {
    const bucket = Math.min(buckets - 1, Math.floor((frame.timestamp_ms / durationMs) * buckets));
    if (bucket < 0) continue;
    let best = 0;
    for (const detection of frame.detections) {
      if (detection.confidence > best) best = detection.confidence;
    }
    maxima[bucket] = Math.max(maxima[bucket] ?? 0, best);
  }

  const result: StripBucket[] = [];
  let previous = 0;
  for (const value of maxima) {
    const maxConfidence = value ?? previous;
    previous = maxConfidence;
    result.push({ level: levelFor(maxConfidence, threshold), maxConfidence });
  }
  return result;
}

/** m:ss, for the strip tooltip. */
export function formatClock(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}
