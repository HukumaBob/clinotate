import { render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { apiClient } from "../../shared/api/client";
import type { components } from "../../shared/api/generated/schema";
import { RunOverview } from "./RunOverview";
import { settingsSchemaFixture } from "./testFixtures";

vi.mock("../../shared/api/client", () => ({
  apiClient: { GET: vi.fn(), POST: vi.fn(), DELETE: vi.fn(), PATCH: vi.fn() },
}));

type TrainingRunRead = components["schemas"]["TrainingRunRead"];

const run: TrainingRunRead = {
  id: 1,
  dataset_id: 1,
  job_id: null,
  adapter: "ultralytics",
  base_model: "yolo11n.pt",
  base_model_version_id: null,
  model_version_id: null,
  name: "first",
  note: "a note",
  task_type: "detection",
  config: { epochs: 80, batch: 8, mystery: "x" },
  status: "succeeded",
  stop_requested: false,
  metrics: { "metrics/mAP50(B)": 0.65, "metrics/precision(B)": 0.8123, fitness: 0.5, label: "text" },
  current_epoch: 80,
  total_epochs: 80,
  error: null,
  created_at: "2026-08-19T10:00:00Z",
  started_at: null,
  finished_at: null,
};

const metricsBody = {
  metrics: {},
  history: [
    { epoch: 1, "train/loss": 1.0 },
    { epoch: 2, "train/loss": 0.6 },
  ],
  per_class: [],
  confusion: null,
};

function renderOverview(over: Partial<TrainingRunRead> = {}, props: Record<string, unknown> = {}) {
  return render(
    <RunOverview run={{ ...run, ...over }} schema={settingsSchemaFixture} {...props} />,
  );
}

describe("RunOverview", () => {
  beforeEach(() => {
    vi.mocked(apiClient.GET).mockReset().mockResolvedValue({ data: metricsBody } as never);
  });

  it("shows result cards with 3 decimals and the full value in a title", () => {
    renderOverview();
    const results = screen.getByRole("region", { name: "Results" });
    expect(within(results).getByText("mAP50")).toBeInTheDocument();
    expect(within(results).getByText("0.650")).toBeInTheDocument();
    expect(within(results).getByText("0.812")).toHaveAttribute("title", "0.8123");
    expect(within(results).getByText("Fitness")).toBeInTheDocument();
    expect(within(results).queryByText("Recall")).not.toBeInTheDocument();
    expect(screen.queryByText("text")).not.toBeInTheDocument();
  });

  it("falls back to every numeric metric under its own key", () => {
    renderOverview({ metrics: { ap_50: 0.4 } });
    expect(screen.getByText("ap_50")).toBeInTheDocument();
    expect(screen.getByText("0.400")).toBeInTheDocument();
  });

  it("lists only changed settings, each with its default", () => {
    renderOverview();
    const changed = screen.getByRole("heading", { name: "Changed settings" }).closest("section")!;
    expect(within(changed).getByText("80")).toHaveClass("text-blue-300");
    expect(within(changed).getByText("(default 50)")).toBeInTheDocument();
    expect(within(changed).queryByText("8")).not.toBeInTheDocument();
  });

  it("has no Changed settings section when everything is default", () => {
    renderOverview({ config: { epochs: 50 } });
    expect(screen.queryByText("Changed settings")).not.toBeInTheDocument();
  });

  it("keeps all settings in a collapsed details with a count", () => {
    renderOverview();
    const details = screen.getByText("All settings (3)").closest("details")!;
    expect(details).not.toHaveAttribute("open");
    expect(within(details).getByText("Basic")).toBeInTheDocument();
    expect(within(details).getByText("8", { selector: "dd" })).not.toHaveClass("text-blue-300");
    expect(within(details).getByText("Other settings")).toBeInTheDocument();
    expect(within(details).getByText("mystery")).toBeInTheDocument();
  });

  it("with no schema shows one flat Settings list of raw keys", () => {
    renderOverview({}, { schema: null });
    expect(screen.getByText("Settings")).toBeInTheDocument();
    expect(screen.getByText("epochs")).toBeInTheDocument();
    expect(screen.queryByText("Basic")).not.toBeInTheDocument();
    expect(screen.queryByText("Changed settings")).not.toBeInTheDocument();
  });

  it("shows the error and no progress block, even for an active run", () => {
    renderOverview({ status: "running", current_epoch: 3, total_epochs: 10, error: "boom" });
    expect(screen.getByText("boom")).toBeInTheDocument();
    expect(screen.queryByRole("progressbar")).not.toBeInTheDocument();
    expect(screen.queryByText("Epoch 3 / 10")).not.toBeInTheDocument();
  });

  it("draws the training curve", async () => {
    renderOverview();
    await waitFor(() => expect(document.querySelectorAll("path[data-series]").length).toBeGreaterThan(0));
  });

  it("hides setting groups with no value in an old-style config", () => {
    renderOverview({ config: { epochs: 50, batch: 8, imgsz: 640 } });
    expect(screen.getByText("Basic")).toBeInTheDocument();
    expect(screen.queryByText("Optimization")).not.toBeInTheDocument();
  });

  it("shows every group present in a full config", () => {
    const config: Record<string, unknown> = {};
    for (const group of settingsSchemaFixture.groups)
      for (const field of group.fields) config[field.key] = field.default;
    renderOverview({ config });
    for (const group of settingsSchemaFixture.groups)
      expect(screen.getByText(group.label)).toBeInTheDocument();
  });
});
