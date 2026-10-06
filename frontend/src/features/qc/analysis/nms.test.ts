import { describe, expect, it } from "vitest";

import type { Detection } from "../predictions";
import { iou, nms } from "./nms";

const det = (class_id: number, confidence: number, bbox: Detection["bbox"]): Detection => ({
  class_id,
  confidence,
  bbox,
});

describe("iou", () => {
  it("is 1 for identical boxes and 0 for disjoint ones", () => {
    expect(iou([0, 0, 0.5, 0.5], [0, 0, 0.5, 0.5])).toBe(1);
    expect(iou([0, 0, 0.2, 0.2], [0.5, 0.5, 0.2, 0.2])).toBe(0);
  });

  it("is a third for two unit boxes overlapping by half", () => {
    expect(iou([0, 0, 1, 1], [0.5, 0, 1, 1])).toBeCloseTo(1 / 3, 6);
  });

  it("is 0 for boxes that only touch", () => {
    expect(iou([0, 0, 0.5, 0.5], [0.5, 0, 0.5, 0.5])).toBe(0);
  });
});

describe("nms", () => {
  const a = det(0, 0.9, [0, 0, 1, 1]);
  const half = det(0, 0.6, [0, 0, 0.5, 1]); // IoU with a is exactly 0.5

  it("drops the less confident of two same-class boxes at or above the IoU", () => {
    expect(nms([half, a], 0.5)).toEqual([a]);
    expect(nms([half, a], 0.4)).toEqual([a]);
  });

  it("keeps both when their IoU is below the limit", () => {
    expect(nms([a, half], 0.51)).toEqual([a, half]);
  });

  it("is class aware: overlapping boxes of different classes both survive", () => {
    const other = det(1, 0.6, [0, 0, 0.5, 1]);
    expect(nms([a, other], 0.3)).toEqual([a, other]);
  });

  it("returns boxes ordered by confidence, highest first", () => {
    const far = det(0, 0.7, [0, 0, 0.1, 0.1]);
    expect(nms([far, a], 0.5).map((d) => d.confidence)).toEqual([0.9, 0.7]);
  });

  it("collapses identical boxes to one", () => {
    expect(nms([a, { ...a }, { ...a }], 0.5)).toHaveLength(1);
  });

  it("handles an empty list", () => {
    expect(nms([], 0.5)).toEqual([]);
  });
});
