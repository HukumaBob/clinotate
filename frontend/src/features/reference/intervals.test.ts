import { describe, expect, it } from "vitest";

import { clampEnd, coverage, decideKey, moveEdge, snapStart } from "./intervals";
import type { RefInterval } from "./types";

const iv = (id: number, categoryId: number, labelId: number, startMs: number, endMs: number): RefInterval => ({
  id,
  categoryId,
  labelId,
  startMs,
  endMs,
});

describe("snapStart", () => {
  const list = [iv(1, 1, 10, 0, 5000), iv(2, 2, 20, 0, 5900)];
  it("snaps to an end 900 ms before", () => {
    expect(snapStart(list, 1, 5900)).toBe(5000);
  });
  it("does not snap 1100 ms after an end", () => {
    expect(snapStart(list, 1, 6100)).toBe(6100);
  });
  it("snaps at exactly SNAP_MS and at the end itself", () => {
    expect(snapStart(list, 1, 6000)).toBe(5000);
    expect(snapStart(list, 1, 5000)).toBe(5000);
  });
  it("ignores other axes and ends after tMs", () => {
    expect(snapStart(list, 1, 4500)).toBe(4500);
  });
  it("picks the nearest end and handles empty lists", () => {
    const l = [iv(1, 1, 10, 0, 4800), iv(2, 1, 11, 4800, 5200)];
    expect(snapStart(l, 1, 5500)).toBe(5200);
    expect(snapStart([], 1, 300)).toBe(300);
  });
  it("does not mutate input", () => {
    const l = [iv(1, 1, 10, 0, 100)];
    const copy = structuredClone(l);
    snapStart(l, 1, 200);
    expect(l).toEqual(copy);
  });
});

describe("clampEnd", () => {
  const list = [iv(1, 1, 10, 0, 1000), iv(2, 1, 11, 3000, 4000), iv(3, 2, 20, 1500, 1600)];
  it("stops at the next interval of the axis", () => {
    expect(clampEnd(list, 1, null, 1000, 9000, 10000)).toBe(3000);
  });
  it("allows ending exactly at the next start", () => {
    expect(clampEnd(list, 1, null, 1000, 3000, 10000)).toBe(3000);
  });
  it("stops at the video end", () => {
    expect(clampEnd(list, 1, null, 4000, 99999, 8000)).toBe(8000);
  });
  it("keeps the minimum length", () => {
    expect(clampEnd(list, 1, null, 1000, 1010, 10000)).toBe(1100);
  });
  it("keeps the minimum length when the video is shorter", () => {
    expect(clampEnd([], 1, null, 0, 50, 60)).toBe(100);
  });
  it("ignores other axes and the interval itself", () => {
    expect(clampEnd(list, 1, 2, 1000, 9000, 10000)).toBe(9000);
    expect(clampEnd(list, 2, null, 0, 9000, 10000)).toBe(1500);
  });
  it("works with an empty list", () => {
    expect(clampEnd([], 1, null, 0, 500, 1000)).toBe(500);
  });
});

describe("moveEdge", () => {
  const list = [iv(1, 1, 10, 0, 1000), iv(2, 1, 11, 1000, 2000), iv(3, 1, 12, 2000, 3000)];
  it("returns null for an unknown id", () => {
    expect(moveEdge(list, 99, "start", 5, 5000)).toBeNull();
  });
  it("cannot move a start across a touching previous neighbour", () => {
    expect(moveEdge(list, 2, "start", 400, 5000)?.startMs).toBe(1000);
  });
  it("cannot move an end across a touching next neighbour", () => {
    expect(moveEdge(list, 2, "end", 2600, 5000)?.endMs).toBe(2000);
  });
  it("moves freely within bounds and returns a new object", () => {
    const r = moveEdge(list, 2, "end", 1500, 5000);
    expect(r).toEqual(iv(2, 1, 11, 1000, 1500));
    expect(r).not.toBe(list[1]);
    expect(list[1].endMs).toBe(2000);
  });
  it("keeps the minimum length", () => {
    expect(moveEdge(list, 2, "start", 1990, 5000)?.startMs).toBe(1900);
    expect(moveEdge(list, 2, "end", 1010, 5000)?.endMs).toBe(1100);
  });
  it("clamps to 0 and to the duration", () => {
    expect(moveEdge(list, 1, "start", -50, 5000)?.startMs).toBe(0);
    expect(moveEdge(list, 3, "end", 9000, 3500)?.endMs).toBe(3500);
  });
});

describe("decideKey", () => {
  const target = { categoryId: 1, labelId: 10 };
  const list = [iv(1, 1, 10, 1000, 2000), iv(5, 2, 20, 0, 9000)];
  const base = { growing: {}, selectedId: null, intervals: list };

  it("starts with snapping when nothing is growing or selected", () => {
    expect(decideKey(base, target, 2500, 10000)).toEqual({ kind: "start", startMs: 2000 });
    expect(decideKey(base, target, 5000, 10000)).toEqual({ kind: "start", startMs: 5000 });
  });
  it("starts on an empty list", () => {
    expect(decideKey({ ...base, intervals: [] }, target, 700, 10000)).toEqual({ kind: "start", startMs: 700 });
  });
  it("is none strictly inside an interval of the axis", () => {
    expect(decideKey(base, target, 1500, 10000)).toEqual({ kind: "none" });
  });
  it("is none at the start boundary (no room) and starts at the end boundary", () => {
    expect(decideKey(base, target, 1000, 10000)).toEqual({ kind: "none" });
    expect(decideKey(base, target, 2000, 10000)).toEqual({ kind: "start", startMs: 2000 });
  });
  it("relabels the selected interval of the axis", () => {
    expect(decideKey({ ...base, selectedId: 1 }, { categoryId: 1, labelId: 11 }, 1500, 10000)).toEqual({
      kind: "relabel",
      id: 1,
    });
  });
  it("ignores a selected interval of another axis", () => {
    expect(decideKey({ ...base, selectedId: 5 }, target, 5000, 10000)).toEqual({ kind: "start", startMs: 5000 });
  });
  it("closes a growing interval of the same label", () => {
    const g = iv(7, 1, 10, 3000, 3000);
    expect(decideKey({ ...base, growing: { 1: g } }, target, 4000, 10000)).toEqual({
      kind: "close",
      id: 7,
      endMs: 4000,
    });
  });
  it("closes exactly at the next interval's start", () => {
    const g = iv(7, 1, 10, 100, 100);
    const next = iv(8, 1, 11, 500, 900);
    expect(decideKey({ growing: { 1: g }, selectedId: null, intervals: [next] }, target, 500, 10000)).toEqual({
      kind: "close",
      id: 7,
      endMs: 500,
    });
  });
  it("clamps a close past the next interval or the video end", () => {
    const g = iv(7, 1, 10, 100, 100);
    const next = iv(8, 1, 11, 500, 900);
    expect(decideKey({ growing: { 1: g }, selectedId: null, intervals: [next] }, target, 700, 10000)).toEqual({
      kind: "close",
      id: 7,
      endMs: 500,
    });
    expect(decideKey({ growing: { 1: g }, selectedId: null, intervals: [] }, target, 700, 600)).toEqual({
      kind: "close",
      id: 7,
      endMs: 600,
    });
  });
  it("keeps the minimum length when closing very early", () => {
    const g = iv(7, 1, 10, 100, 100);
    expect(decideKey({ ...base, intervals: [], growing: { 1: g } }, target, 120, 10000)).toEqual({
      kind: "close",
      id: 7,
      endMs: 200,
    });
  });
  it("switches when the growing interval has another label", () => {
    const g = iv(7, 1, 11, 3000, 3000);
    expect(decideKey({ ...base, growing: { 1: g } }, target, 4000, 10000)).toEqual({
      kind: "switch",
      closeId: 7,
      closeEndMs: 4000,
      startMs: 4000,
    });
  });
  it("a growing interval on another axis does not affect this one", () => {
    const g = iv(7, 2, 21, 3000, 3000);
    expect(decideKey({ ...base, growing: { 2: g } }, target, 5000, 10000)).toEqual({ kind: "start", startMs: 5000 });
  });
});

describe("decideKey room and switch boundaries", () => {
  const target = { categoryId: 1, labelId: 10 };
  it("is none when a neighbour starts exactly at the start (zero room)", () => {
    const intervals = [iv(1, 1, 11, 1000, 2000)];
    expect(decideKey({ growing: {}, selectedId: null, intervals }, target, 1000, 10000)).toEqual({ kind: "none" });
  });
  it("is none with 99 ms of room and starts with exactly 100 ms", () => {
    const at = (s: number) => [iv(1, 1, 11, s, s + 500)];
    expect(decideKey({ growing: {}, selectedId: null, intervals: at(1099) }, target, 1000, 10000)).toEqual({ kind: "none" });
    expect(decideKey({ growing: {}, selectedId: null, intervals: at(1100) }, target, 1000, 10000)).toEqual({
      kind: "start",
      startMs: 1000,
    });
  });
  it("is none with too little room before the video end", () => {
    expect(decideKey({ growing: {}, selectedId: null, intervals: [] }, target, 9950, 10000)).toEqual({ kind: "none" });
  });
  it("switch starts at the clamped close time, past the next interval", () => {
    const g = iv(7, 1, 11, 100, 100);
    const next = iv(8, 1, 12, 2000, 5000);
    expect(decideKey({ growing: { 1: g }, selectedId: null, intervals: [next] }, target, 3000, 10000)).toEqual({
      kind: "close",
      id: 7,
      endMs: 2000,
    });
  });
  it("switch starts at the clamped close time when tMs is under the minimum", () => {
    const g = iv(7, 1, 11, 1000, 1000);
    expect(decideKey({ growing: { 1: g }, selectedId: null, intervals: [] }, target, 1050, 10000)).toEqual({
      kind: "switch",
      closeId: 7,
      closeEndMs: 1100,
      startMs: 1100,
    });
  });
  it("switch with 99 ms of room only closes; with 100 ms it switches", () => {
    const g = iv(7, 1, 11, 100, 100);
    const next = (s: number) => iv(8, 1, 12, s, s + 500);
    expect(decideKey({ growing: { 1: g }, selectedId: null, intervals: [next(1099)] }, target, 1000, 10000)).toEqual({
      kind: "close",
      id: 7,
      endMs: 1000,
    });
    expect(decideKey({ growing: { 1: g }, selectedId: null, intervals: [next(1100)] }, target, 1000, 10000)).toEqual({
      kind: "switch",
      closeId: 7,
      closeEndMs: 1000,
      startMs: 1000,
    });
  });
  it("growing wins over a selected interval on the same axis", () => {
    const g = iv(7, 1, 10, 3000, 3000);
    const sel = iv(1, 1, 11, 0, 1000);
    expect(decideKey({ growing: { 1: g }, selectedId: 1, intervals: [sel] }, target, 4000, 10000)).toEqual({
      kind: "close",
      id: 7,
      endMs: 4000,
    });
  });
  it("does not snap at SNAP_MS + 1", () => {
    expect(snapStart([iv(1, 1, 10, 0, 5000)], 1, 6001)).toBe(6001);
  });
});

describe("moveEdge end without room", () => {
  it("returns the interval unchanged when the room cannot hold the minimum", () => {
    const list = [iv(1, 1, 10, 1000, 1050)];
    const r = moveEdge(list, 1, "end", 1800, 1099);
    expect(r).toEqual(list[0]);
    expect(r).not.toBe(list[0]);
  });
  it("moves normally with exactly the minimum room", () => {
    const list = [iv(1, 1, 10, 1000, 1500), iv(2, 1, 11, 1600, 2000)];
    expect(moveEdge(list, 1, "end", 1800, 5000)?.endMs).toBe(1600);
  });
  it("is unchanged when the video end leaves no room", () => {
    const list = [iv(1, 1, 10, 1000, 1050)];
    expect(moveEdge(list, 1, "end", 1800, 1050)).toEqual(list[0]);
  });
});

describe("coverage", () => {
  it("clips an interval overhanging the video end", () => {
    expect(coverage([iv(1, 1, 10, 500, 2000)], 1, 1000)).toBe(0.5);
  });
  it("is covered ms over duration with a gap", () => {
    const l = [iv(1, 1, 10, 0, 1000), iv(2, 1, 10, 3000, 4000), iv(3, 2, 20, 0, 4000)];
    expect(coverage(l, 1, 4000)).toBe(0.5);
  });
  it("is 0 for no intervals or non-positive duration", () => {
    expect(coverage([], 1, 1000)).toBe(0);
    expect(coverage([iv(1, 1, 10, 0, 100)], 1, 0)).toBe(0);
  });
  it("never exceeds 1", () => {
    expect(coverage([iv(1, 1, 10, 0, 2000)], 1, 1000)).toBe(1);
  });
});
