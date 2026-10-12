import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { DatasetSummary } from "./DatasetSummary";

const dataset = {
  id: 496,
  name: "009",
  exported: true,
  taskType: "detection",
  itemCount: 110,
  splitCounts: { train: 77, val: 22, test: 11 },
  classes: [
    { name: "polyp", instances: 105 },
    { name: "colono_sheath", instances: 0 },
    { name: "feces", instances: 0 },
  ],
};

describe("DatasetSummary", () => {
  it("shows task, frames and the split counts on one line", () => {
    render(<DatasetSummary dataset={dataset} />);
    expect(screen.getByText("detection · 110 frames · train 77 / val 22 / test 11")).toBeInTheDocument();
  });

  it("lists only classes with examples in the expandable list and summarises the rest", () => {
    render(<DatasetSummary dataset={dataset} />);
    expect(screen.getByText("1 class")).toBeInTheDocument();
    expect(screen.getByText("polyp")).toBeInTheDocument();
    expect(screen.getByText("105")).toBeInTheDocument();
    expect(screen.queryByText("colono_sheath")).not.toBeInTheDocument();
    expect(screen.getByText("+2 classes without examples")).toBeInTheDocument();
    expect(screen.getByText("polyp").closest("details")).not.toHaveAttribute("open");
  });

  it("says so when the dataset has no classes", () => {
    render(<DatasetSummary dataset={{ ...dataset, classes: [] }} />);
    expect(screen.getByText(/no classes/i)).toBeInTheDocument();
  });

  it("warns only when the dataset has no export yet", () => {
    const { rerender } = render(<DatasetSummary dataset={{ ...dataset, exported: false }} />);
    expect(screen.getByRole("status")).toHaveTextContent(/export it on the dataset screen/i);
    rerender(<DatasetSummary dataset={dataset} />);
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("shows the run count (plural and singular) only when given", () => {
    const { rerender } = render(<DatasetSummary dataset={dataset} runCount={3} />);
    expect(screen.getByText("3 runs")).toBeInTheDocument();
    rerender(<DatasetSummary dataset={dataset} runCount={1} />);
    expect(screen.getByText("1 run")).toBeInTheDocument();
    rerender(<DatasetSummary dataset={dataset} />);
    expect(screen.queryByText(/^\d+ runs?$/)).not.toBeInTheDocument();
  });

  it("renders nothing without a dataset", () => {
    const { container } = render(<DatasetSummary dataset={null} />);
    expect(container).toBeEmptyDOMElement();
  });
});
