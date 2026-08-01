import { describe, expect, it } from "vitest";

import { formatTimestamp } from "./formatTimestamp";

describe("formatTimestamp", () => {
  it("formats whole seconds under a minute as 00:ss", () => {
    expect(formatTimestamp(5)).toBe("00:05");
  });

  it("formats minutes and seconds as mm:ss", () => {
    expect(formatTimestamp(135)).toBe("02:15");
  });

  it("truncates fractional seconds", () => {
    expect(formatTimestamp(135.9)).toBe("02:15");
  });

  it("pads minutes past two digits without truncating them", () => {
    expect(formatTimestamp(3661)).toBe("61:01");
  });

  it("formats zero as 00:00", () => {
    expect(formatTimestamp(0)).toBe("00:00");
  });
});
