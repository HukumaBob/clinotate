import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import { MetricsChart } from "./MetricsChart";

const history = [
  { epoch: 1, "train/loss": 1.0, "metrics/mAP50(B)": 0.2 },
  { epoch: 2, "train/loss": 0.6, "metrics/mAP50(B)": 0.5 },
  { epoch: 3, "train/loss": 0.4, "metrics/mAP50(B)": 0.7 },
];

describe("MetricsChart", () => {
  it("draws one series per metric key, epoch excluded", () => {
    render(<MetricsChart history={history} />);

    expect(screen.getByRole("button", { name: /train\/loss/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /metrics\/mAP50\(B\)/ })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^epoch$/ })).not.toBeInTheDocument();
    expect(document.querySelectorAll("path[data-series]")).toHaveLength(2);
  });

  it("hides a series when its legend entry is toggled off", async () => {
    render(<MetricsChart history={history} />);

    await userEvent.click(screen.getByRole("button", { name: /train\/loss/ }));

    expect(document.querySelectorAll("path[data-series]")).toHaveLength(1);
  });

  it("renders series it has never seen before", () => {
    render(<MetricsChart history={[{ epoch: 1, "rtdetr/custom_score": 0.3 }]} />);

    expect(screen.getByRole("button", { name: /rtdetr\/custom_score/ })).toBeInTheDocument();
  });

  it("renders nothing when there is no history", () => {
    const { container } = render(<MetricsChart history={[]} />);

    expect(container).toBeEmptyDOMElement();
  });

  it("caps an axis dominated by an early-epoch spike", () => {
    // A real run peaked at val/cls_loss 674.84 against a steady-state 2-3;
    // scaling to that maximum flattened every other series into a line.
    const spiky = [
      { epoch: 1, "val/cls_loss": 674.84 },
      ...Array.from({ length: 20 }, (_, i) => ({
        epoch: i + 2,
        "val/cls_loss": 2 + (i % 3) * 0.1,
      })),
    ];

    render(<MetricsChart history={spiky} />);

    const labels = [...document.querySelectorAll("text")].map((t) => t.textContent);
    expect(labels).not.toContain("674.84");
    // The axis top now sits in the useful range, not at the outlier.
    expect(labels.some((l) => l !== null && parseFloat(l) > 1 && parseFloat(l) < 10)).toBe(true);
  });

  it("leaves an axis alone when there is no outlier", () => {
    render(
      <MetricsChart
        history={[
          { epoch: 1, "metrics/mAP50(B)": 0.2 },
          { epoch: 2, "metrics/mAP50(B)": 0.5 },
          { epoch: 3, "metrics/mAP50(B)": 0.76 },
        ]}
      />,
    );

    expect([...document.querySelectorAll("text")].map((t) => t.textContent)).toContain("0.76");
  });
});
