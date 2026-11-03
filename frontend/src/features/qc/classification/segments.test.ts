import { describe, expect, it } from "vitest";

import type { AxisIndex } from "./axisIndex";
import { labelAt } from "./axisIndex";
import { buildSegments } from "./segments";

const idx = (classIds: number[], step = 100): AxisIndex => ({
  timestamps: classIds.map((_, i) => i * step),
  classIds,
  confidences: classIds.map(() => 0.9),
});

describe("labelAt", () => {
  const index = { timestamps: [100, 200], classIds: [3, 4], confidences: [0.5, 0.6] };
  it("is null before the first frame", () => {
    expect(labelAt(index, 99)).toBeNull();
  });
  it("holds the previous frame between processed frames", () => {
    expect(labelAt(index, 150)).toEqual({ classId: 3, confidence: 0.5 });
    expect(labelAt(index, 200)).toEqual({ classId: 4, confidence: 0.6 });
    expect(labelAt(index, 9999)).toEqual({ classId: 4, confidence: 0.6 });
  });
  it("is null for an empty index", () => {
    expect(labelAt({ timestamps: [], classIds: [], confidences: [] }, 0)).toBeNull();
  });
});

describe("buildSegments", () => {
  it("builds run-length segments", () => {
    expect(buildSegments(idx([0, 0, 1, 1, 1, 0]), 600)).toEqual([
      { classId: 0, startMs: 0, endMs: 200, frames: 2 },
      { classId: 1, startMs: 200, endMs: 500, frames: 3 },
      { classId: 0, startMs: 500, endMs: 600, frames: 1 },
    ]);
  });
  it("gives one segment for equal labels", () => {
    expect(buildSegments(idx([2, 2, 2]), 1000)).toEqual([
      { classId: 2, startMs: 0, endMs: 1000, frames: 3 },
    ]);
  });
  it("ends the last segment at the last timestamp when the duration is shorter", () => {
    expect(buildSegments(idx([0, 1]), 50)[1].endMs).toBe(100);
  });
  it("returns [] for an empty index", () => {
    expect(buildSegments(idx([]), 1000)).toEqual([]);
  });
});
