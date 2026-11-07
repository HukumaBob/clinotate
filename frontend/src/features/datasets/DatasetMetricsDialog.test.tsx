import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { apiClient } from "../../shared/api/client";
import { DatasetMetricsDialog } from "./DatasetMetricsDialog";

vi.mock("../../shared/api/client", () => ({
  apiClient: { GET: vi.fn(), POST: vi.fn() },
}));

function renderDialog(ui: ReactElement) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

const cell = (frames: number, units: number) => ({ frames, units });
const SPLIT_REPORT = {
  classes: [{ label_id: 1, name: "polyp", units: 2, train: cell(20, 1), val: cell(10, 1), test: cell(0, 0) }],
  train: { frames: 20, units: 1, share: 0.67, target: 0.7 },
  val: { frames: 10, units: 1, share: 0.33, target: 0.2 },
  test: { frames: 0, units: 0, share: 0, target: 0.1 },
  warnings: [{ kind: "few_units", message: "polyp comes from only 2 sources.", label_id: 1, split: null }],
};

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
  beforeEach(() => {
    vi.mocked(apiClient.GET).mockReset();
    vi.mocked(apiClient.POST).mockReset();
    vi.mocked(apiClient.GET).mockResolvedValue({ data: undefined, error: undefined } as never);
  });

  it("shows the split report of the stored dataset", async () => {
    vi.mocked(apiClient.GET).mockResolvedValue({ data: SPLIT_REPORT, error: undefined } as never);
    renderDialog(<DatasetMetricsDialog dataset={DATASET} onClose={vi.fn()} />);
    expect(await screen.findByTestId("split-totals")).toBeInTheDocument();
    expect(screen.getByText("polyp comes from only 2 sources.")).toBeInTheDocument();
    expect(apiClient.GET).toHaveBeenCalledWith("/datasets/{dataset_id}/split-report", {
      params: { path: { dataset_id: 1 } },
    });
  });

  it("never recomputes the balance: the snapshot is frozen at save time", async () => {
    vi.mocked(apiClient.GET).mockResolvedValue({ data: SPLIT_REPORT, error: undefined } as never);
    renderDialog(<DatasetMetricsDialog dataset={DATASET} onClose={vi.fn()} />);
    await screen.findByTestId("split-totals");
    expect(apiClient.POST).not.toHaveBeenCalled();
  });

  it("renders the stored class snapshot", () => {
    renderDialog(<DatasetMetricsDialog dataset={DATASET} onClose={vi.fn()} />);
    expect(screen.getByText("polyp")).toBeInTheDocument();
    expect(screen.getByText("ileum")).toBeInTheDocument();
  });

  it("shows the stored severity and split counts", () => {
    renderDialog(<DatasetMetricsDialog dataset={DATASET} onClose={vi.fn()} />);
    expect(screen.getByTestId("dialog-severity")).toHaveTextContent("severe_imbalance");
    expect(screen.getByTestId("dialog-splits")).toHaveTextContent("40");
  });

  it("calls onClose when the close control is used", async () => {
    const onClose = vi.fn();
    renderDialog(<DatasetMetricsDialog dataset={DATASET} onClose={onClose} />);
    await userEvent.click(screen.getByRole("button", { name: /close/i }));
    expect(onClose).toHaveBeenCalled();
  });

  it("handles a dataset saved without a snapshot", () => {
    renderDialog(
      <DatasetMetricsDialog dataset={{ ...DATASET, balance_metrics: {} }} onClose={vi.fn()} />,
    );
    expect(screen.getByTestId("dialog-empty")).toBeInTheDocument();
  });

  it("exposes dialog semantics for assistive tech", () => {
    renderDialog(<DatasetMetricsDialog dataset={DATASET} onClose={vi.fn()} />);
    const dialog = screen.getByRole("dialog");
    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(dialog).toHaveAccessibleName(/colono-detection/i);
  });

  it("calls onClose when Escape is pressed", async () => {
    const onClose = vi.fn();
    renderDialog(<DatasetMetricsDialog dataset={DATASET} onClose={onClose} />);
    await userEvent.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalled();
  });
});
