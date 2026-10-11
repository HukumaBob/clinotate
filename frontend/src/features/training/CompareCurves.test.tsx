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

    expect(document.querySelectorAll("polyline, circle")).toHaveLength(1);
    expect(screen.getAllByText("(no data)")).toHaveLength(2);
  });

  it("shows an empty state when no run has history", () => {
    render(<CompareCurves runs={runs} histories={[[], [], []]} />);

    expect(screen.getByText("No training history to compare.")).toBeInTheDocument();
    expect(screen.queryByLabelText("Curve metric")).not.toBeInTheDocument();
  });

  it("shows a short high-loss run fully next to a long low-loss run", () => {
    const long = Array.from({ length: 30 }, (_, i) => ({ epoch: i + 1, "train/loss": 0.1 }));
    const short = [
      { epoch: 1, "train/loss": 50 },
      { epoch: 2, "train/loss": 40 },
    ];
    render(
      <CompareCurves
        runs={runs.slice(0, 2)}
        histories={[long, short]}
      />,
    );
    const ys = Array.from(document.querySelectorAll("polyline[data-run='2']")[0].getAttribute("points")!.split(" ")).map(
      (pt) => Number(pt.split(",")[1]),
    );
    for (const y of ys) {
      expect(y).toBeGreaterThanOrEqual(12);
      expect(y).toBeLessThanOrEqual(248);
    }
    expect(ys[0]).toBeCloseTo(12);
  });

  it("draws a flat series", () => {
    const flat = [
      { epoch: 1, "train/loss": 0.5 },
      { epoch: 2, "train/loss": 0.5 },
    ];
    render(<CompareCurves runs={runs.slice(0, 1)} histories={[flat]} />);
    const points = document.querySelector("polyline")!.getAttribute("points")!;
    expect(points).not.toMatch(/NaN|Infinity/);
  });

  it("draws a circle for a single-point run and does not call it no data", () => {
    render(
      <CompareCurves runs={runs.slice(0, 1)} histories={[[{ epoch: 3, "train/loss": 0.5 }]]} />,
    );
    expect(document.querySelectorAll("circle[data-run='1']")).toHaveLength(1);
    expect(screen.queryByText("(no data)")).not.toBeInTheDocument();
  });

  it("uses enough tick precision for small values", () => {
    const tiny = [
      { epoch: 1, "train/loss": 0.001 },
      { epoch: 2, "train/loss": 0.004 },
    ];
    render(<CompareCurves runs={runs.slice(0, 1)} histories={[tiny]} />);
    const labels = Array.from(document.querySelectorAll("svg text")).map((t) => t.textContent);
    expect(labels).not.toContain("0.00");
    expect(labels).toContain("0.0040");
  });

  it("names the chosen metric and the runs on the svg", () => {
    render(<CompareCurves runs={runs} histories={histories} />);
    const svg = screen.getByRole("img");
    expect(svg).toHaveAttribute("aria-label", expect.stringContaining("metrics/mAP50(B)"));
    expect(svg.querySelector("title")?.textContent).toContain("#2 tuned");
  });
});
