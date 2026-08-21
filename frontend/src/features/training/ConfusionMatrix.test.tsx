import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import { ConfusionMatrix } from "./ConfusionMatrix";

const confusion = {
  labels: ["polyp", "erosion", "background"],
  matrix: [
    [8, 1, 2],
    [0, 5, 1],
    [3, 2, 0],
  ],
};

describe("ConfusionMatrix", () => {
  it("renders a cell per matrix entry", () => {
    render(<ConfusionMatrix confusion={confusion} />);

    expect(document.querySelectorAll("[data-cell]")).toHaveLength(9);
    expect(screen.getAllByText("polyp").length).toBeGreaterThan(0);
    expect(screen.getAllByText("background").length).toBeGreaterThan(0);
  });

  it("renders nothing when there is no matrix", () => {
    const { container } = render(<ConfusionMatrix confusion={null} />);

    expect(container).toBeEmptyDOMElement();
  });

  it("limits a large matrix until show-all is clicked", async () => {
    const labels = Array.from({ length: 20 }, (_, i) => `class_${i}`);
    const matrix = labels.map((_, row) => labels.map((__, col) => row + col));

    render(<ConfusionMatrix confusion={{ labels, matrix }} />);
    expect(document.querySelectorAll("[data-cell]").length).toBeLessThan(400);

    await userEvent.click(screen.getByRole("button", { name: /show all/i }));

    expect(document.querySelectorAll("[data-cell]")).toHaveLength(400);
  });
});
