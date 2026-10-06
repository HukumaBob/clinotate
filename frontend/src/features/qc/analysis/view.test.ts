import { describe, expect, it } from "vitest";

import type { Detection, PredictionsDocument } from "../predictions";
import { DEFAULT_VIEW_PARAMS, NMS_OFF, buildView } from "./view";

const det = (class_id: number, confidence: number, bbox: Detection["bbox"] = [0, 0, 1, 1]): Detection => ({
  class_id,
  confidence,
  bbox,
});

const doc = (frames: Record<string, { timestamp_ms: number; detections: Detection[] }>): PredictionsDocument => ({
  task_type: "detection",
  model: { name: "m", version_id: 1 },
  fps: 10,
  frame_stride: 1,
  classes: ["polyp", "fold"],
  frames,
});

describe("buildView", () => {
  it("defaults match the spec", () => {
    expect(DEFAULT_VIEW_PARAMS).toEqual({ threshold: 0.25, nmsIou: 0.7, flickerN: 2 });
    expect(NMS_OFF).toBe(0.7);
  });

  it("sorts processed frames by time", () => {
    const view = buildView(
      doc({ "5": { timestamp_ms: 500, detections: [] }, "0": { timestamp_ms: 0, detections: [] } }),
      { threshold: 0.25, nmsIou: 0.7 },
    );
    expect(view.timestamps).toEqual([0, 500]);
  });

  it("keeps a detection exactly at the threshold and drops one just below", () => {
    const view = buildView(
      doc({ "0": { timestamp_ms: 0, detections: [det(0, 0.25), det(0, 0.2499)] } }),
      { threshold: 0.25, nmsIou: 0.7 },
    );
    expect(view.detections[0].map((d) => d.confidence)).toEqual([0.25]);
  });

  it("does not run NMS at 0.70, where it is off (identical boxes both stay)", () => {
    const view = buildView(
      doc({ "0": { timestamp_ms: 0, detections: [det(0, 0.9), det(0, 0.8)] } }),
      { threshold: 0.25, nmsIou: 0.7 },
    );
    expect(view.detections[0]).toHaveLength(2);
  });

  it("runs class-aware NMS below 0.70", () => {
    const view = buildView(
      doc({
        "0": {
          timestamp_ms: 0,
          detections: [det(0, 0.9), det(0, 0.8), det(1, 0.8)],
        },
      }),
      { threshold: 0.25, nmsIou: 0.5 },
    );
    expect(view.detections[0].map((d) => [d.class_id, d.confidence])).toEqual([
      [0, 0.9],
      [1, 0.8],
    ]);
  });

  it("a hidden box never suppresses a visible one", () => {
    const view = buildView(
      doc({ "0": { timestamp_ms: 0, detections: [det(0, 0.9), det(0, 0.4)] } }),
      { threshold: 0.5, nmsIou: 0.5 },
    );
    expect(view.detections[0].map((d) => d.confidence)).toEqual([0.9]);
  });

  it("gives empty frames for a document where everything is below the threshold", () => {
    const view = buildView(
      doc({ "0": { timestamp_ms: 0, detections: [det(0, 0.1)] }, "1": { timestamp_ms: 100, detections: [det(0, 0.05)] } }),
      { threshold: 0.25, nmsIou: 0.5 },
    );
    expect(view.detections).toEqual([[], []]);
  });

  it("handles a document with no frames", () => {
    expect(buildView(doc({}), { threshold: 0.25, nmsIou: 0.5 })).toEqual({ timestamps: [], detections: [] });
  });
});
