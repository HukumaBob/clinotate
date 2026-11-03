import { fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ReferenceLanes } from "./ReferenceLanes";
import type { RefAxis, RefInterval } from "./types";

const AXES: RefAxis[] = [
  { categoryId: 2, name: "Location", classes: [{ labelId: 10, name: "Antrum", key: "1" }] },
  { categoryId: 3, name: "Quality", classes: [{ labelId: 20, name: "Good", key: "3" }] },
];

const INTERVALS: RefInterval[] = [
  { id: 1, categoryId: 2, labelId: 10, startMs: 1000, endMs: 3000 },
  { id: 2, categoryId: 2, labelId: 10, startMs: 5000, endMs: 6000 },
  { id: 3, categoryId: 3, labelId: 20, startMs: 0, endMs: 10000 },
];

function renderLanes(overrides: Partial<React.ComponentProps<typeof ReferenceLanes>> = {}) {
  const props: React.ComponentProps<typeof ReferenceLanes> = {
    videoRef: { current: null },
    axes: AXES,
    intervals: INTERVALS,
    growing: {},
    selectedId: null,
    durationMs: 10000,
    onSelect: vi.fn(),
    onDragEdge: vi.fn(),
    ...overrides,
  };
  render(<ReferenceLanes {...props} />);
  return props;
}

afterEach(() => vi.restoreAllMocks());

describe("ReferenceLanes", () => {
  it("draws one lane per axis with its segments, gaps and coverage", () => {
    renderLanes();
    const location = screen.getByTestId("lane-2");
    expect(within(location).getAllByTestId(/^segment-/)).toHaveLength(2);
    // 0-1000, 3000-5000, 6000-10000
    expect(within(location).getAllByTestId("gap")).toHaveLength(3);
    expect(screen.getByText("30% labeled")).toBeInTheDocument();
    const quality = screen.getByTestId("lane-3");
    expect(within(quality).queryAllByTestId("gap")).toHaveLength(0);
    expect(screen.getByText("100% labeled")).toBeInTheDocument();
  });

  it("positions segments as percentages of the duration", () => {
    renderLanes();
    const segment = screen.getByTestId("segment-1");
    expect(segment.style.left).toBe("10%");
    expect(segment.style.width).toBe("20%");
  });

  it("a click on a segment selects it", () => {
    const props = renderLanes();
    fireEvent.click(screen.getByTestId("segment-2"));
    expect(props.onSelect).toHaveBeenCalledWith(2);
  });

  it("shows handles only on the selected interval", () => {
    renderLanes({ selectedId: 1 });
    expect(screen.getAllByTestId(/^handle-/)).toHaveLength(2);
    expect(screen.getByTestId("handle-1-start")).toBeInTheDocument();
    expect(screen.getByTestId("handle-1-end")).toBeInTheDocument();
  });

  it("outlines the growing interval", () => {
    renderLanes({ growing: { 2: INTERVALS[1] } });
    expect(screen.getByTestId("segment-2").className).toContain("outline");
    expect(screen.getByTestId("segment-1").className).not.toContain("outline");
  });

  it("dragging a handle reports the time under the pointer in ms", () => {
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
      left: 100, width: 500, top: 0, height: 20, right: 600, bottom: 20, x: 100, y: 0, toJSON: () => ({}),
    } as DOMRect);
    const props = renderLanes({ selectedId: 1 });
    fireEvent.pointerDown(screen.getByTestId("handle-1-end"), { clientX: 250, pointerId: 1 });
    fireEvent.pointerMove(window, { clientX: 300, pointerId: 1 });
    expect(props.onDragEdge).toHaveBeenLastCalledWith(1, "end", 4000);
    fireEvent.pointerUp(window, { clientX: 300, pointerId: 1 });
    fireEvent.pointerMove(window, { clientX: 400, pointerId: 1 });
    expect(props.onDragEdge).toHaveBeenCalledTimes(1);
  });

  it("warns about orphaned intervals only when there are some", () => {
    renderLanes();
    expect(screen.queryByText(/orphaned/)).toBeNull();
  });

  it("lists the orphaned intervals with their spans and deletes one", () => {
    const props = renderLanes({
      orphaned: [
        { id: 7, labelName: "Antrum", startMs: 5000, endMs: 65000 },
        { id: 8, labelName: "Label #99", startMs: 0, endMs: 1500 },
      ],
      onDeleteOrphan: vi.fn(),
    });
    expect(screen.getByText(/2 orphaned intervals/)).toBeInTheDocument();
    expect(screen.getByText(/Antrum 0:05–1:05/)).toBeInTheDocument();
    fireEvent.click(screen.getAllByRole("button", { name: "Delete" })[0]);
    expect(props.onDeleteOrphan).toHaveBeenCalledWith(7);
  });

  it("does not draw or count orphaned intervals (class no longer on the axis)", () => {
    renderLanes({
      intervals: [
        { id: 1, categoryId: 2, labelId: 10, startMs: 0, endMs: 2000 },
        { id: 9, categoryId: 2, labelId: 99, startMs: 5000, endMs: 10000 },
      ],
      orphaned: [{ id: 9, labelName: "Label #99", startMs: 5000, endMs: 10000 }],
    });
    expect(screen.queryByTestId("segment-9")).toBeNull();
    expect(screen.getByText("20% labeled")).toBeInTheDocument();
    expect(screen.getByText(/1 orphaned interval/)).toBeInTheDocument();
  });
});
