import { describe, expect, it } from "vitest";

import type { Episode } from "./evaluationLogic";
import {
  episodeKey,
  filterSelection,
  selectionSummary,
  toRequestEpisodes,
} from "./episodeSelection";

function ep(start_ms: number, o: Partial<Episode> = {}): Episode {
  return {
    start_ms,
    end_ms: start_ms + 1000,
    frames: 10,
    truth: "a",
    predicted: "b",
    kind: "interior",
    mean_confidence: 0.8,
    max_confidence: 0.9,
    ...o,
  } as Episode;
}

const none = { interiorOnly: false, minFrames: null, minConfidence: null };

describe("filterSelection", () => {
  const eps = [
    ep(0, { kind: "boundary", frames: 3, mean_confidence: 0.5 }),
    ep(1000, { kind: "interior", frames: 5, mean_confidence: 0.7 }),
    ep(2000, { kind: "interior", frames: 9, mean_confidence: 0.95 }),
  ];
  it("returns every key with no filter", () => {
    expect(filterSelection("x", eps, none)).toEqual(["x|0", "x|1000", "x|2000"]);
  });
  it("handles an empty list", () => {
    expect(filterSelection("x", [], none)).toEqual([]);
  });
  it("interiorOnly", () => {
    expect(filterSelection("x", eps, { ...none, interiorOnly: true })).toEqual(["x|1000", "x|2000"]);
  });
  it("minFrames is inclusive", () => {
    expect(filterSelection("x", eps, { ...none, minFrames: 5 })).toEqual(["x|1000", "x|2000"]);
  });
  it("minConfidence is inclusive", () => {
    expect(filterSelection("x", eps, { ...none, minConfidence: 0.7 })).toEqual(["x|1000", "x|2000"]);
  });
  it("combines filters", () => {
    expect(
      filterSelection("x", eps, { interiorOnly: true, minFrames: 6, minConfidence: 0.9 }),
    ).toEqual(["x|2000"]);
  });
});

describe("keys", () => {
  it("round-trips an axis containing a pipe", () => {
    const key = episodeKey("a|b", { start_ms: 42 });
    expect(key).toBe("a|b|42");
    expect(toRequestEpisodes([key])).toEqual([{ axis: "a|b", start_ms: 42 }]);
  });
  it("ignores malformed keys", () => {
    expect(toRequestEpisodes(["nopipe", "x|abc", "x|", "|5", "x|7"])).toEqual([
      { axis: "x", start_ms: 7 },
    ]);
  });
});

describe("selectionSummary", () => {
  it("counts existing keys and sums frames", () => {
    const by = { x: [ep(0, { frames: 4 }), ep(1000, { frames: 6 })], y: [ep(0, { frames: 7 })] };
    expect(selectionSummary(["x|0", "x|1000", "y|0", "x|999", "z|0"], by)).toEqual({
      episodes: 3,
      frames: 17,
    });
    expect(selectionSummary([], by)).toEqual({ episodes: 0, frames: 0 });
  });
});
