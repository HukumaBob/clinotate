import { describe, expect, it } from "vitest";

import type { FlickerEvent } from "./analysis/flicker";
import type { PredictionsDocument } from "./predictions";
import { buildReels, DEFAULT_GREY_BAND, isReviewed } from "./reels";

const det = (confidence: number, class_id = 0) => ({
  class_id,
  confidence,
  bbox: [0, 0, 1, 1] as [number, number, number, number],
});

function doc(frames: Record<number, { t: number; dets: ReturnType<typeof det>[] }>): PredictionsDocument {
  return {
    task_type: "detection",
    model: { name: "m", version_id: 1 },
    fps: 10,
    frame_stride: 1,
    classes: ["polyp", "foam"],
    frames: Object.fromEntries(
      Object.entries(frames).map(([i, f]) => [i, { timestamp_ms: f.t, detections: f.dets }]),
    ),
  };
}

const blink = (over: Partial<FlickerEvent> = {}): FlickerEvent => ({
  classId: 0, kind: "blink", startMs: 10_000, endMs: 10_200, frames: 2, ...over,
});

describe("buildReels", () => {
  it("returns nothing for an empty document and no events", () => {
    expect(buildReels(doc({}), [], DEFAULT_GREY_BAND, 60_000)).toEqual([]);
  });

  it("makes a padded clip from a flicker event with a readable reason", () => {
    const d = doc({ 100: { t: 10_000, dets: [det(0.9)] }, 102: { t: 10_200, dets: [det(0.9)] } });
    const [reel] = buildReels(d, [blink()], DEFAULT_GREY_BAND, 60_000);
    expect(reel).toMatchObject({ startMs: 9_000, endMs: 11_200, reasons: ["blink: polyp"] });
    expect(reel.frameIndices).toEqual([100, 102]);
  });

  it("includes the band edges and excludes confidences outside it", () => {
    const d = doc({
      1: { t: 5_000, dets: [det(0.25)] },
      2: { t: 20_000, dets: [det(0.5)] },
      3: { t: 40_000, dets: [det(0.24)] },
      4: { t: 50_000, dets: [det(0.51)] },
    });
    const reels = buildReels(d, [], DEFAULT_GREY_BAND, 60_000);
    expect(reels.map((r) => r.startMs)).toEqual([4_000, 19_000]);
    expect(reels.every((r) => r.reasons.includes("low confidence"))).toBe(true);
  });

  it("clamps padding to the video", () => {
    const d = doc({ 0: { t: 0, dets: [det(0.3)] }, 9: { t: 59_900, dets: [det(0.3)] } });
    const reels = buildReels(d, [], DEFAULT_GREY_BAND, 60_000);
    expect(reels[0].startMs).toBe(0);
    expect(reels[1].endMs).toBe(60_000);
  });

  it("merges moments closer than 2 s and unites their reasons", () => {
    const d = doc({ 1: { t: 10_000, dets: [det(0.9)] }, 2: { t: 11_500, dets: [det(0.3)] } });
    const reels = buildReels(d, [blink({ startMs: 10_000, endMs: 10_000 })], DEFAULT_GREY_BAND, 60_000);
    expect(reels).toHaveLength(1);
    expect(reels[0].reasons).toEqual(["blink: polyp", "low confidence"]);
    expect(reels[0].startMs).toBe(9_000);
    expect(reels[0].endMs).toBe(12_500);
  });

  it("keeps moments 2 s or more apart as separate clips", () => {
    const d = doc({ 1: { t: 10_000, dets: [det(0.3)] }, 2: { t: 12_000, dets: [det(0.3)] } });
    expect(buildReels(d, [], DEFAULT_GREY_BAND, 60_000)).toHaveLength(2);
  });

  it("falls back to a generic class name for an unknown class id", () => {
    const [reel] = buildReels(doc({}), [blink({ classId: 7, kind: "dropout" })], DEFAULT_GREY_BAND, 60_000);
    expect(reel.reasons).toEqual(["dropout: class 7"]);
  });
});

describe("isReviewed", () => {
  const reel = { startMs: 0, endMs: 1, reasons: [], frameIndices: [4, 5] };
  it("is true only when a flag lies on one of the clip's frames", () => {
    expect(isReviewed(reel, [{ frame_index: 5 }])).toBe(true);
    expect(isReviewed(reel, [{ frame_index: 9 }])).toBe(false);
    expect(isReviewed(reel, [])).toBe(false);
  });
});
