import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { DatasetMetricsDialog } from "./DatasetMetricsDialog";

const DATASET = {
  id: 1,
  name: "colono-detection",
  task_type: "detection",
  taxonomy_version: 1,
  split_config: { train: 70, val: 20, test: 10 },
  grouping_overrides: {},
  excluded_label_ids: [],
  class_limits: {},
  balance_metrics: {
    severity: "severe_imbalance",
    threshold: 10,
    negative_frames: 23,
    below_threshold: ["ileum"],
    metrics: { imbalance_ratio: 35, gini_index: 0.587, severity: "severe_imbalance" },
    classes: [
      { label_id: 1, name: "polyp", instances: 35, frames: 33 },
      { label_id: 2, name: "ileum", instances: 1, frames: 1 },
    ],
  },
  created_at: "2026-08-16T10:00:00Z",
  item_count: 66,
  split_counts: { train: 40, val: 20, test: 6 },
  items: [],
};

describe("DatasetMetricsDialog", () => {
  it("renders the stored class snapshot", () => {
    render(<DatasetMetricsDialog dataset={DATASET} onClose={vi.fn()} />);
    expect(screen.getByText("polyp")).toBeInTheDocument();
    expect(screen.getByText("ileum")).toBeInTheDocument();
  });

  it("shows the stored severity and split counts", () => {
    render(<DatasetMetricsDialog dataset={DATASET} onClose={vi.fn()} />);
    expect(screen.getByTestId("dialog-severity")).toHaveTextContent("severe_imbalance");
    expect(screen.getByTestId("dialog-splits")).toHaveTextContent("40");
  });

  it("calls onClose when the close control is used", async () => {
    const onClose = vi.fn();
    render(<DatasetMetricsDialog dataset={DATASET} onClose={onClose} />);
    await userEvent.click(screen.getByRole("button", { name: /close/i }));
    expect(onClose).toHaveBeenCalled();
  });

  it("handles a dataset saved without a snapshot", () => {
    render(
      <DatasetMetricsDialog dataset={{ ...DATASET, balance_metrics: {} }} onClose={vi.fn()} />,
    );
    expect(screen.getByTestId("dialog-empty")).toBeInTheDocument();
  });
});
