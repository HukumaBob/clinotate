import { describe, expect, it } from "vitest";

import { findSnapSeconds, pixelToSeconds } from "./computeTimelineDrag";

describe("pixelToSeconds", () => {
  it("maps the timeline's left edge to 0 seconds", () => {
    expect(pixelToSeconds(100, { left: 100, width: 200 }, 60)).toBe(0);
  });

  it("maps the timeline's right edge to durationSeconds", () => {
    expect(pixelToSeconds(300, { left: 100, width: 200 }, 60)).toBe(60);
  });

  it("maps the midpoint proportionally", () => {
    expect(pixelToSeconds(200, { left: 100, width: 200 }, 60)).toBe(30);
  });

  it("clamps clientX below the timeline's left edge to 0", () => {
    expect(pixelToSeconds(0, { left: 100, width: 200 }, 60)).toBe(0);
  });

  it("clamps clientX past the timeline's right edge to durationSeconds", () => {
    expect(pixelToSeconds(1000, { left: 100, width: 200 }, 60)).toBe(60);
  });

  it("returns 0 when width is 0 (avoids division by zero)", () => {
    expect(pixelToSeconds(150, { left: 100, width: 0 }, 60)).toBe(0);
  });
});

describe("findSnapSeconds", () => {
  const rect = { left: 0, width: 200 };
  // 200px wide timeline, 100-second video: 2px per second.

  it("returns rawSeconds unchanged when no candidate is within snapPixels", () => {
    // clientX=60 -> 30s raw. Nearest candidate (0s @ clientX=0) is 60px away.
    const result = findSnapSeconds(30, 60, rect, 100, [0], 8);
    expect(result).toBe(30);
  });

  it("snaps to a candidate within snapPixels", () => {
    // Candidate at 30s sits at clientX=60. Cursor at clientX=63 (3px away, within 8px threshold).
    const result = findSnapSeconds(31.5, 63, rect, 100, [30], 8);
    expect(result).toBe(30);
  });

  it("resolves ties by first occurrence in candidate array", () => {
    // Candidates at 30s (clientX=60) and 31s (clientX=62); cursor at clientX=61.
    // Both are 1px away, so first-in-array (30) wins.
    const result = findSnapSeconds(30.5, 61, rect, 100, [30, 31], 8);
    expect(result).toBe(30);
  });

  it("ignores candidates outside [0, durationSeconds]", () => {
    // Candidate at -5s would sit off-screen; must not be selected even if arithmetically "close".
    const result = findSnapSeconds(30, 60, rect, 100, [-5, 30], 8);
    expect(result).toBe(30);
  });
});
