import { describe, expect, it } from "vitest";

import {
  buildFrameIndex,
  colorForClass,
  countByClass,
  detectionsAt,
  type PredictionsDocument,
} from "./predictions";

const det = (class_id: number, confidence: number) => ({
  class_id,
  confidence,
  bbox: [0.1, 0.1, 0.2, 0.2] as [number, number, number, number],
});

const doc: PredictionsDocument = {
  task_type: "detection",
  model: { name: "m", version_id: 1 },
  fps: 10,
  frame_stride: 5,
  classes: ["polyp", "fold"],
  frames: {
    "5": { timestamp_ms: 500, detections: [det(1, 0.6)] },
    "0": { timestamp_ms: 0, detections: [det(0, 0.9), det(0, 0.1)] },
    "10": { timestamp_ms: 1000, detections: [] },
  },
};

describe("detectionsAt", () => {
  const index = buildFrameIndex(doc);

  it("sorts frames by time regardless of key order", () => {
    expect(index.timestamps).toEqual([0, 500, 1000]);
  });

  it("returns the nearest processed frame at or before the time", () => {
    expect(detectionsAt(index, 0)).toHaveLength(2);
    expect(detectionsAt(index, 499)).toHaveLength(2);
    expect(detectionsAt(index, 500)[0].class_id).toBe(1);
    expect(detectionsAt(index, 760)[0].class_id).toBe(1);
  });

  it("keeps showing the last frame's result past the end instead of flickering off", () => {
    expect(detectionsAt(index, 99999)).toEqual([]); // the last frame has no detections
    expect(detectionsAt(index, 1000)).toEqual([]);
  });

  it("returns nothing before the first processed frame", () => {
    expect(detectionsAt(index, -5)).toEqual([]);
  });

  it("returns nothing for an empty document", () => {
    expect(detectionsAt(buildFrameIndex({ ...doc, frames: {} }), 100)).toEqual([]);
  });
});

describe("countByClass", () => {
  it("counts only detections at or above the threshold", () => {
    expect(countByClass(buildFrameIndex(doc), 2, 0.25)).toEqual([1, 1]);
  });
});

describe("colorForClass", () => {
  it("is stable per class and distinct for neighbours", () => {
    expect(colorForClass(3)).toBe(colorForClass(3));
    expect(colorForClass(0)).not.toBe(colorForClass(1));
  });
});
