import type { FlickerEvent } from "./analysis/flicker";
import type { PredictionsDocument } from "./predictions";

export interface GreyBand {
  low: number;
  high: number;
}

/** Detections the model is unsure about. Inclusive at both ends. */
export const DEFAULT_GREY_BAND: GreyBand = { low: 0.25, high: 0.5 };
export const REEL_PAD_MS = 1000;
export const REEL_MERGE_GAP_MS = 2000;

export interface Reel {
  startMs: number;
  endMs: number;
  reasons: string[];
  /** Processed frames inside the clip, by time. */
  frameIndices: number[];
}

interface Moment {
  startMs: number;
  endMs: number;
  reason: string;
}

export function buildReels(
  doc: PredictionsDocument,
  flickerEvents: FlickerEvent[],
  band: GreyBand,
  durationMs: number,
): Reel[] {
  const frames = Object.entries(doc.frames)
    .map(([key, frame]) => ({ index: Number(key), t: frame.timestamp_ms, detections: frame.detections }))
    .sort((a, b) => a.t - b.t);

  const moments: Moment[] = flickerEvents.map((event) => ({
    startMs: event.startMs,
    endMs: event.endMs,
    reason: `${event.kind}: ${doc.classes[event.classId] ?? `class ${event.classId}`}`,
  }));
  for (const frame of frames) {
    if (frame.detections.some((d) => d.confidence >= band.low && d.confidence <= band.high)) {
      moments.push({ startMs: frame.t, endMs: frame.t, reason: "low confidence" });
    }
  }
  moments.sort((a, b) => a.startMs - b.startMs);

  // Merge by the gap between raw moments, then pad.
  const groups: Moment[][] = [];
  let groupEnd = -Infinity;
  for (const moment of moments) {
    if (groups.length > 0 && moment.startMs - groupEnd < REEL_MERGE_GAP_MS) {
      groups[groups.length - 1].push(moment);
      groupEnd = Math.max(groupEnd, moment.endMs);
    } else {
      groups.push([moment]);
      groupEnd = moment.endMs;
    }
  }

  return groups.map((group) => {
    const startMs = Math.max(0, Math.min(...group.map((m) => m.startMs)) - REEL_PAD_MS);
    const endMs = Math.min(durationMs, Math.max(...group.map((m) => m.endMs)) + REEL_PAD_MS);
    return {
      startMs,
      endMs,
      reasons: [...new Set(group.map((m) => m.reason))],
      frameIndices: frames.filter((f) => f.t >= startMs && f.t <= endMs).map((f) => f.index),
    };
  });
}

export function isReviewed(reel: Reel, flags: { frame_index: number }[]): boolean {
  const inside = new Set(reel.frameIndices);
  return flags.some((flag) => inside.has(flag.frame_index));
}
