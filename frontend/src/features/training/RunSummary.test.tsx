import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { RunSummary } from "./RunSummary";

describe("RunSummary", () => {
  it("names what will run and lists only the changed settings with their defaults", () => {
    render(
      <RunSummary
        datasetName="009"
        taskType="detection"
        baseLabel="yolo11s.pt"
        changes={[{ label: "Epochs", value: "30", defaultValue: "50" }]}
      />,
    );

    expect(screen.getByText(/what will run/i)).toBeInTheDocument();
    expect(screen.getByText(/009/)).toBeInTheDocument();
    expect(screen.getByText(/yolo11s\.pt/)).toBeInTheDocument();
    expect(screen.getByText("Epochs")).toBeInTheDocument();
    expect(screen.getByText(/30/)).toBeInTheDocument();
    expect(screen.getByText(/default 50/i)).toBeInTheDocument();
  });

  it("says when every setting is at its default", () => {
    render(<RunSummary datasetName="009" taskType="detection" baseLabel="yolo11n.pt" changes={[]} />);

    expect(screen.getByText(/default settings/i)).toBeInTheDocument();
  });
});
