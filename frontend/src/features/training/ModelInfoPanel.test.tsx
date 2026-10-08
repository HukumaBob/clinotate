import { render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach } from "vitest";

import { ModelInfoPanel } from "./ModelInfoPanel";
import { apiClient } from "../../shared/api/client";
import type { components } from "../../shared/api/generated/schema";

vi.mock("../../shared/api/client", () => ({
  apiClient: { GET: vi.fn() },
}));

type ModelVersionRead = components["schemas"]["ModelVersionRead"];

const testVersion: ModelVersionRead = {
  id: 1,
  training_run_id: 7,
  name: "yolo11n-run7",
  task_type: "detection",
  metrics: { "metrics/mAP50(B)": 0.712 },
  is_active: false,
  base_model: "yolo11n.pt",
  base_model_version_id: null,
  created_at: "2026-08-19T10:00:00Z",
};

const full = {
  metrics: { "metrics/mAP50(B)": 0.65 },
  history: [
    { epoch: 1, "train/loss": 1.0 },
    { epoch: 2, "train/loss": 0.6 },
  ],
  per_class: [{ class: "polyp", mAP50: 0.7, "Box-P": 0.8 }],
  confusion: { labels: ["polyp", "background"], matrix: [[4, 1], [0, 2]] },
  artifacts: [{ name: "results.csv", index: 0 }],
};

describe("ModelInfoPanel", () => {
  beforeEach(() => vi.mocked(apiClient.GET).mockReset());

  it("renders every block when the trainer supplied everything", async () => {
    vi.mocked(apiClient.GET).mockResolvedValue({ data: full });

    render(<ModelInfoPanel version={testVersion} onClose={() => {}} />);

    // Not getByText: ConfusionMatrix (Task 8, unmodified here) renders each
    // label as both a row header and a column header by design -- its own
    // test suite asserts that duplication with getAllByText. "polyp" is
    // therefore expected to appear more than once once the panel has
    // finished loading; getAllByText(...).length > 0 waits for the same
    // condition (the confusion matrix and per-class table have rendered)
    // without assuming a single-match DOM that this component never has.
    await waitFor(() => expect(screen.getAllByText("polyp").length).toBeGreaterThan(0));
    expect(document.querySelectorAll("path[data-series]").length).toBeGreaterThan(0);
    expect(document.querySelectorAll("[data-cell]").length).toBe(4);
    expect(screen.getByText("results.csv")).toBeInTheDocument();

    // Guards the Critical finding from round 1: the header must actually
    // identify which model is open (name, task type, headline metric) --
    // without this the panel looks identical for every model.
    // "mAP50" also appears as a per-class table column header for this
    // fixture, so scope the headline-metric check to the header itself
    // rather than the whole document.
    const heading = screen.getByText(testVersion.name).closest("div") as HTMLElement;
    expect(within(heading).getByText(new RegExp(testVersion.task_type))).toBeInTheDocument();
    expect(within(heading).getByText(/0\.712/)).toBeInTheDocument();
    expect(within(heading).getByText(/mAP50/)).toBeInTheDocument();
  });

  it("omits blocks the trainer did not supply, without erroring", async () => {
    vi.mocked(apiClient.GET).mockResolvedValue({
      data: { metrics: {}, history: [], per_class: [], confusion: null, artifacts: [] },
    });

    render(<ModelInfoPanel version={testVersion} onClose={() => {}} />);

    await waitFor(() => expect(screen.queryByText(/loading/i)).not.toBeInTheDocument());
    expect(document.querySelectorAll("path[data-series]")).toHaveLength(0);
    expect(document.querySelectorAll("[data-cell]")).toHaveLength(0);
    expect(screen.queryByText(/error/i)).not.toBeInTheDocument();
  });

  it("renders a trainer whose metric names it has never seen", async () => {
    vi.mocked(apiClient.GET).mockResolvedValue({
      data: {
        metrics: { custom_fitness: 0.4 },
        history: [{ epoch: 1, "rtdetr/ap_50": 0.3 }],
        per_class: [{ class: "polyp", ap_50: 0.31 }],
        confusion: { labels: ["polyp"], matrix: [[3]] },
        artifacts: [],
      },
    });

    render(<ModelInfoPanel version={testVersion} onClose={() => {}} />);

    // See the note in the previous test: ConfusionMatrix renders "polyp" as
    // both a row and a column header for a 1x1 matrix too, so this waits on
    // getAllByText rather than assuming a single match.
    await waitFor(() => expect(screen.getAllByText("polyp").length).toBeGreaterThan(0));
    expect(screen.getByRole("button", { name: /rtdetr\/ap_50/ })).toBeInTheDocument();
    // Not getByText: the chart legend button above ("rtdetr/ap_50") also
    // matches this substring regex, and the per-class table's column
    // header ("ap_50") is a second, separate element -- both are correct,
    // independent renders of the trainer's own unmodified key name.
    expect(screen.getAllByText(/ap_50/).length).toBeGreaterThan(1);
  });
});
