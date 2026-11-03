import type { AxisIndex } from "./axisIndex";
import { buildSegments } from "./segments";

export interface Blip {
  axis: number;
  classId: number;
  surroundingClassId: number;
  startMs: number;
  endMs: number;
  frames: number;
}

/** Stretches of at most `n` processed frames whose two neighbours carry the
 * same other label (A, B, A). A stretch touching the start or end of the
 * video is never a blip, mirroring flicker detection. */
export function findBlips(index: AxisIndex, axis: number, n: number): Blip[] {
  const segments = buildSegments(index, 0);
  const blips: Blip[] = [];
  for (let i = 1; i < segments.length - 1; i++) {
    const segment = segments[i];
    const before = segments[i - 1];
    const after = segments[i + 1];
    if (segment.frames <= n && before.classId === after.classId) {
      blips.push({
        axis,
        classId: segment.classId,
        surroundingClassId: before.classId,
        startMs: segment.startMs,
        endMs: segment.endMs,
        frames: segment.frames,
      });
    }
  }
  return blips;
}

export function mergeBlips(perAxis: Blip[][]): Blip[] {
  return perAxis.flat().sort((a, b) => a.startMs - b.startMs || a.axis - b.axis);
}
