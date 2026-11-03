import { describe, expect, it } from "vitest";

import { buildAxisIndexes } from "./axisIndex";
import type { ClassificationDocument } from "./types";

const doc: ClassificationDocument = {
  task_type: "classification",
  fps: 10,
  frame_stride: 1,
  axes: [
    { name: "a", classes: ["x", "y"] },
    { name: "b", classes: ["p", "q"] },
  ],
  frames: {
    "1": {
      timestamp_ms: 200,
      axes: [
        { class_id: 1, confidence: 0.8, probs: [0.2, 0.8] },
        { class_id: 0, confidence: 0.7, probs: [0.7, 0.3] },
      ],
    },
    "0": {
      timestamp_ms: 100,
      axes: [
        { class_id: 0, confidence: 0.6, probs: [0.6, 0.4] },
        { class_id: 1, confidence: 0.9, probs: [0.1, 0.9] },
      ],
    },
  },
};

describe("buildAxisIndexes", () => {
  it("builds one time-sorted index per axis", () => {
    const [a, b] = buildAxisIndexes(doc);
    expect(a).toEqual({ timestamps: [100, 200], classIds: [0, 1], confidences: [0.6, 0.8] });
    expect(b).toEqual({ timestamps: [100, 200], classIds: [1, 0], confidences: [0.9, 0.7] });
  });
});
