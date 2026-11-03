import { describe, expect, it } from "vitest";

import type { AxisIndex } from "./axisIndex";
import { findBlips, mergeBlips } from "./blips";

const seq = (s: string): AxisIndex => {
  const ids = [...s].map((c) => c.charCodeAt(0) - 65);
  return { timestamps: ids.map((_, i) => i * 100), classIds: ids, confidences: ids.map(() => 1) };
};

describe("findBlips", () => {
  it("finds a stretch between the same label", () => {
    expect(findBlips(seq("AABAA"), 1, 2)).toEqual([
      { axis: 1, classId: 1, surroundingClassId: 0, startMs: 200, endMs: 300, frames: 1 },
    ]);
  });
  it("ignores stretches touching the start or end", () => {
    expect(findBlips(seq("BAAA"), 0, 2)).toEqual([]);
    expect(findBlips(seq("AAAB"), 0, 2)).toEqual([]);
  });
  it("reports consecutive blips", () => {
    const blips = findBlips(seq("ABACA"), 0, 2);
    expect(blips.map((b) => b.startMs)).toEqual([100, 300]);
    expect(blips.map((b) => b.classId)).toEqual([1, 2]);
  });
  it("is not a blip when neighbours differ", () => {
    expect(findBlips(seq("ABC"), 0, 2)).toEqual([]);
  });
  it("counts processed frames against n", () => {
    expect(findBlips(seq("ABBBA"), 0, 2)).toEqual([]);
    expect(findBlips(seq("ABBA"), 0, 2)).toHaveLength(1);
  });
  it("handles empty and single-frame input", () => {
    expect(findBlips(seq(""), 0, 2)).toEqual([]);
    expect(findBlips(seq("A"), 0, 2)).toEqual([]);
  });
});

describe("mergeBlips", () => {
  it("sorts by start then axis", () => {
    const a = findBlips(seq("ABA"), 1, 2);
    const b = findBlips(seq("ABA"), 0, 2);
    const c = findBlips(seq("AABA"), 0, 2);
    expect(mergeBlips([a, b, c]).map((x) => [x.startMs, x.axis])).toEqual([
      [100, 0],
      [100, 1],
      [200, 0],
    ]);
  });
});
