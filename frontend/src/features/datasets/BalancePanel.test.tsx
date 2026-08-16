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

  it("labels the checkbox to match its checked polarity (checked = included)", () => {
    renderPanel();
    const checkbox = screen.getByTestId("exclude-1") as HTMLInputElement;
    expect(checkbox.checked).toBe(true);
    expect(screen.getByLabelText("Include polyp")).toBe(checkbox);
  });

  it("renders no collapse toggle for a row not in collapsibleLabelIds", () => {
    renderPanel({ collapsibleLabelIds: new Set([1]) });
    expect(screen.getByTestId("collapse-1")).toBeInTheDocument();
    expect(screen.queryByTestId("collapse-2")).not.toBeInTheDocument();
    expect(screen.getByText("ileum")).toBeInTheDocument();
  });

  it("shows excluded classes with a control to restore them", async () => {
    const props = renderPanel({ excludedLabels: [{ id: 3, name: "cecum" }] });
    const section = screen.getByTestId("excluded-classes");
    expect(section).toHaveTextContent("cecum");
    await userEvent.click(screen.getByRole("button", { name: "Re-include cecum" }));
    expect(props.onToggleExclude).toHaveBeenCalledWith(3);
  });

  it("renders no excluded-classes section when nothing is excluded", () => {
    renderPanel({ excludedLabels: [] });
    expect(screen.queryByTestId("excluded-classes")).not.toBeInTheDocument();
  });

  it("lets a leaf row re-collapse its expanded parent group", async () => {
    // After expanding "polyp" (label_id 1), the report returns its leaf
    // children instead -- none of which are parents themselves, so without
    // parentLabelIdByChildId there is no surviving control to re-collapse.
    const leafReport = {
      classes: [
        { label_id: 10, name: "colon_adenoma", instances: 8, frames: 8 },
        { label_id: 11, name: "foam", instances: 2, frames: 2 },
      ],
      total_frames: 10,
      negative_frames: 0,
      below_threshold: [],
      threshold: 10,
      metrics: { severity: "moderate_imbalance" },
    };
    const props = renderPanel({
      report: leafReport,
      collapsibleLabelIds: new Set<number>(), // neither leaf is a parent
      parentLabelIdByChildId: new Map<number, number>([
        [10, 1],
        [11, 1],
      ]),
      labelNamesById: new Map<number, string>([[1, "polyp"]]),
    });

    const toggle = screen.getByTestId("collapse-10");
    expect(toggle).toHaveAccessibleName("Collapse into polyp");
    await userEvent.click(toggle);
    expect(props.onToggleCollapse).toHaveBeenCalledWith(1);
  });
});
