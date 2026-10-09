import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
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

  it("keeps the change list in a closed details element that opens on click", async () => {
    const user = userEvent.setup();
    render(
      <RunSummary
        datasetName="009"
        taskType="detection"
        baseLabel="yolo11s.pt"
        changes={[{ label: "Epochs", value: "30", defaultValue: "50" }]}
      />,
    );

    const details = screen.getByText("1 change").closest("details")!;
    expect(details).not.toHaveAttribute("open");
    expect(details).toContainElement(screen.getByText("Epochs"));
    await user.click(screen.getByText("1 change"));
    expect(details).toHaveAttribute("open");
    expect(screen.getByText("Epochs")).toBeVisible();
  });

  it("pluralises the change count", () => {
    render(
      <RunSummary
        datasetName="009"
        taskType="detection"
        baseLabel="yolo11s.pt"
        changes={[
          { label: "Epochs", value: "30", defaultValue: "50" },
          { label: "Batch", value: "8", defaultValue: "16" },
        ]}
      />,
    );
    expect(screen.getByText("2 changes")).toBeInTheDocument();
  });

  it("shows no details element when there are no changes", () => {
    const { container } = render(
      <RunSummary datasetName="009" taskType="detection" baseLabel="yolo11n.pt" changes={[]} />,
    );
    expect(container.querySelector("details")).toBeNull();
    expect(screen.getByText(/default settings/i)).toBeInTheDocument();
  });
});
