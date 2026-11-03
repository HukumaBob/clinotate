import { describe, expect, it } from "vitest";

import {
  type Episode,
  episodeSpans,
  formatRatio,
  processedStepMs,
  sortEpisodes,
} from "./evaluationLogic";

const ep = (start_ms: number, frames: number, mean_confidence: number): Episode => ({
  start_ms,
  end_ms: start_ms + 100,
  frames,
  truth: "a",
  predicted: "b",
  kind: "interior",
  mean_confidence,
  max_confidence: mean_confidence,
});

describe("sortEpisodes", () => {
  const list = [ep(300, 5, 0.5), ep(100, 5, 0.9), ep(200, 9, 0.5), ep(50, 1, 0.9)];
  it("longest: frames desc then start asc", () => {
    expect(sortEpisodes(list, "longest").map((e) => e.start_ms)).toEqual([200, 100, 300, 50]);
  });
  it("confident: confidence desc, frames desc, start asc", () => {
    expect(sortEpisodes(list, "confident").map((e) => e.start_ms)).toEqual([100, 50, 200, 300]);
  });
  it("does not mutate the input", () => {
    const copy = [...list];
    const out = sortEpisodes(list, "longest");
    expect(list).toEqual(copy);
    expect(out).not.toBe(list);
  });
});

describe("formatRatio", () => {
  it("formats null and ratios", () => {
    expect(formatRatio(null)).toBe("—");
    expect(formatRatio(0.6666)).toBe("66.7%");
    expect(formatRatio(1)).toBe("100.0%");
  });
});

describe("episodeSpans", () => {
  it("extends the end by one step", () => {
    expect(episodeSpans([ep(100, 2, 0.5)], 40)).toEqual([{ startMs: 100, endMs: 240 }]);
  });
});

describe("processedStepMs", () => {
  it("is the median gap", () => {
    expect(processedStepMs([0, 100, 200, 300])).toBe(100);
    expect(processedStepMs([0, 100, 200, 1000])).toBe(100);
  });
  it("averages the middle two gaps for an even count", () => {
    expect(processedStepMs([0, 100, 300, 600, 1000])).toBe(250);
  });
  it("is 0 for fewer than two", () => {
    expect(processedStepMs([])).toBe(0);
    expect(processedStepMs([5])).toBe(0);
  });
});
