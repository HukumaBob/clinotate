import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import type { components } from "../../shared/api/generated/schema";
import { SplitReportTable } from "./SplitReportTable";

type SplitReportRead = components["schemas"]["SplitReportRead"];

const cell = (frames: number, units: number) => ({ frames, units });

function report(overrides: Partial<SplitReportRead> = {}): SplitReportRead {
  return {
    classes: [
      { label_id: 1, name: "caecum", units: 4, train: cell(169, 2), val: cell(13, 1), test: cell(38, 1) },
      { label_id: 2, name: "colon_left", units: 2, train: cell(111, 1), val: cell(82, 1), test: cell(0, 0) },
      { label_id: 3, name: "colon_right", units: 3, train: cell(184, 2), val: cell(0, 0), test: cell(3, 1) },
    ],
    train: { frames: 464, units: 3, share: 0.71, target: 0.7 },
    val: { frames: 95, units: 1, share: 0.15, target: 0.2 },
    test: { frames: 41, units: 1, share: 0.14, target: 0.1 },
    warnings: [
      { kind: "few_units", message: "colon_left comes from only 2 sources, so it cannot be in test.", label_id: 2, split: null },
      { kind: "missing_in_split", message: "colon_right has no frames in val.", label_id: 3, split: "val" },
      { kind: "thin_cell", message: "colon_right has only 3 frames in test.", label_id: 3, split: "test" },
    ],
    ...overrides,
  };
}

describe("SplitReportTable", () => {
  it("renders a row per class with frames / units per part", () => {
    render(<SplitReportTable report={report()} />);
    expect(screen.getByText("caecum")).toBeInTheDocument();
    expect(screen.getByText("169 / 2")).toBeInTheDocument();
    expect(screen.getByText("38 / 1")).toBeInTheDocument();
  });

  it("marks an empty cell as missing and shows a dash", () => {
    render(<SplitReportTable report={report()} />);
    const missing = screen.getByTestId("split-cell-2-test");
    expect(missing).toHaveAttribute("data-problem", "missing");
    expect(missing).toHaveTextContent("—");
    expect(screen.getByTestId("split-cell-3-val")).toHaveAttribute("data-problem", "missing");
  });

  it("marks a cell with a thin_cell warning as thin", () => {
    render(<SplitReportTable report={report()} />);
    expect(screen.getByTestId("split-cell-3-test")).toHaveAttribute("data-problem", "thin");
    expect(screen.getByTestId("split-cell-1-test")).not.toHaveAttribute("data-problem");
  });

  it("lists the warnings by message", () => {
    render(<SplitReportTable report={report()} />);
    const list = screen.getByTestId("split-warnings");
    expect(within(list).getByText("colon_right has no frames in val.")).toBeInTheDocument();
    expect(within(list).getAllByRole("listitem")).toHaveLength(3);
  });

  it("shows the real share against the target for each part", () => {
    render(<SplitReportTable report={report()} />);
    const totals = screen.getByTestId("split-totals");
    expect(totals).toHaveTextContent("train");
    expect(totals).toHaveTextContent("71%");
    expect(totals).toHaveTextContent("target 70%");
    expect(totals).toHaveTextContent("test");
  });

  it("renders no warning list when there are no warnings", () => {
    render(<SplitReportTable report={report({ warnings: [] })} />);
    expect(screen.queryByTestId("split-warnings")).not.toBeInTheDocument();
  });

  it("renders nothing for an empty report", () => {
    const { container } = render(<SplitReportTable report={report({ classes: [], warnings: [] })} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("keeps a long class list inside a scroll container", () => {
    const classes = Array.from({ length: 40 }, (_, i) => ({
      label_id: i + 1, name: `class_${i}`, units: 3,
      train: cell(10, 1), val: cell(10, 1), test: cell(10, 1),
    }));
    render(<SplitReportTable report={report({ classes, warnings: [] })} />);
    expect(screen.getByTestId("split-table-scroll").className).toContain("overflow-y-auto");
    expect(screen.getAllByRole("row")).toHaveLength(41);
  });
});
