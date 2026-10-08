import { describe, expect, it } from "vitest";

import { comparability, flagKindForWrongSide, nextDisagreement } from "./compareLogic";

const run = (over: Record<string, unknown> = {}) =>
  ({ id: 1, video_id: 7, frame_stride: 1, status: "succeeded", ...over }) as never;

describe("comparability", () => {
  it("accepts two finished runs of one video with equal stride", () => {
    expect(comparability(run({ id: 1 }), run({ id: 2 }))).toEqual({ ok: true });
  });
  it.each([
    [run({ id: 1 }), run({ id: 1 }), /different runs/i],
    [run({ id: 1 }), run({ id: 2, video_id: 8 }), /different videos/i],
    [run({ id: 1 }), run({ id: 2, frame_stride: 5 }), /stride/i],
    [run({ id: 1 }), run({ id: 2, status: "running" }), /finished/i],
    [undefined, run({ id: 2 }), /two runs/i],
  ])("explains why not", (a, b, reason) => {
    const result = comparability(a, b);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(reason);
  });
});

describe("flagKindForWrongSide", () => {
  it("is fp when the wrong side found a class the other did not", () => {
    expect(flagKindForWrongSide("a", { only_a: ["polyp"], only_b: [] })).toBe("fp");
    expect(flagKindForWrongSide("b", { only_a: [], only_b: ["polyp"] })).toBe("fp");
  });
  it("is fn when the wrong side missed a class the other found", () => {
    expect(flagKindForWrongSide("a", { only_a: [], only_b: ["polyp"] })).toBe("fn");
    expect(flagKindForWrongSide("b", { only_a: ["polyp"], only_b: [] })).toBe("fn");
  });
  it("prefers fp when both sides have exclusive classes", () => {
    expect(flagKindForWrongSide("a", { only_a: ["x"], only_b: ["y"] })).toBe("fp");
  });
});

describe("nextDisagreement", () => {
  const times = [100, 400, 900];
  it("moves strictly forward and backward without wrapping", () => {
    expect(nextDisagreement(times, 100, 1)).toBe(400);
    expect(nextDisagreement(times, 250, 1)).toBe(400);
    expect(nextDisagreement(times, 900, 1)).toBeNull();
    expect(nextDisagreement(times, 400, -1)).toBe(100);
    expect(nextDisagreement(times, 100, -1)).toBeNull();
    expect(nextDisagreement([], 0, 1)).toBeNull();
  });
});
