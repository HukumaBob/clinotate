import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import { ConfusionCompare } from "./ConfusionCompare";
import { COMPARE_COLORS, type CompareRunInfo } from "./CompareCurves";

const runs: CompareRunInfo[] = [
  { id: 1, label: "Run alpha", color: COMPARE_COLORS[0] },
  { id: 2, label: "Run beta", color: COMPARE_COLORS[1] },
  { id: 3, label: "Run gamma", color: COMPARE_COLORS[2] },
];

const a = {
  labels: ["polyp", "erosion"],
  matrix: [
    [8, 1],
    [2, 5],
  ],
};
const b = {
  labels: ["polyp", "erosion"],
  matrix: [
    [10, 1],
    [0, 4],
  ],
};

describe("ConfusionCompare", () => {
  it("renders one matrix per run under its label", () => {
    render(<ConfusionCompare runs={runs.slice(0, 2)} confusions={[a, b]} />);

    expect(screen.getByRole("heading", { name: "Confusion matrices" })).toBeInTheDocument();
    expect(
      screen.getByText("Rows are the true class, columns the predicted one."),
    ).toBeInTheDocument();
    expect(screen.getByText("Run alpha")).toBeInTheDocument();
    expect(screen.getByText("Run beta")).toBeInTheDocument();
    expect(document.querySelectorAll("[data-cell]")).toHaveLength(8);
  });

  it("shows a message for a run without a matrix", () => {
    render(<ConfusionCompare runs={runs.slice(0, 2)} confusions={[a, null]} />);

    expect(screen.getByText("No confusion matrix for this run.")).toBeInTheDocument();
    expect(document.querySelectorAll("[data-cell]")).toHaveLength(4);
  });

  it("treats a confusion with labels but an empty matrix as missing for the difference too", () => {
    render(
      <ConfusionCompare runs={runs.slice(0, 2)} confusions={[a, { labels: ["polyp", "erosion"], matrix: [] }]} />,
    );
    expect(screen.getByRole("button", { name: /Show difference/ })).toBeDisabled();
  });

  it("toggles to a signed difference table and back for two runs", async () => {
    render(<ConfusionCompare runs={runs.slice(0, 2)} confusions={[a, b]} />);

    const toggle = screen.getByRole("button", { name: "Show difference (B − A)" });
    expect(toggle).toHaveAttribute("aria-pressed", "false");

    await userEvent.click(toggle);

    expect(toggle).toHaveAttribute("aria-pressed", "true");
    const table = screen.getByRole("table");
    expect(within(table).getByText("+2")).toBeInTheDocument();
    expect(within(table).getByText("−2")).toBeInTheDocument();
    expect(within(table).getByText("−1")).toBeInTheDocument();
    expect(within(table).getByText("0")).toBeInTheDocument();
    expect(screen.getByText(/A = Run alpha/)).toBeInTheDocument();
    expect(screen.getByText(/B = Run beta/)).toBeInTheDocument();
    expect(screen.queryByText("Run beta", { selector: "span" })).not.toBeInTheDocument();

    await userEvent.click(toggle);

    expect(toggle).toHaveAttribute("aria-pressed", "false");
    expect(document.querySelectorAll("[data-cell]")).toHaveLength(8);
  });

  it("disables the toggle with a reason when there is no overlap", () => {
    const other = { labels: ["ulcer"], matrix: [[3]] };
    render(<ConfusionCompare runs={runs.slice(0, 2)} confusions={[a, other]} />);

    const toggle = screen.getByRole("button", { name: "Show difference (B − A)" });
    expect(toggle).toBeDisabled();
    expect(toggle).toHaveAttribute("title", "No common labels or a matrix is missing");
  });

  it("has no toggle for three runs", () => {
    render(<ConfusionCompare runs={runs} confusions={[a, b, a]} />);

    expect(screen.queryByRole("button", { name: /show difference/i })).not.toBeInTheDocument();
  });
});
