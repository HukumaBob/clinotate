import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { BalancePanel } from "./BalancePanel";

const REPORT = {
  classes: [
    { label_id: 1, name: "polyp", instances: 35, frames: 33 },
    { label_id: 2, name: "ileum", instances: 1, frames: 1 },
  ],
  total_frames: 34,
  negative_frames: 0,
  below_threshold: ["ileum"],
  threshold: 10,
  metrics: { severity: "severe_imbalance", imbalance_ratio: 35, gini_index: 0.69 },
};

function renderPanel(overrides = {}) {
  const props = {
    report: REPORT,
    collapsed: new Set<number>(),
    excluded: new Set<number>(),
    onToggleCollapse: vi.fn(),
    onToggleExclude: vi.fn(),
    ...overrides,
  };
  render(<BalancePanel {...props} />);
  return props;
}

describe("BalancePanel", () => {
  it("leads with the under-threshold classes", () => {
    renderPanel();
    expect(screen.getByTestId("below-threshold-summary")).toHaveTextContent("1");
    expect(screen.getByTestId("below-threshold-summary")).toHaveTextContent("ileum");
  });

  it("shows both instance and frame counts for each class", () => {
    renderPanel();
    const row = screen.getByTestId("class-row-1");
    expect(row).toHaveTextContent("35");
    expect(row).toHaveTextContent("33");
  });

  it("reports zero negatives explicitly rather than hiding the row", () => {
    renderPanel();
    expect(screen.getByTestId("negative-frames")).toHaveTextContent("0");
  });

  it("calls onToggleExclude with the label id when a class is excluded", async () => {
    const props = renderPanel();
    await userEvent.click(screen.getByTestId("exclude-2"));
    expect(props.onToggleExclude).toHaveBeenCalledWith(2);
  });

  it("shows severity as a secondary figure, not the headline", () => {
    renderPanel();
    const severity = screen.getByTestId("severity-reference");
    expect(severity).toHaveTextContent("severe_imbalance");
  });
});
