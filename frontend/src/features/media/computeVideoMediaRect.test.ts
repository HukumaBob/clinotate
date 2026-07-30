import { describe, expect, it } from "vitest";

import { computeVideoMediaRect } from "./computeVideoMediaRect";

describe("computeVideoMediaRect", () => {
  it("returns the full box when the video's aspect ratio matches the box exactly", () => {
    const rect = computeVideoMediaRect(1600, 900, 800, 450);
    expect(rect).toEqual({ left: 0, top: 0, width: 800, height: 450 });
  });

  it("letterboxes top/bottom when the video is relatively wider than its box", () => {
    // 16:9 video in a 4:3 box -- video is wider, so bars appear top/bottom.
    const rect = computeVideoMediaRect(1600, 900, 800, 800);
    expect(rect).not.toBeNull();
    expect(rect!.left).toBe(0);
    expect(rect!.width).toBe(800);
    expect(rect!.height).toBeCloseTo(450, 5);
    expect(rect!.top).toBeCloseTo((800 - 450) / 2, 5);
  });

  it("letterboxes left/right when the video is relatively taller than its box (e.g. near-square endoscopy footage in a wide box)", () => {
    // Near-square 1:1 video in a wide 800x300 box -- video is taller
    // relative to the box, so bars appear left/right.
    const rect = computeVideoMediaRect(1000, 1000, 800, 300);
    expect(rect).not.toBeNull();
    expect(rect!.top).toBe(0);
    expect(rect!.height).toBe(300);
    expect(rect!.width).toBeCloseTo(300, 5);
    expect(rect!.left).toBeCloseTo((800 - 300) / 2, 5);
  });

  it("returns null when any dimension is zero or negative (video metadata not yet loaded)", () => {
    expect(computeVideoMediaRect(0, 0, 800, 450)).toBeNull();
    expect(computeVideoMediaRect(1600, 900, 0, 0)).toBeNull();
  });
});
