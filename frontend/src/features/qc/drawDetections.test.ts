import { describe, expect, it } from "vitest";

import { drawDetections } from "./drawDetections";

function fakeContext() {
  const calls: Array<[string, ...unknown[]]> = [];
  const record = (name: string) => (...args: unknown[]) => {
    calls.push([name, ...args]);
  };
  const ctx = {
    strokeRect: record("strokeRect"),
    fillRect: record("fillRect"),
    fillText: record("fillText"),
    beginPath: record("beginPath"),
    moveTo: record("moveTo"),
    lineTo: record("lineTo"),
    closePath: record("closePath"),
    fill: record("fill"),
    stroke: record("stroke"),
    measureText: () => ({ width: 40 }),
    strokeStyle: "",
    fillStyle: "",
    lineWidth: 0,
    font: "",
    globalAlpha: 1,
  } as unknown as CanvasRenderingContext2D;
  return { ctx, calls };
}

const rect = { left: 10, top: 20, width: 200, height: 100 };

describe("drawDetections", () => {
  it("maps a normalised box into the picture rectangle, not the element box", () => {
    const { ctx, calls } = fakeContext();
    drawDetections(
      ctx,
      rect,
      [{ class_id: 0, confidence: 0.9, bbox: [0.5, 0.5, 0.25, 0.5] }],
      ["polyp"],
      0.25,
    );
    expect(calls).toContainEqual(["strokeRect", 110, 70, 50, 50]);
  });

  it("skips detections below the threshold", () => {
    const { ctx, calls } = fakeContext();
    drawDetections(
      ctx,
      rect,
      [{ class_id: 0, confidence: 0.2, bbox: [0.1, 0.1, 0.1, 0.1] }],
      ["polyp"],
      0.25,
    );
    expect(calls).toEqual([]);
  });

  it("draws a detection whose confidence equals the threshold", () => {
    const { ctx, calls } = fakeContext();
    drawDetections(
      ctx,
      rect,
      [{ class_id: 0, confidence: 0.25, bbox: [0.1, 0.1, 0.1, 0.1] }],
      ["polyp"],
      0.25,
    );
    expect(calls.some((c) => c[0] === "strokeRect")).toBe(true);
  });

  it("fills a polygon for a segmentation detection", () => {
    const { ctx, calls } = fakeContext();
    drawDetections(
      ctx,
      rect,
      [
        {
          class_id: 0,
          confidence: 0.9,
          bbox: [0.1, 0.1, 0.4, 0.4],
          polygon: [[0.1, 0.1], [0.5, 0.1], [0.5, 0.5]],
        },
      ],
      ["polyp"],
      0.25,
    );
    const names = calls.map((c) => c[0]);
    expect(names).toContain("beginPath");
    expect(names).toContain("fill");
    expect(calls).toContainEqual(["moveTo", 30, 30]);
    expect(calls).toContainEqual(["lineTo", 110, 30]);
  });

  it("labels the box with the class name and confidence", () => {
    const { ctx, calls } = fakeContext();
    drawDetections(
      ctx,
      rect,
      [{ class_id: 1, confidence: 0.876, bbox: [0.1, 0.1, 0.1, 0.1] }],
      ["polyp", "fold"],
      0.25,
    );
    expect(calls.some((c) => c[0] === "fillText" && String(c[1]).startsWith("fold 0.88"))).toBe(true);
  });

  it("falls back to the class id when the name is unknown", () => {
    const { ctx, calls } = fakeContext();
    drawDetections(
      ctx,
      rect,
      [{ class_id: 7, confidence: 0.5, bbox: [0.1, 0.1, 0.1, 0.1] }],
      [],
      0.25,
    );
    expect(calls.some((c) => c[0] === "fillText" && String(c[1]).startsWith("#7"))).toBe(true);
  });
});
