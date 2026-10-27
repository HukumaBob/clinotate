import { describe, expect, it } from "vitest";

import { flagAtTime } from "./activeFlag";

const flags = [
  { id: 1, timestamp_ms: 1000 },
  { id: 2, timestamp_ms: 5000 },
];

describe("flagAtTime", () => {
  it("finds the flag the playhead sits on", () => {
    expect(flagAtTime(flags, 5000)).toBe(2);
  });

  it("tolerates the rounding of currentTime", () => {
    expect(flagAtTime(flags, 1003)).toBe(1);
  });

  it("returns null away from every flag", () => {
    expect(flagAtTime(flags, 3000)).toBeNull();
    expect(flagAtTime([], 0)).toBeNull();
  });
});
