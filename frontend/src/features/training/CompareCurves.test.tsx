import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import { COMPARE_COLORS, CompareCurves, type CompareRunInfo } from "./CompareCurves";

const runs: CompareRunInfo[] = [
  { id: 1, label: "#1 base", color: COMPARE_COLORS[0] },
  { id: 2, label: "#2 tuned", color: COMPARE_COLORS[1] },
  { id: 3, label: "#3 bare", color: COMPARE_COLORS[2] },
];
const histories = [
  [
    { epoch: 1, "metrics/mAP50(B)": 0.2, "train/loss": 1.0 },
    { epoch: 2, "metrics/mAP50(B)": 0.5, "train/loss": 0.5 },
  ],
  [
    { epoch: 1, "metrics/mAP50(B)": 0.3, "train/loss": 0.9 },
    { epoch: 2, "metrics/mAP50(B)": 0.6, "train/loss": 0.4 },
  ],
  [{ epoch: 1, "val/other": 0.1 }],
];

describe("CompareCurves", () => {
  it("defaults to the headline metric and draws one line per run with data", () => {
    render(<CompareCurves runs={runs} histories={histories} />);

    expect(screen.getByLabelText("Curve metric")).toHaveValue("metrics/mAP50(B)");
    expect(document.querySelectorAll("polyline")).toHaveLength(2);
    expect(screen.getByText("One line per run for the chosen metric.")).toBeInTheDocument();
  });

  it("lists run labels in the legend and marks a run without data", () => {
    render(<CompareCurves runs={runs} histories={histories} />);

    expect(screen.getByText("#1 base")).toBeInTheDocument();
    expect(screen.getByText("#2 tuned")).toBeInTheDocument();
    expect(screen.getByText("#3 bare")).toBeInTheDocument();
    expect(screen.getAllByText("(no data)")).toHaveLength(1);
  });

  it("redraws for another metric key", async () => {
    render(<CompareCurves runs={runs} histories={histories} />);

    await userEvent.selectOptions(screen.getByLabelText("Curve metric"), "val/other");

    expect(document.querySelectorAll("polyline")).toHaveLength(1);
    expect(screen.getAllByText("(no data)")).toHaveLength(2);
  });

  it("shows an empty state when no run has history", () => {
    render(<CompareCurves runs={runs} histories={[[], [], []]} />);

    expect(screen.getByText("No training history to compare.")).toBeInTheDocument();
    expect(screen.queryByLabelText("Curve metric")).not.toBeInTheDocument();
  });
});
