import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

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
        onOpenSequence={vi.fn()}
        onRenameSequence={vi.fn()}
        onRecutSequence={vi.fn()}
        onMarkStartChange={vi.fn()}
        onMarkEndChange={vi.fn()}
        onScrub={vi.fn()}
      />
    );

    expect(screen.getByText("Larynx")).toBeInTheDocument();
    expect(screen.getByText("Esophagus")).toBeInTheDocument();
  });

  it("calls onOpenSequence with the right id when a segment's open action is used", async () => {
    const onOpen = vi.fn();
    render(
      <SequenceTimeline
        durationSeconds={100}
        sequences={sequences}
        markStart={null}
        markEnd={null}
        onOpenSequence={onOpen}
        onRenameSequence={vi.fn()}
        onRecutSequence={vi.fn()}
        onMarkStartChange={vi.fn()}
        onMarkEndChange={vi.fn()}
        onScrub={vi.fn()}
      />
    );

    await userEvent.click(screen.getByRole("button", { name: /open larynx/i }));
    expect(onOpen).toHaveBeenCalledWith(1);
  });

  it("calls onRenameSequence with the right id when a segment's rename action is used", async () => {
    const onRename = vi.fn();
    render(
      <SequenceTimeline
        durationSeconds={100}
        sequences={sequences}
        markStart={null}
        markEnd={null}
        onOpenSequence={vi.fn()}
        onRenameSequence={onRename}
        onRecutSequence={vi.fn()}
        onMarkStartChange={vi.fn()}
        onMarkEndChange={vi.fn()}
        onScrub={vi.fn()}
      />
    );

    await userEvent.click(screen.getByRole("button", { name: /rename larynx/i }));
    expect(onRename).toHaveBeenCalledWith(1);
  });

  it("calls onRecutSequence with the right id when a segment's re-cut action is used", async () => {
    const onRecut = vi.fn();
    render(
      <SequenceTimeline
        durationSeconds={100}
        sequences={sequences}
        markStart={null}
        markEnd={null}
        onOpenSequence={vi.fn()}
        onRenameSequence={vi.fn()}
        onRecutSequence={onRecut}
        onMarkStartChange={vi.fn()}
        onMarkEndChange={vi.fn()}
        onScrub={vi.fn()}
      />
    );

    await userEvent.click(screen.getByRole("button", { name: /re-cut esophagus/i }));
    expect(onRecut).toHaveBeenCalledWith(2);
  });

  it("renders the in-progress mark overlay only when both marks are set", () => {
    const { rerender } = render(
      <SequenceTimeline
        durationSeconds={100}
        sequences={[]}
        markStart={10}
        markEnd={null}
        onOpenSequence={vi.fn()}
        onRenameSequence={vi.fn()}
        onRecutSequence={vi.fn()}
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
        onOpenSequence={vi.fn()}
        onRenameSequence={vi.fn()}
        onRecutSequence={vi.fn()}
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
        onOpenSequence={vi.fn()}
        onRenameSequence={vi.fn()}
        onRecutSequence={vi.fn()}
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
        onOpenSequence={vi.fn()}
        onRenameSequence={vi.fn()}
        onRecutSequence={vi.fn()}
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
        onOpenSequence={vi.fn()}
        onRenameSequence={vi.fn()}
        onRecutSequence={vi.fn()}
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
        onOpenSequence={vi.fn()}
        onRenameSequence={vi.fn()}
        onRecutSequence={vi.fn()}
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
        onOpenSequence={vi.fn()}
        onRenameSequence={vi.fn()}
        onRecutSequence={vi.fn()}
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
        onOpenSequence={vi.fn()}
        onRenameSequence={vi.fn()}
        onRecutSequence={vi.fn()}
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
        onOpenSequence={vi.fn()}
        onRenameSequence={vi.fn()}
        onRecutSequence={vi.fn()}
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

  it("clicking a segment's action button does not start a drag", async () => {
    const onOpen = vi.fn();
    const onMarkStartChange = vi.fn();
    render(
      <SequenceTimeline
        durationSeconds={100}
        sequences={sequences}
        markStart={null}
        markEnd={null}
        onOpenSequence={onOpen}
        onRenameSequence={vi.fn()}
        onRecutSequence={vi.fn()}
        onMarkStartChange={onMarkStartChange}
        onMarkEndChange={vi.fn()}
        onScrub={vi.fn()}
      />
    );

    await userEvent.click(screen.getByRole("button", { name: /open larynx/i }));

    expect(onOpen).toHaveBeenCalledWith(1);
    expect(onMarkStartChange).not.toHaveBeenCalled();
  });
});
