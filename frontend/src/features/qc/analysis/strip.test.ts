import { describe, expect, it } from "vitest";

import type { Detection, PredictionsDocument } from "../predictions";
import { LEVEL_COLORS, STRONG_CONFIDENCE, buildStrip, formatClock } from "./strip";

const det = (confidence: number): Detection => ({ class_id: 0, confidence, bbox: [0, 0, 0.1, 0.1] });

const doc = (frames: Record<string, { timestamp_ms: number; detections: Detection[] }>): PredictionsDocument => ({
  task_type: "detection",
  model: { name: "m", version_id: 1 },
  fps: 10,
  frame_stride: 1,
  classes: ["polyp"],
  frames,
});

const levels = (buckets: ReturnType<typeof buildStrip>) => buckets.map((b) => b.level);

describe("buildStrip", () => {
  it("classifies buckets by the best confidence in them", () => {
    const strip = buildStrip(
      doc({
        a: { timestamp_ms: 0, detections: [det(0.9)] },
        b: { timestamp_ms: 250, detections: [det(0.4)] },
        c: { timestamp_ms: 500, detections: [det(0.1)] },
        d: { timestamp_ms: 750, detections: [] },
      }),
      1000,
      4,
      0.25,
    );
    expect(levels(strip)).toEqual(["strong", "moderate", "weak", "none"]);
    expect(strip[0].maxConfidence).toBe(0.9);
    expect(strip[3].maxConfidence).toBe(0);
    expect(STRONG_CONFIDENCE).toBe(0.7);
  });

  it("takes the maximum across several frames in one bucket", () => {
    const strip = buildStrip(
      doc({
        a: { timestamp_ms: 0, detections: [det(0.3)] },
        b: { timestamp_ms: 100, detections: [det(0.8)] },
      }),
      1000,
      1,
      0.25,
    );
    expect(strip[0]).toEqual({ level: "strong", maxConfidence: 0.8 });
  });

  it("an empty bucket inherits the previous one, like the overlay holds a frame", () => {
    const strip = buildStrip(
      doc({ a: { timestamp_ms: 0, detections: [det(0.9)] } }),
      1000,
      4,
      0.25,
    );
    expect(levels(strip)).toEqual(["strong", "strong", "strong", "strong"]);
  });

  it("buckets before the first processed frame are none", () => {
    const strip = buildStrip(
      doc({ a: { timestamp_ms: 600, detections: [det(0.9)] } }),
      1000,
      4,
      0.25,
    );
    expect(levels(strip)).toEqual(["none", "none", "strong", "strong"]);
  });

  it("a threshold above 0.7 turns a 0.75 bucket weak, never green", () => {
    const strip = buildStrip(doc({ a: { timestamp_ms: 0, detections: [det(0.75)] } }), 1000, 1, 0.9);
    expect(strip[0].level).toBe("weak");
  });

  it("a frame exactly at the duration lands in the last bucket", () => {
    const strip = buildStrip(doc({ a: { timestamp_ms: 1000, detections: [det(0.9)] } }), 1000, 4, 0.25);
    expect(strip[3].level).toBe("strong");
  });

  it("is all none for a document with no detections or no frames", () => {
    expect(levels(buildStrip(doc({ a: { timestamp_ms: 0, detections: [] } }), 1000, 3, 0.25))).toEqual([
      "none",
      "none",
      "none",
    ]);
    expect(levels(buildStrip(doc({}), 1000, 3, 0.25))).toEqual(["none", "none", "none"]);
  });

  it("returns nothing for zero buckets or a zero duration", () => {
    expect(buildStrip(doc({}), 1000, 0, 0.25)).toEqual([]);
    expect(buildStrip(doc({}), 0, 5, 0.25)).toEqual([]);
  });
});

describe("LEVEL_COLORS and formatClock", () => {
  it("has a colour for every level", () => {
    expect(Object.keys(LEVEL_COLORS).sort()).toEqual(["moderate", "none", "strong", "weak"]);
  });

  it("formats milliseconds as m:ss", () => {
    expect(formatClock(0)).toBe("0:00");
    expect(formatClock(202000)).toBe("3:22");
    expect(formatClock(59999)).toBe("0:59");
    expect(formatClock(3600000)).toBe("60:00");
  });
});
