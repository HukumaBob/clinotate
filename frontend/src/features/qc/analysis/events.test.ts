import { describe, expect, it } from "vitest";

import type { FlickerEvent } from "./flicker";
import { nextEvent, prevEvent } from "./events";

const event = (startMs: number): FlickerEvent => ({
  classId: 0,
  kind: "blink",
  startMs,
  endMs: startMs + 40,
  frames: 1,
});
const events = [event(1000), event(2000), event(3000)];

describe("nextEvent", () => {
  it("returns the first event strictly after the time", () => {
    expect(nextEvent(events, 0)?.startMs).toBe(1000);
    expect(nextEvent(events, 1500)?.startMs).toBe(2000);
  });

  it("skips the event the playhead is already on", () => {
    expect(nextEvent(events, 1000)?.startMs).toBe(2000);
    expect(nextEvent(events, 1000.5)?.startMs).toBe(2000);
  });

  it("returns null past the last event", () => {
    expect(nextEvent(events, 3000)).toBeNull();
    expect(nextEvent([], 0)).toBeNull();
  });
});

describe("prevEvent", () => {
  it("returns the last event strictly before the time", () => {
    expect(prevEvent(events, 3500)?.startMs).toBe(3000);
    expect(prevEvent(events, 2500)?.startMs).toBe(2000);
  });

  it("skips the event the playhead is already on", () => {
    expect(prevEvent(events, 3000)?.startMs).toBe(2000);
  });

  it("returns null before the first event", () => {
    expect(prevEvent(events, 1000)).toBeNull();
    expect(prevEvent([], 5000)).toBeNull();
  });
});
