import { describe, expect, it } from "vitest";

import { localIsoDate } from "./localDate";

describe("localIsoDate", () => {
  it("uses the local calendar date, not the UTC one", () => {
    // Local midnight-ish: a UTC conversion could land on the previous or next day.
    expect(localIsoDate(new Date(2026, 9, 7, 0, 30))).toBe("2026-10-07");
    expect(localIsoDate(new Date(2026, 9, 7, 23, 30))).toBe("2026-10-07");
  });

  it("zero-pads month and day", () => {
    expect(localIsoDate(new Date(2026, 0, 5, 12))).toBe("2026-01-05");
  });
});
