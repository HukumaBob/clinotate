import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { PerClassTable } from "./PerClassTable";

const rows = [
  { class: "polyp", mAP50: 0.7, "Box-P": 0.8 },
  { class: "ulcer", mAP50: 0.9, "Box-P": 0.5 },
];

function firstColumnOrder(): string[] {
  return screen
    .getAllByRole("row")
    .slice(1)
    .map((row) => row.querySelector("td")?.textContent ?? "");
}

describe("PerClassTable", () => {
  it("derives the columns from the rows with class first", () => {
    render(<PerClassTable rows={[{ mAP50: 0.7, class: "polyp", "Box-P": 0.8 }]} />);
    const headers = screen.getAllByRole("columnheader").map((h) => h.textContent);
    expect(headers).toEqual(["class", "mAP50", "Box-P"]);
    expect(screen.getByText("0.7000")).toBeInTheDocument();
  });

  it("renders a trainer's unfamiliar column names untouched", () => {
    render(<PerClassTable rows={[{ class: "polyp", ap_50: 0.31 }]} />);
    expect(screen.getByRole("button", { name: /ap_50/ })).toBeInTheDocument();
  });

  it("sorts a numeric column descending first, then ascending, with arrows", () => {
    render(<PerClassTable rows={rows} />);
    fireEvent.click(screen.getByRole("button", { name: "mAP50" }));
    expect(firstColumnOrder()).toEqual(["ulcer", "polyp"]);
    expect(screen.getByRole("button", { name: /mAP50 ↓/ })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /mAP50/ }));
    expect(firstColumnOrder()).toEqual(["polyp", "ulcer"]);
    expect(screen.getByRole("button", { name: /mAP50 ↑/ })).toBeInTheDocument();
  });

  it("renders nothing for empty rows", () => {
    const { container } = render(<PerClassTable rows={[]} />);
    expect(container).toBeEmptyDOMElement();
  });
});
