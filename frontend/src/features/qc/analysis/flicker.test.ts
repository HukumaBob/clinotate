import { describe, expect, it } from "vitest";

import type { Detection, FrameIndex } from "../predictions";
import { COARSE_WINDOW_MS, findFlickers } from "./flicker";

const d = (class_id: number): Detection => ({ class_id, confidence: 0.9, bbox: [0, 0, 0.1, 0.1] });

/** One processed frame per entry; each entry lists the class ids present. */
function view(frames: number[][], stepMs = 40): FrameIndex {
  return {
    timestamps: frames.map((_, i) => i * stepMs),
    detections: frames.map((ids) => ids.map(d)),
  };
}

describe("findFlickers", () => {
  it("finds a blink: presence of at most N frames between two absences", () => {
    const result = findFlickers(view([[], [], [0], [0], [], []]), 1, 2);
    expect(result.events).toEqual([
      { classId: 0, kind: "blink", startMs: 80, endMs: 120, frames: 2 },
    ]);
  });

  it("finds a dropout: absence of at most N frames between two presences", () => {
    const result = findFlickers(view([[0], [0], [], [0], [0]]), 1, 2);
    expect(result.events).toEqual([
      { classId: 0, kind: "dropout", startMs: 80, endMs: 80, frames: 1 },
    ]);
  });

  it("ignores a run longer than N", () => {
    expect(findFlickers(view([[], [0], [0], [0], []]), 1, 2).events).toEqual([]);
  });

  it("does not count a run that touches the start or the end of the video", () => {
    expect(findFlickers(view([[0], [], [], []]), 1, 2).events).toEqual([]);
    expect(findFlickers(view([[], [], [], [0]]), 1, 2).events).toEqual([]);
    expect(findFlickers(view([[], [0], [0]]), 1, 2).events).toEqual([]);
  });

  it("treats classes independently and sorts events by time", () => {
    const result = findFlickers(view([[1], [0, 1], [1], [1], [0, 1], [1]]), 2, 1);
    // class 0 blinks at frame 1 and again at frame 4; class 1 is always present.
    expect(result.events.map((e) => [e.classId, e.kind, e.startMs])).toEqual([
      [0, "blink", 40],
      [0, "blink", 160],
    ]);
  });

  it("sorts interleaved classes globally by start time, ties by class id", () => {
    // class 1 drops out at 40 ms, before class 0 blinks at 80 ms.
    const interleaved = findFlickers(view([[1], [], [0, 1], [1], [1]]), 2, 1);
    expect(interleaved.events.map((e) => [e.classId, e.kind, e.startMs])).toEqual([
      [1, "dropout", 40],
      [0, "blink", 80],
    ]);
    // both blink at 80 ms: the lower class id comes first.
    const tied = findFlickers(view([[], [], [0, 1], [], []]), 2, 1);
    expect(tied.events.map((e) => [e.classId, e.startMs])).toEqual([
      [0, 80],
      [1, 80],
    ]);
  });

  it("a larger N admits longer runs", () => {
    const frames = [[], [0], [0], [0], []];
    expect(findFlickers(view(frames), 1, 2).events).toHaveLength(0);
    expect(findFlickers(view(frames), 1, 3).events).toHaveLength(1);
  });

  it("ignores detections whose class id is outside the class list", () => {
    expect(findFlickers(view([[], [5], []]), 1, 2).events).toEqual([]);
  });

  it("handles an empty view and a single frame", () => {
    expect(findFlickers({ timestamps: [], detections: [] }, 1, 2)).toEqual({ events: [], isCoarse: false });
    expect(findFlickers(view([[0]]), 1, 2).events).toEqual([]);
  });

  it("is coarse when the median step times N exceeds the coarse window", () => {
    const frames = [[], [0], []];
    expect(findFlickers(view(frames, 1000), 1, 2).isCoarse).toBe(true);
    expect(findFlickers(view(frames, 40), 1, 2).isCoarse).toBe(false);
  });

  it("is not coarse exactly at the boundary (500 ms x 2 = 1000), and is just above it", () => {
    const frames = [[], [0], []];
    expect(findFlickers(view(frames, 500), 1, 2).isCoarse).toBe(false);
    expect(findFlickers(view(frames, 501), 1, 2).isCoarse).toBe(true);
    expect(COARSE_WINDOW_MS).toBe(1000);
  });
});
