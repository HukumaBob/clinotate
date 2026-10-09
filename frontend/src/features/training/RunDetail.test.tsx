import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { apiClient } from "../../shared/api/client";
import type { components } from "../../shared/api/generated/schema";
import { RunDetail } from "./RunDetail";

vi.mock("../../shared/api/client", () => ({
  apiClient: { GET: vi.fn(), POST: vi.fn(), DELETE: vi.fn(), PATCH: vi.fn() },
}));

type TrainingRunRead = components["schemas"]["TrainingRunRead"];

const run: TrainingRunRead = {
  id: 4,
  dataset_id: 1,
  job_id: null,
  adapter: "ultralytics",
  base_model: "yolo11n.pt",
  base_model_version_id: null,
  model_version_id: 3,
  name: "my run",
  note: null,
  task_type: "detection",
  config: {},
  status: "succeeded",
  stop_requested: false,
  metrics: {},
  current_epoch: 1,
  total_epochs: 1,
  error: null,
  created_at: "2026-08-19T10:00:00Z",
  started_at: null,
  finished_at: null,
};

function setup(over: Partial<TrainingRunRead> = {}, view: "overview" | "metrics" | "log" | "model" = "overview") {
  const props = {
    onViewChange: vi.fn(),
    onBack: vi.fn(),
    onRepeat: vi.fn(),
    onDeleteRun: vi.fn(),
    onChanged: vi.fn(),
  };
  render(<RunDetail run={{ ...run, ...over }} view={view} schema={null} deleteError={null} {...props} />);
  return props;
}

describe("RunDetail", () => {
  beforeEach(() => {
    vi.mocked(apiClient.GET).mockReset().mockResolvedValue({
      data: { metrics: {}, history: [], per_class: [], confusion: null },
    } as never);
  });

  it("shows the header and goes back", async () => {
    const { onBack } = setup();
    expect(screen.getByText("#4")).toBeInTheDocument();
    expect(screen.getByText("my run")).toBeInTheDocument();
    expect(screen.getByText("succeeded")).toHaveClass("bg-green-700");
    await userEvent.click(screen.getByRole("button", { name: "← Runs" }));
    expect(onBack).toHaveBeenCalled();
  });

  it("has tabs with selection and reports clicks", async () => {
    const { onViewChange } = setup({}, "metrics");
    expect(screen.getByRole("tablist")).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Metrics" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tab", { name: "Overview" })).toHaveAttribute("aria-selected", "false");
    await userEvent.click(screen.getByRole("tab", { name: "Log" }));
    expect(onViewChange).toHaveBeenCalledWith("log");
    expect(screen.getByRole("tabpanel")).toBeInTheDocument();
  });

  it("disables Model without a model", () => {
    setup({ model_version_id: null });
    const tab = screen.getByRole("tab", { name: "Model" });
    expect(tab).toBeDisabled();
    expect(tab).toHaveAttribute("title", "This run has no model");
  });

  it("renders the overview panel for the overview view", () => {
    setup();
    expect(screen.getByLabelText("Name")).toBeInTheDocument();
  });
});
