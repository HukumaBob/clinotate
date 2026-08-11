import { describe, expect, it } from "vitest";

import { clampTrackRange } from "./clampTrackRange";

describe("clampTrackRange", () => {
  it("leaves a value untouched when it already fits every bound", () => {
    const result = clampTrackRange(
      { backward: 3, forward: 4 },
      { maxBackward: 10, maxForward: 10, combinedCap: 20 },
    );
    expect(result).toEqual({ backward: 3, forward: 4 });
  });

  it("clamps backward down to the frames actually available behind the current frame", () => {
    const result = clampTrackRange(
      { backward: 8, forward: 2 },
      { maxBackward: 3, maxForward: 10, combinedCap: 20 },
    );
    expect(result).toEqual({ backward: 3, forward: 2 });
  });

  it("clamps forward down to the frames actually available ahead of the current frame", () => {
    const result = clampTrackRange(
      { backward: 2, forward: 8 },
      { maxBackward: 10, maxForward: 3, combinedCap: 20 },
    );
    expect(result).toEqual({ backward: 2, forward: 3 });
  });

  it("shrinks forward first when the combined total exceeds the cap", () => {
    const result = clampTrackRange(
      { backward: 5, forward: 8 },
      { maxBackward: 10, maxForward: 10, combinedCap: 10 },
    );
    expect(result).toEqual({ backward: 5, forward: 5 });
  });

  it("shrinks backward too when forward alone can't absorb the whole overage", () => {
    const result = clampTrackRange(
      { backward: 8, forward: 2 },
      { maxBackward: 10, maxForward: 10, combinedCap: 5 },
    );
    expect(result).toEqual({ backward: 5, forward: 0 });
  });

  it("applies the per-sequence bound before the combined cap, not instead of it", () => {
    // backward=8 is clamped to maxBackward=6 first (6+2=8), which already
    // fits combinedCap=10, so no further trimming happens.
    const result = clampTrackRange(
      { backward: 8, forward: 2 },
      { maxBackward: 6, maxForward: 10, combinedCap: 10 },
    );
    expect(result).toEqual({ backward: 6, forward: 2 });
  });

  it("never produces a negative value", () => {
    const result = clampTrackRange(
      { backward: -5, forward: -3 },
      { maxBackward: 10, maxForward: 10, combinedCap: 20 },
    );
    expect(result).toEqual({ backward: 0, forward: 0 });
  });
});
