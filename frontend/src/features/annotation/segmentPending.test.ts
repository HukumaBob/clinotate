import { describe, expect, it } from "vitest";

import { isSegmentPending } from "./segmentPending";

describe("isSegmentPending", () => {
  it("is pending while the predict request itself is being sent", () => {
    expect(isSegmentPending(true, undefined)).toBe(true);
  });

  it("is pending while a predict job is queued or running, for either model", () => {
    for (const job_type of ["sam2_predict", "sam3_predict"]) {
      expect(isSegmentPending(false, { job_type, status: "pending" })).toBe(true);
      expect(isSegmentPending(false, { job_type, status: "running" })).toBe(true);
    }
  });

  it("is not pending once the predict job has finished, however it ended", () => {
    expect(isSegmentPending(false, { job_type: "sam2_predict", status: "succeeded" })).toBe(false);
    expect(isSegmentPending(false, { job_type: "sam2_predict", status: "failed" })).toBe(false);
  });

  it("does not block on a running track job or on no job at all", () => {
    expect(isSegmentPending(false, { job_type: "sam2_track", status: "running" })).toBe(false);
    expect(isSegmentPending(false, undefined)).toBe(false);
    expect(isSegmentPending(false, null)).toBe(false);
  });
});
