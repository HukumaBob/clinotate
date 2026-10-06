import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import type { InferenceRun } from "../../entities/useInferenceRuns";
import { RunStatus } from "./RunStatus";

const base: InferenceRun = {
  id: 1,
  video_id: 9,
  model_version_id: 4,
  model_name: "yolo11n-run7",
  job_id: 3,
  frame_stride: 1,
  status: "running",
  frames_total: 4500,
  frames_processed: 1200,
  error: null,
  created_at: "2026-10-06T10:00:00Z",
  started_at: "2026-10-06T10:00:01Z",
  finished_at: null,
};

describe("RunStatus", () => {
  it("shows the frame counter and a progress bar while running", () => {
    render(<RunStatus run={base} />);
    expect(screen.getByText("running")).toBeInTheDocument();
    expect(screen.getByText("1200 / 4500 frames")).toBeInTheDocument();
    expect(screen.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "27");
  });

  it("shows the error of a failed run", () => {
    render(<RunStatus run={{ ...base, status: "failed", error: "Could not open the video file" }} />);
    expect(screen.getByText("Could not open the video file")).toBeInTheDocument();
  });

  it("says so when nothing has been run", () => {
    render(<RunStatus run={null} />);
    expect(screen.getByText(/no run selected/i)).toBeInTheDocument();
  });
});
