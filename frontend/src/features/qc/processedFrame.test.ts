import { describe, expect, it } from "vitest";

import { buildProcessedFrames, processedFrameAt } from "./processedFrame";
import type { PredictionsDocument } from "./predictions";

const doc = (frames: Record<string, { timestamp_ms: number }>): PredictionsDocument => ({
  task_type: "detection",
  model: { name: "m", version_id: 1 },
  fps: 10,
  frame_stride: 5,
  classes: ["polyp"],
  frames: Object.fromEntries(
    Object.entries(frames).map(([k, v]) => [k, { timestamp_ms: v.timestamp_ms, detections: [] }]),
  ),
});

describe("buildProcessedFrames", () => {
  it("returns the frames sorted by time with numeric frame indices", () => {
    const frames = buildProcessedFrames(
      doc({ "10": { timestamp_ms: 1000 }, "0": { timestamp_ms: 0 }, "5": { timestamp_ms: 500 } }),
    );
    expect(frames).toEqual([
      { frameIndex: 0, timestampMs: 0 },
      { frameIndex: 5, timestampMs: 500 },
      { frameIndex: 10, timestampMs: 1000 },
    ]);
  });

  it("is empty for a document with no frames", () => {
    expect(buildProcessedFrames(doc({}))).toEqual([]);
  });
});

describe("processedFrameAt", () => {
  const frames = buildProcessedFrames(
    doc({ "0": { timestamp_ms: 0 }, "5": { timestamp_ms: 500 }, "10": { timestamp_ms: 1000 } }),
  );

  it("returns the frame exactly at the time", () => {
    expect(processedFrameAt(frames, 500)).toEqual({ frameIndex: 5, timestampMs: 500 });
  });

  it("returns the frame at or before the time, never the next one", () => {
    expect(processedFrameAt(frames, 499)).toEqual({ frameIndex: 0, timestampMs: 0 });
    expect(processedFrameAt(frames, 999)).toEqual({ frameIndex: 5, timestampMs: 500 });
  });

  it("returns the last frame for a time past the end", () => {
    expect(processedFrameAt(frames, 99999)).toEqual({ frameIndex: 10, timestampMs: 1000 });
  });

  it("returns null before the first frame and for an empty list", () => {
    expect(processedFrameAt(frames, -1)).toBeNull();
    expect(processedFrameAt([], 100)).toBeNull();
  });

  it("works when the first frame is not at zero", () => {
    const late = buildProcessedFrames(doc({ "5": { timestamp_ms: 500 } }));
    expect(processedFrameAt(late, 100)).toBeNull();
    expect(processedFrameAt(late, 500)).toEqual({ frameIndex: 5, timestampMs: 500 });
  });
});
