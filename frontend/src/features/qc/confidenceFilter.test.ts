import { expect, it } from "vitest";

import { filterByConfidence } from "./confidenceFilter";

const doc = {
  task_type: "detection",
  model: { name: "m", version_id: 1 },
  fps: 25,
  frame_stride: 1,
  classes: ["polyp"],
  frames: {
    "0": {
      timestamp_ms: 0,
      detections: [
        { class_id: 0, confidence: 0.2, bbox: [0, 0, 1, 1] },
        { class_id: 0, confidence: 0.6, bbox: [0, 0, 1, 1] },
      ],
    },
  },
} as never;

it("drops detections below the threshold and keeps the rest of the document", () => {
  const out = filterByConfidence(doc, 0.5);
  expect(out.frames["0"].detections).toHaveLength(1);
  expect(out.classes).toEqual(["polyp"]);
});
