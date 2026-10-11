import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import { COMPARE_COLORS, type CompareRunInfo } from "./CompareCurves";
import { CompareTables } from "./CompareTables";

const runs: CompareRunInfo[] = [
  { id: 1, label: "#1", color: COMPARE_COLORS[0] },
  { id: 2, label: "#2", color: COMPARE_COLORS[1] },
];
const runObjects = [
  { id: 1, base_model: "yolo11n", config: { epochs: 50, imgsz: 640 } },
  { id: 2, base_model: "yolo11n", config: { epochs: 100, imgsz: 640 } },
];
const metrics = [
  {
    metrics: { mAP50: 0.5, only_first: 0.2 },
    per_class: [
      { class: "polyp", precision: 0.5, recall: 0.4 },
      { class: "ulcer", precision: 0.6 },
    ],
  },
  {
    metrics: { mAP50: 0.623 },
    per_class: [
      { class: "polyp", precision: 0.455, recall: 0.9 },
      { class: "ulcer", recall: 0.3 },
    ],
  },
];

function section(name: string): HTMLElement {
  const heading = screen.getByRole("heading", { name });
  return heading.parentElement as HTMLElement;
}

describe("CompareTables", () => {
  it("renders captions for all three sections", () => {
    render(<CompareTables runs={runs} runObjects={runObjects} metrics={metrics} schema={null} />);

    for (const name of ["Configuration differences", "Final metrics", "Per-class metrics"]) {
      const heading = screen.getByRole("heading", { name });
      expect(heading.parentElement?.querySelector("p")).not.toBeNull();
    }
  });

  it("lists only differing settings", () => {
    render(<CompareTables runs={runs} runObjects={runObjects} metrics={metrics} schema={null} />);

    const config = within(section("Configuration differences"));
    expect(config.getByText("epochs")).toBeInTheDocument();
    expect(config.getByText("100")).toBeInTheDocument();
    expect(config.queryByText("imgsz")).not.toBeInTheDocument();
  });

  it("shows the empty config state when nothing differs", () => {
    render(
      <CompareTables
        runs={runs}
        runObjects={[runObjects[0], runObjects[0]]}
        metrics={metrics}
        schema={null}
      />,
    );

    expect(screen.getByText("No setting differs between these runs.")).toBeInTheDocument();
  });

  it("marks only the best final value and shows signed deltas for non-first runs", () => {
    render(<CompareTables runs={runs} runObjects={runObjects} metrics={metrics} schema={null} />);

    const finals = within(section("Final metrics"));
    const best = finals.getByText("0.6230");
    expect(best).toHaveClass("font-semibold", "text-green-300");
    expect(best).toHaveAttribute("title", "Best among the compared runs");
    expect(finals.getByText("0.5000")).not.toHaveClass("text-green-300");
    expect(finals.getByText("+0.123")).toBeInTheDocument();
    expect(finals.getAllByText(/^[+−]\d\.\d{3}$/)).toHaveLength(1);
  });

  it("shows a dash for a missing value, never 0", () => {
    render(<CompareTables runs={runs} runObjects={runObjects} metrics={metrics} schema={null} />);

    const finals = within(section("Final metrics"));
    expect(finals.getByText("—")).toBeInTheDocument();
    expect(finals.queryByText("0.0000")).not.toBeInTheDocument();
  });

  it("uses a minus sign for negative deltas", () => {
    render(
      <CompareTables
        runs={runs}
        runObjects={runObjects}
        metrics={[
          { metrics: { mAP50: 0.5 }, per_class: [] },
          { metrics: { mAP50: 0.455 }, per_class: [] },
        ]}
        schema={null}
      />,
    );

    expect(screen.getByText("−0.045")).toBeInTheDocument();
  });

  it("switches the per-class metric column", async () => {
    render(<CompareTables runs={runs} runObjects={runObjects} metrics={metrics} schema={null} />);

    const perClass = within(section("Per-class metrics"));
    expect(perClass.getByLabelText("Per-class metric")).toHaveValue("precision");
    expect(perClass.getByText("0.4550")).toBeInTheDocument();

    await userEvent.selectOptions(perClass.getByLabelText("Per-class metric"), "recall");

    expect(perClass.getByText("0.9000")).toBeInTheDocument();
    expect(perClass.queryByText("0.4550")).not.toBeInTheDocument();
  });

  it("shows empty states for final and per-class metrics", () => {
    render(
      <CompareTables
        runs={runs}
        runObjects={runObjects}
        metrics={[null, null]}
        schema={null}
      />,
    );

    expect(screen.getByText("No final metrics reported.")).toBeInTheDocument();
    expect(screen.getByText("No per-class metrics for these runs.")).toBeInTheDocument();
  });
});
