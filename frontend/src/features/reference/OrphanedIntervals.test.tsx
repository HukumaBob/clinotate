import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { OrphanedIntervals, orphanRows } from "./OrphanedIntervals";

const ROWS = [
  { id: 7, labelName: "Antrum", startMs: 5000, endMs: 65000 },
  { id: 8, labelName: "Label #99", startMs: 0, endMs: 1500 },
];

describe("OrphanedIntervals", () => {
  it("renders nothing without orphaned intervals", () => {
    const { container } = render(<OrphanedIntervals rows={[]} onDelete={vi.fn()} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("lists each orphaned interval with its label and time span", () => {
    render(<OrphanedIntervals rows={ROWS} onDelete={vi.fn()} />);
    expect(screen.getByText(/2 orphaned intervals/)).toBeInTheDocument();
    const items = screen.getAllByRole("listitem");
    expect(items[0]).toHaveTextContent("Antrum 0:05–1:05");
    expect(items[1]).toHaveTextContent("Label #99 0:00–0:01");
  });

  it("deletes one interval with its Delete button", () => {
    const onDelete = vi.fn();
    render(<OrphanedIntervals rows={ROWS} onDelete={onDelete} />);
    fireEvent.click(within(screen.getAllByRole("listitem")[1]).getByRole("button", { name: "Delete" }));
    expect(onDelete).toHaveBeenCalledWith(8);
  });

  it("builds rows from the server flag, naming the label when any axis still knows it", () => {
    const reference = {
      axes: [{ category_id: 3, name: "Quality", classes: [{ label_id: 10, name: "Antrum", key: "1" }] }],
      intervals: [
        { id: 1, category_id: 2, label_id: 10, start_ms: 0, end_ms: 100, orphaned: true },
        { id: 2, category_id: 2, label_id: 11, start_ms: 200, end_ms: 300, orphaned: false },
        { id: 3, category_id: 4, label_id: 99, start_ms: 400, end_ms: 500, orphaned: true },
      ],
    };
    expect(orphanRows(reference)).toEqual([
      { id: 1, labelName: "Antrum", startMs: 0, endMs: 100 },
      { id: 3, labelName: "Label #99", startMs: 400, endMs: 500 },
    ]);
    expect(orphanRows(reference, new Set([4]))).toEqual([
      { id: 3, labelName: "Label #99", startMs: 400, endMs: 500 },
    ]);
  });
});
