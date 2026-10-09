// DatasetCard.test.tsx
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { DatasetCard } from "./DatasetCard";

const dataset = {
  id: 496,
  name: "009",
  exported: true,
  taskType: "detection",
  itemCount: 110,
  splitCounts: { train: 77, val: 22, test: 11 },
  classes: [
    { name: "polyp", instances: 105 },
    { name: "colono_shea", instances: 40 },
  ],
};

describe("DatasetCard", () => {
  it("shows the task, the frame counts per split and every class with its instances", () => {
    render(<DatasetCard dataset={dataset} />);

    expect(screen.getByText(/detection/i)).toBeInTheDocument();
    expect(screen.getByText(/110 frames/i)).toBeInTheDocument();
    expect(screen.getByText(/train 77/i)).toBeInTheDocument();
    expect(screen.getByText(/val 22/i)).toBeInTheDocument();
    expect(screen.getByText(/test 11/i)).toBeInTheDocument();
    expect(screen.getByText("polyp")).toBeInTheDocument();
    expect(screen.getByText("105")).toBeInTheDocument();
  });

  it("warns when the dataset has no export yet", () => {
    render(<DatasetCard dataset={{ ...dataset, exported: false }} />);

    expect(screen.getByRole("status")).toHaveTextContent(/export it on the dataset screen/i);
  });

  it("does not warn for an exported dataset", () => {
    render(<DatasetCard dataset={dataset} />);

    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("says so when the dataset has no classes", () => {
    render(<DatasetCard dataset={{ ...dataset, classes: [] }} />);

    expect(screen.getByText(/no classes/i)).toBeInTheDocument();
  });

  it("renders nothing without a dataset", () => {
    const { container } = render(<DatasetCard dataset={null} />);

    expect(container).toBeEmptyDOMElement();
  });

  it("shows the run count when given (plural and singular) and nothing when omitted", () => {
    const { rerender } = render(<DatasetCard dataset={dataset} runCount={3} />);
    expect(screen.getByText("3 runs")).toBeInTheDocument();
    rerender(<DatasetCard dataset={dataset} runCount={1} />);
    expect(screen.getByText("1 run")).toBeInTheDocument();
    rerender(<DatasetCard dataset={dataset} />);
    expect(screen.queryByText(/\d+ runs?$/)).not.toBeInTheDocument();
  });
});
