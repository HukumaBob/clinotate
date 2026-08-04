import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";

import { SequenceTimeline } from "./SequenceTimeline";

const sequences = [
  { id: 1, name: "Larynx", video_id: 5, procedure_id: 1, start_time: 0, duration: 20, annotation_count: 0 },
  { id: 2, name: "Esophagus", video_id: 5, procedure_id: 1, start_time: 20, duration: 30, annotation_count: 2 },
];

describe("SequenceTimeline", () => {
  it("renders one segment per existing sequence with its name", () => {
    render(
      <SequenceTimeline
        durationSeconds={100}
        sequences={sequences}
        markStart={null}
        markEnd={null}
        onSegmentClick={vi.fn()}
        onEmptyBackgroundClick={vi.fn()}
        onMarkStartChange={vi.fn()}
        onMarkEndChange={vi.fn()}
        onScrub={vi.fn()}
      />
    );

    expect(screen.getByText("Larynx")).toBeInTheDocument();
    expect(screen.getByText("Esophagus")).toBeInTheDocument();
  });

  it("renders the in-progress mark overlay only when both marks are set", () => {
    const { rerender } = render(
      <SequenceTimeline
        durationSeconds={100}
        sequences={[]}
        markStart={10}
        markEnd={null}
        onSegmentClick={vi.fn()}
        onEmptyBackgroundClick={vi.fn()}
        onMarkStartChange={vi.fn()}
        onMarkEndChange={vi.fn()}
        onScrub={vi.fn()}
      />
    );
    expect(screen.queryByTestId("pending-mark-overlay")).not.toBeInTheDocument();

    rerender(
      <SequenceTimeline
        durationSeconds={100}
        sequences={[]}
        markStart={10}
        markEnd={40}
        onSegmentClick={vi.fn()}
        onEmptyBackgroundClick={vi.fn()}
        onMarkStartChange={vi.fn()}
        onMarkEndChange={vi.fn()}
        onScrub={vi.fn()}
      />
    );
    expect(screen.getByTestId("pending-mark-overlay")).toBeInTheDocument();
  });

  it("drag-creates a new pending region from empty timeline background", () => {
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockReturnValue({
      left: 0, right: 200, top: 0, bottom: 40, width: 200, height: 40, x: 0, y: 0, toJSON: () => {},
    });
    const onMarkStartChange = vi.fn();
    const onMarkEndChange = vi.fn();
    const onScrub = vi.fn();
    const { container } = render(
      <SequenceTimeline
        durationSeconds={100}
        sequences={[]}
        markStart={null}
        markEnd={null}
        onSegmentClick={vi.fn()}
        onEmptyBackgroundClick={vi.fn()}
        onMarkStartChange={onMarkStartChange}
        onMarkEndChange={onMarkEndChange}
        onScrub={onScrub}
      />
    );

    const root = container.firstChild as HTMLElement;
    // 200px wide timeline, 100s video -> 2px/second. clientX=40 -> 20s anchor.
    fireEvent.mouseDown(root, { clientX: 40, target: root, currentTarget: root });
    // clientX=100 -> 50s.
    fireEvent.mouseMove(window, { clientX: 100 });

    expect(onMarkStartChange).toHaveBeenLastCalledWith(20);
    expect(onMarkEndChange).toHaveBeenLastCalledWith(50);
    expect(onScrub).toHaveBeenLastCalledWith(50);

    fireEvent.mouseUp(window);
  });

  it("dragging the start handle moves only markStart, leaving markEnd fixed", () => {
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockReturnValue({
      left: 0, right: 200, top: 0, bottom: 40, width: 200, height: 40, x: 0, y: 0, toJSON: () => {},
    });
    const onMarkStartChange = vi.fn();
    const onMarkEndChange = vi.fn();
    render(
      <SequenceTimeline
        durationSeconds={100}
        sequences={[]}
        markStart={10}
        markEnd={60}
        onSegmentClick={vi.fn()}
        onEmptyBackgroundClick={vi.fn()}
        onMarkStartChange={onMarkStartChange}
        onMarkEndChange={onMarkEndChange}
        onScrub={vi.fn()}
      />
    );

    const handle = screen.getByTestId("mark-handle-start");
    fireEvent.mouseDown(handle);
    // clientX=50 -> 25s.
    fireEvent.mouseMove(window, { clientX: 50 });

    expect(onMarkStartChange).toHaveBeenLastCalledWith(25);
    expect(onMarkEndChange).not.toHaveBeenCalled();

    fireEvent.mouseUp(window);
  });

  it("dragging the end handle moves only markEnd, leaving markStart fixed", () => {
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockReturnValue({
      left: 0, right: 200, top: 0, bottom: 40, width: 200, height: 40, x: 0, y: 0, toJSON: () => {},
    });
    const onMarkStartChange = vi.fn();
    const onMarkEndChange = vi.fn();
    render(
      <SequenceTimeline
        durationSeconds={100}
        sequences={[]}
        markStart={10}
        markEnd={60}
        onSegmentClick={vi.fn()}
        onEmptyBackgroundClick={vi.fn()}
        onMarkStartChange={onMarkStartChange}
        onMarkEndChange={onMarkEndChange}
        onScrub={vi.fn()}
      />
    );

    const handle = screen.getByTestId("mark-handle-end");
    fireEvent.mouseDown(handle);
    // clientX=150 -> 75s.
    fireEvent.mouseMove(window, { clientX: 150 });

    expect(onMarkEndChange).toHaveBeenLastCalledWith(75);
    expect(onMarkStartChange).not.toHaveBeenCalled();

    fireEvent.mouseUp(window);
  });

  it("snaps a dragged edge to an adjacent sequence boundary within 8px", () => {
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockReturnValue({
      left: 0, right: 200, top: 0, bottom: 40, width: 200, height: 40, x: 0, y: 0, toJSON: () => {},
    });
    const onMarkEndChange = vi.fn();
    render(
      <SequenceTimeline
        durationSeconds={100}
        sequences={[{ id: 1, name: "Larynx", video_id: 5, procedure_id: 1, start_time: 0, duration: 76, annotation_count: 0 }]}
        markStart={10}
        markEnd={60}
        onSegmentClick={vi.fn()}
        onEmptyBackgroundClick={vi.fn()}
        onMarkStartChange={vi.fn()}
        onMarkEndChange={onMarkEndChange}
        onScrub={vi.fn()}
      />
    );

    // Larynx ends at 76s -> clientX=152. Drag end handle to clientX=155 (3px away, within 8px threshold).
    const handle = screen.getByTestId("mark-handle-end");
    fireEvent.mouseDown(handle);
    fireEvent.mouseMove(window, { clientX: 155 });

    expect(onMarkEndChange).toHaveBeenLastCalledWith(76);

    fireEvent.mouseUp(window);
  });

  it("does not let the start handle cross past markEnd minus the 1-second minimum width", () => {
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockReturnValue({
      left: 0, right: 200, top: 0, bottom: 40, width: 200, height: 40, x: 0, y: 0, toJSON: () => {},
    });
    const onMarkStartChange = vi.fn();
    render(
      <SequenceTimeline
        durationSeconds={100}
        sequences={[]}
        markStart={10}
        markEnd={20}
        onSegmentClick={vi.fn()}
        onEmptyBackgroundClick={vi.fn()}
        onMarkStartChange={onMarkStartChange}
        onMarkEndChange={vi.fn()}
        onScrub={vi.fn()}
      />
    );

    // Drag start handle far past markEnd (20s -> clientX=40). clientX=180 -> 90s raw.
    const handle = screen.getByTestId("mark-handle-start");
    fireEvent.mouseDown(handle);
    fireEvent.mouseMove(window, { clientX: 180 });

    // Clamped to markEnd(20) - 1 = 19.
    expect(onMarkStartChange).toHaveBeenLastCalledWith(19);

    fireEvent.mouseUp(window);
  });

  it("enforces the 1-second minimum width when drag-creating a new region", () => {
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockReturnValue({
      left: 0, right: 200, top: 0, bottom: 40, width: 200, height: 40, x: 0, y: 0, toJSON: () => {},
    });
    const onMarkStartChange = vi.fn();
    const onMarkEndChange = vi.fn();
    const onScrub = vi.fn();
    const { container } = render(
      <SequenceTimeline
        durationSeconds={100}
        sequences={[]}
        markStart={null}
        markEnd={null}
        onSegmentClick={vi.fn()}
        onEmptyBackgroundClick={vi.fn()}
        onMarkStartChange={onMarkStartChange}
        onMarkEndChange={onMarkEndChange}
        onScrub={onScrub}
      />
    );

    const root = container.firstChild as HTMLElement;
    // 200px wide timeline, 100s video -> 2px/second. clientX=40 -> 20s anchor.
    fireEvent.mouseDown(root, { clientX: 40, target: root, currentTarget: root });
    // clientX=41 -> 20.5s raw, only 0.5s away from the anchor (below the 1s minimum).
    fireEvent.mouseMove(window, { clientX: 41 });

    const start = onMarkStartChange.mock.calls.at(-1)?.[0] as number;
    const end = onMarkEndChange.mock.calls.at(-1)?.[0] as number;
    expect(end - start).toBeGreaterThanOrEqual(1);
    // The anchor (20s) must not move: since we dragged right, the start stays at the anchor
    // and the end is the one pushed out to enforce the minimum width.
    expect(start).toBe(20);
    expect(end).toBe(21);

    fireEvent.mouseUp(window);
  });

  it("pending-mark-overlay does not swallow mousedown, allowing a fresh drag over it", () => {
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockReturnValue({
      left: 0, right: 200, top: 0, bottom: 40, width: 200, height: 40, x: 0, y: 0, toJSON: () => {},
    });
    const onMarkStartChange = vi.fn();
    const onMarkEndChange = vi.fn();
    render(
      <SequenceTimeline
        durationSeconds={100}
        sequences={[]}
        markStart={10}
        markEnd={60}
        onSegmentClick={vi.fn()}
        onEmptyBackgroundClick={vi.fn()}
        onMarkStartChange={onMarkStartChange}
        onMarkEndChange={onMarkEndChange}
        onScrub={vi.fn()}
      />
    );

    const overlay = screen.getByTestId("pending-mark-overlay");
    expect(overlay.className).toContain("pointer-events-none");

    // A mousedown that lands on the overlay's screen position, targeting the root (since
    // pointer-events-none means the browser passes the event through to the root element).
    const root = overlay.parentElement as HTMLElement;
    fireEvent.mouseDown(root, { clientX: 100, target: root, currentTarget: root });
    fireEvent.mouseMove(window, { clientX: 120 });

    expect(onMarkStartChange).toHaveBeenCalled();
    expect(onMarkEndChange).toHaveBeenCalled();

    fireEvent.mouseUp(window);
  });

  it("clicking a segment's body (not its name) calls onSegmentClick with the segment's bounds", () => {
    const onSegmentClick = vi.fn();
    render(
      <SequenceTimeline
        durationSeconds={100}
        sequences={sequences}
        markStart={null}
        markEnd={null}
        onSegmentClick={onSegmentClick}
        onEmptyBackgroundClick={vi.fn()}
        onMarkStartChange={vi.fn()}
        onMarkEndChange={vi.fn()}
        onScrub={vi.fn()}
      />
    );

    // Esophagus: start_time=20, duration=30 -> bounds [20, 50].
    fireEvent.mouseDown(screen.getByTitle("Esophagus"));

    expect(onSegmentClick).toHaveBeenCalledWith(2, 20, 50);
  });

  it("a true click on empty background (no meaningful mouse movement) sets marks to the gap between neighbors and calls onEmptyBackgroundClick", () => {
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockReturnValue({
      left: 0, right: 200, top: 0, bottom: 40, width: 200, height: 40, x: 0, y: 0, toJSON: () => {},
    });
    const onMarkStartChange = vi.fn();
    const onMarkEndChange = vi.fn();
    const onEmptyBackgroundClick = vi.fn();
    const { container } = render(
      <SequenceTimeline
        durationSeconds={100}
        sequences={sequences}
        markStart={null}
        markEnd={null}
        onSegmentClick={vi.fn()}
        onEmptyBackgroundClick={onEmptyBackgroundClick}
        onMarkStartChange={onMarkStartChange}
        onMarkEndChange={onMarkEndChange}
        onScrub={vi.fn()}
      />
    );

    // sequences: Larynx [0,20), Esophagus [20,50). Click in the gap after
    // Esophagus, e.g. clientX=140 -> 70s (200px/100s = 2px/s). Gap bounds:
    // left=50 (Esophagus's end), right=100 (durationSeconds, no next segment).
    const root = container.firstChild as HTMLElement;
    fireEvent.mouseDown(root, { clientX: 140, target: root, currentTarget: root });
    // No mousemove at all -- or one within the 3px threshold; mouseup at the same clientX.
    fireEvent.mouseUp(window, { clientX: 140 });

    expect(onMarkStartChange).toHaveBeenLastCalledWith(50);
    expect(onMarkEndChange).toHaveBeenLastCalledWith(100);
    expect(onEmptyBackgroundClick).toHaveBeenCalled();
  });

  it("a click between two segments sets marks to the gap bounded by both neighbors", () => {
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockReturnValue({
      left: 0, right: 200, top: 0, bottom: 40, width: 200, height: 40, x: 0, y: 0, toJSON: () => {},
    });
    const onMarkStartChange = vi.fn();
    const onMarkEndChange = vi.fn();
    const threeSequences = [
      { id: 1, name: "A", video_id: 5, procedure_id: 1, start_time: 0, duration: 20, annotation_count: 0 },
      { id: 2, name: "B", video_id: 5, procedure_id: 1, start_time: 40, duration: 10, annotation_count: 0 },
    ];
    const { container } = render(
      <SequenceTimeline
        durationSeconds={100}
        sequences={threeSequences}
        markStart={null}
        markEnd={null}
        onSegmentClick={vi.fn()}
        onEmptyBackgroundClick={vi.fn()}
        onMarkStartChange={onMarkStartChange}
        onMarkEndChange={onMarkEndChange}
        onScrub={vi.fn()}
      />
    );

    // Gap is [20, 40). Click at 30s -> clientX=60.
    const root = container.firstChild as HTMLElement;
    fireEvent.mouseDown(root, { clientX: 60, target: root, currentTarget: root });
    fireEvent.mouseUp(window, { clientX: 60 });

    expect(onMarkStartChange).toHaveBeenLastCalledWith(20);
    expect(onMarkEndChange).toHaveBeenLastCalledWith(40);
  });

  it("a real drag (movement past the 3px click threshold) still behaves as today's drag-to-create, not a click", () => {
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockReturnValue({
      left: 0, right: 200, top: 0, bottom: 40, width: 200, height: 40, x: 0, y: 0, toJSON: () => {},
    });
    const onMarkStartChange = vi.fn();
    const onMarkEndChange = vi.fn();
    const onEmptyBackgroundClick = vi.fn();
    const { container } = render(
      <SequenceTimeline
        durationSeconds={100}
        sequences={[]}
        markStart={null}
        markEnd={null}
        onSegmentClick={vi.fn()}
        onEmptyBackgroundClick={onEmptyBackgroundClick}
        onMarkStartChange={onMarkStartChange}
        onMarkEndChange={onMarkEndChange}
        onScrub={vi.fn()}
      />
    );

    const root = container.firstChild as HTMLElement;
    fireEvent.mouseDown(root, { clientX: 40, target: root, currentTarget: root });
    fireEvent.mouseMove(window, { clientX: 100 });
    fireEvent.mouseUp(window, { clientX: 100 });

    // Drag-to-create result (anchor=20s, dragged to 50s) must be preserved as-is.
    expect(onMarkStartChange).toHaveBeenLastCalledWith(20);
    expect(onMarkEndChange).toHaveBeenLastCalledWith(50);
    // The click-only callback must NOT fire for a real drag.
    expect(onEmptyBackgroundClick).not.toHaveBeenCalled();
  });
});
