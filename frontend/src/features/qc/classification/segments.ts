import type { AxisIndex } from "./axisIndex";

export interface Segment {
  classId: number;
  startMs: number;
  endMs: number;
  /** Processed frames in the segment. */
  frames: number;
}

/** Run-length segments of one axis. A segment ends where the next begins;
 * the last ends at the video duration (or its last timestamp if later). */
export function buildSegments(index: AxisIndex, durationMs: number): Segment[] {
  const { timestamps, classIds } = index;
  if (timestamps.length === 0) return [];
  const segments: Segment[] = [];
  for (let i = 0; i < timestamps.length; i++) {
    const last = segments[segments.length - 1];
    if (last && last.classId === classIds[i]) {
      last.frames += 1;
    } else {
      if (last) last.endMs = timestamps[i];
      segments.push({ classId: classIds[i], startMs: timestamps[i], endMs: timestamps[i], frames: 1 });
    }
  }
  segments[segments.length - 1].endMs = Math.max(durationMs, timestamps[timestamps.length - 1]);
  return segments;
}
