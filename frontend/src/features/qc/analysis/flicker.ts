import type { FrameIndex } from "../predictions";

export type FlickerKind = "blink" | "dropout";

export interface FlickerEvent {
  classId: number;
  kind: FlickerKind;
  /** Timestamp of the first processed frame in the run. */
  startMs: number;
  /** Timestamp of the last processed frame in the run. */
  endMs: number;
  /** Number of processed frames in the run. */
  frames: number;
}

/** When the median step between processed frames times the flicker window
 * exceeds this, "a blink of 1-2 frames" means seconds and the events
 * would mislead, so the screen warns instead. */
export const COARSE_WINDOW_MS = 1000;

export interface FlickerResult {
  events: FlickerEvent[];
  isCoarse: boolean;
}

function medianStep(timestamps: number[]): number {
  if (timestamps.length < 2) return 0;
  const steps = timestamps.slice(1).map((t, i) => t - timestamps[i]).sort((a, b) => a - b);
  const middle = Math.floor(steps.length / 2);
  return steps.length % 2 ? steps[middle] : (steps[middle - 1] + steps[middle]) / 2;
}

/** Flicker by class presence over processed frames, without tracking boxes.
 * A blink is a run of presence of at most `n` frames with absence on both
 * sides; a dropout is a run of absence of at most `n` frames with presence
 * on both sides. A run that touches the start or end of the video is not an
 * event: its far boundary is unknown. */
export function findFlickers(view: FrameIndex, classCount: number, n: number): FlickerResult {
  const { timestamps, detections } = view;
  const events: FlickerEvent[] = [];

  for (let classId = 0; classId < classCount; classId++) {
    const present = detections.map((frame) => frame.some((d) => d.class_id === classId));
    let start = 0;
    while (start < present.length) {
      let end = start;
      while (end + 1 < present.length && present[end + 1] === present[start]) end++;
      const length = end - start + 1;
      const touchesEdge = start === 0 || end === present.length - 1;
      if (!touchesEdge && length <= n) {
        events.push({
          classId,
          kind: present[start] ? "blink" : "dropout",
          startMs: timestamps[start],
          endMs: timestamps[end],
          frames: length,
        });
      }
      start = end + 1;
    }
  }

  events.sort((a, b) => a.startMs - b.startMs || a.classId - b.classId);
  return { events, isCoarse: medianStep(timestamps) * n > COARSE_WINDOW_MS };
}
