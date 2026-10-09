import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { apiClient } from "../../shared/api/client";
import type { components } from "../../shared/api/generated/schema";
import { RunMetricsView } from "./RunMetricsView";

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
  model_version_id: 3,
  name: null,
  note: null,
  task_type: "detection",
  config: {},
  status: "succeeded",
  stop_requested: false,
  metrics: {},
  current_epoch: 2,
  total_epochs: 2,
  error: null,
  created_at: "2026-08-19T10:00:00Z",
  started_at: null,
  finished_at: null,
};

const full = {
  metrics: {},
  history: [
    { epoch: 1, "train/loss": 1.0 },
    { epoch: 2, "train/loss": 0.6 },
  ],
  per_class: [{ class: "polyp", mAP50: 0.7 }],
  confusion: { labels: ["polyp", "background"], matrix: [[4, 1], [0, 2]] },
};

describe("RunMetricsView", () => {
  beforeEach(() => vi.mocked(apiClient.GET).mockReset());

  it("renders the curve, the confusion matrix and the per-class table with captions", async () => {
    vi.mocked(apiClient.GET).mockResolvedValue({ data: full } as never);
    render(<RunMetricsView run={run} />);

    await waitFor(() => expect(document.querySelectorAll("[data-cell]").length).toBe(4));
    expect(document.querySelectorAll("path[data-series]").length).toBeGreaterThan(0);
    expect(screen.getByRole("columnheader", { name: "class" })).toBeInTheDocument();
    expect(screen.getByText("Training curve")).toBeInTheDocument();
    expect(screen.getByText("Confusion matrix")).toBeInTheDocument();
    expect(screen.getByText("Per-class metrics")).toBeInTheDocument();
    expect(apiClient.GET).toHaveBeenCalledWith("/training/runs/{run_id}/metrics", {
      params: { path: { run_id: 7 } },
    });
  });

  it("shows the empty states when the trainer supplied nothing", async () => {
    vi.mocked(apiClient.GET).mockResolvedValue({
      data: { metrics: {}, history: [], per_class: [], confusion: null },
    } as never);
    render(<RunMetricsView run={run} />);

    expect(await screen.findByText("No confusion matrix for this run.")).toBeInTheDocument();
    expect(screen.getByText("No per-class metrics for this run.")).toBeInTheDocument();
    expect(document.querySelectorAll("path[data-series]")).toHaveLength(0);
  });

  it("still shows everything for a run whose model was deleted", async () => {
    vi.mocked(apiClient.GET).mockResolvedValue({ data: full } as never);
    render(<RunMetricsView run={{ ...run, model_version_id: null }} />);

    await waitFor(() => expect(document.querySelectorAll("[data-cell]").length).toBe(4));
    expect(screen.getByRole("columnheader", { name: "class" })).toBeInTheDocument();
  });

  it("shows loading and error text", async () => {
    vi.mocked(apiClient.GET).mockResolvedValue({ error: {}, data: undefined } as never);
    render(<RunMetricsView run={run} />);
    expect(screen.getByText("Loading…")).toBeInTheDocument();
    expect(await screen.findByText("Failed to load the run's metrics.")).toBeInTheDocument();
  });
});
