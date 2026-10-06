import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { LatencyPanel } from "./LatencyPanel";
import type { Timing } from "./predictions";

const stats = (mean: number) => ({ mean, p50: mean, p95: mean + 3, max: mean + 10 });
const timing: Timing = {
  frames_measured: 659,
  preprocess_ms: stats(1.9),
  inference_ms: stats(9.4),
  postprocess_ms: stats(1.2),
  total_ms: stats(12.5),
  model_fps: 80,
};

describe("LatencyPanel", () => {
  it("says so when the run has no timing (every run made before it was recorded)", () => {
    render(<LatencyPanel timing={undefined} />);
    expect(screen.getByText("Not recorded for this run")).toBeInTheDocument();
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
  });

  it("shows one row per stage with mean, p50, p95 and max", () => {
    render(<LatencyPanel timing={timing} />);
    expect(screen.getByRole("columnheader", { name: "p95" })).toBeInTheDocument();
    const inference = screen.getByRole("row", { name: /Inference/ });
    expect(inference).toHaveTextContent("9.4");
    expect(inference).toHaveTextContent("12.4");
    expect(inference).toHaveTextContent("19.4");
    expect(screen.getAllByRole("row")).toHaveLength(5); // header + 4 stages
  });

  it("shows the model speed and how many frames were measured", () => {
    render(<LatencyPanel timing={timing} />);
    expect(screen.getByText("Model speed: 80 fps (659 frames measured)")).toBeInTheDocument();
  });
});
