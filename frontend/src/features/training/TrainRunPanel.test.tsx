import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import type { components } from "../../shared/api/generated/schema";
import { shouldStickToBottom, TrainRunPanel } from "./TrainRunPanel";

type TrainingRunRead = components["schemas"]["TrainingRunRead"];

const runningRun: TrainingRunRead = {
  id: 7,
  dataset_id: 1,
  job_id: 1,
  adapter: "ultralytics",
  base_model_version_id: null,
  base_model: "yolo11n.pt",
  name: null,
  note: null,
  task_type: "detection",
  config: {},
  status: "running",
  current_epoch: 3,
  total_epochs: 50,
  stop_requested: false,
  error: null,
  metrics: {},
  created_at: "2026-08-19T10:00:00Z",
  started_at: "2026-08-19T10:00:00Z",
  finished_at: null,
};

describe("TrainRunPanel", () => {
  it("prompts to start a run when there is none", () => {
    render(<TrainRunPanel run={null} logText="" onStop={vi.fn()} stopPending={false} />);

    expect(screen.getByText(/no training run/i)).toBeInTheDocument();
  });

  it("shows progress by epoch and the raw log", () => {
    render(
      <TrainRunPanel
        run={runningRun}
        logText={"epoch 1/50 loss 0.9\nepoch 2/50 loss 0.7\n"}
        onStop={vi.fn()}
        stopPending={false}
      />,
    );

    expect(screen.getByText("Epoch 3 / 50")).toBeInTheDocument();
    expect(screen.getByText(/epoch 2\/50 loss 0.7/)).toBeInTheDocument();
    expect(screen.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "6");
  });

  it("says that stopping waits for the current epoch", () => {
    render(<TrainRunPanel run={runningRun} logText="" onStop={vi.fn()} stopPending={false} />);

    expect(screen.getByText(/after the current epoch/i)).toBeInTheDocument();
  });

  it("calls onStop when Stop is clicked", async () => {
    const user = userEvent.setup();
    const onStop = vi.fn();
    render(<TrainRunPanel run={runningRun} logText="" onStop={onStop} stopPending={false} />);

    await user.click(screen.getByRole("button", { name: /^stop$/i }));

    expect(onStop).toHaveBeenCalledTimes(1);
  });

  it("reports that a stop is pending once requested", () => {
    render(
      <TrainRunPanel
        run={{ ...runningRun, stop_requested: true }}
        logText=""
        onStop={vi.fn()}
        stopPending
      />,
    );

    expect(screen.getByRole("button", { name: /stopping/i })).toBeDisabled();
  });

  it("hides Stop for a finished run and shows its error", () => {
    render(
      <TrainRunPanel
        run={{ ...runningRun, status: "failed", error: "CUDA out of memory" }}
        logText=""
        onStop={vi.fn()}
        stopPending={false}
      />,
    );

    expect(screen.queryByRole("button", { name: /stop/i })).not.toBeInTheDocument();
    expect(screen.getByText(/CUDA out of memory/)).toBeInTheDocument();
  });
});

describe("shouldStickToBottom", () => {
  it("returns true when scrolled exactly to the bottom", () => {
    // scrollTop + clientHeight === scrollHeight
    expect(shouldStickToBottom(400, 100, 500)).toBe(true);
  });

  it("returns false when scrolled up well beyond the tolerance", () => {
    // 200px of content still below the visible area
    expect(shouldStickToBottom(200, 100, 500)).toBe(false);
  });

  it("returns true when within the tolerance of the bottom", () => {
    // 10px short of the bottom, tolerance is 24px by default
    expect(shouldStickToBottom(390, 100, 500)).toBe(true);
  });

  it("returns true for the jsdom zero-height case", () => {
    // jsdom never lays out real dimensions, so all three values default
    // to 0; distanceFromBottom is 0, which must count as "at the bottom"
    // rather than crash or misclassify.
    expect(shouldStickToBottom(0, 0, 0)).toBe(true);
  });

  it("honors an explicit tolerance override", () => {
    expect(shouldStickToBottom(350, 100, 500, 5)).toBe(false);
    expect(shouldStickToBottom(350, 100, 500, 60)).toBe(true);
  });
});
