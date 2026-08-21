import { render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach } from "vitest";

import { ModelInfoPanel } from "./ModelInfoPanel";
import { apiClient } from "../../shared/api/client";

vi.mock("../../shared/api/client", () => ({
  apiClient: { GET: vi.fn() },
}));

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

    render(<ModelInfoPanel versionId={1} onClose={() => {}} />);

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
  });

  it("omits blocks the trainer did not supply, without erroring", async () => {
    vi.mocked(apiClient.GET).mockResolvedValue({
      data: { metrics: {}, history: [], per_class: [], confusion: null, artifacts: [] },
    });

    render(<ModelInfoPanel versionId={1} onClose={() => {}} />);

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

    render(<ModelInfoPanel versionId={1} onClose={() => {}} />);

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
