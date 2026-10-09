import { render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { apiClient } from "../../shared/api/client";
import type { components } from "../../shared/api/generated/schema";
import { RunLogView } from "./RunLogView";

vi.mock("../../shared/api/client", () => ({
  apiClient: { GET: vi.fn(), POST: vi.fn(), DELETE: vi.fn(), PATCH: vi.fn() },
}));

type TrainingRunRead = components["schemas"]["TrainingRunRead"];

const run: TrainingRunRead = {
  id: 7,
  dataset_id: 1,
  job_id: null,
  adapter: "ultralytics",
  base_model: "yolo11n.pt",
  base_model_version_id: null,
  model_version_id: null,
  name: null,
  note: null,
  task_type: "detection",
  config: {},
  status: "succeeded",
  stop_requested: false,
  metrics: {},
  current_epoch: 0,
  total_epochs: 1,
  error: null,
  created_at: "2026-08-19T10:00:00Z",
  started_at: null,
  finished_at: null,
};

describe("RunLogView", () => {
  beforeEach(() => vi.mocked(apiClient.GET).mockReset());
  afterEach(() => vi.useRealTimers());

  it("renders the log with a capped height and a caption", async () => {
    vi.mocked(apiClient.GET).mockResolvedValue({ data: { text: "epoch 1 done\n", offset: 13 } } as never);
    render(<RunLogView run={run} />);

    expect(await screen.findByText(/epoch 1 done/)).toBeInTheDocument();
    expect(screen.getByRole("log")).toHaveClass("max-h-[70vh]");
    expect(
      screen.getByText("Cleaned view of the trainer's output; the stored log is kept raw."),
    ).toBeInTheDocument();
  });

  it("polls only while the run is active", async () => {
    vi.useFakeTimers();
    vi.mocked(apiClient.GET).mockResolvedValue({ data: { text: "x", offset: 1 } } as never);

    const finished = render(<RunLogView run={run} />);
    await vi.advanceTimersByTimeAsync(7000);
    expect(apiClient.GET).toHaveBeenCalledTimes(1);
    finished.unmount();

    vi.mocked(apiClient.GET).mockClear();
    render(<RunLogView run={{ ...run, status: "running" }} />);
    await vi.advanceTimersByTimeAsync(4100);
    expect(vi.mocked(apiClient.GET).mock.calls.length).toBeGreaterThan(1);
  });

  it("shows an error line when the log cannot be read", async () => {
    vi.mocked(apiClient.GET).mockResolvedValue({ error: {}, data: undefined } as never);
    render(<RunLogView run={run} />);
    expect(await screen.findByText("Failed to load the log.")).toBeInTheDocument();
  });

  it("starts a fresh log pane for another run", async () => {
    vi.mocked(apiClient.GET).mockResolvedValue({ data: { text: "first run\n", offset: 10 } } as never);
    const view = render(<RunLogView run={run} />);
    const first = await screen.findByRole("log");
    vi.mocked(apiClient.GET).mockResolvedValue({ data: { text: "second run\n", offset: 11 } } as never);
    view.rerender(<RunLogView run={{ ...run, id: 8 }} />);
    expect(await screen.findByText(/second run/)).toBeInTheDocument();
    expect(screen.getByRole("log")).not.toBe(first);
  });
});
