import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { SequenceTimeline } from "./SequenceTimeline";

const sequences = [
  { id: 1, name: "Larynx", video_id: 5, procedure_id: 1, start_time: 0, duration: 20 },
  { id: 2, name: "Esophagus", video_id: 5, procedure_id: 1, start_time: 20, duration: 30 },
];

describe("SequenceTimeline", () => {
  it("renders one segment per existing sequence with its name", () => {
    render(
      <SequenceTimeline
        durationSeconds={100}
        sequences={sequences}
        markStart={null}
        markEnd={null}
        onMarkStart={vi.fn()}
        onMarkEnd={vi.fn()}
        onOpenSequence={vi.fn()}
        markStartDisabled={false}
        markEndDisabled={false}
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
        onMarkStart={vi.fn()}
        onMarkEnd={vi.fn()}
        onOpenSequence={onOpen}
        markStartDisabled={false}
        markEndDisabled={false}
      />
    );

    await userEvent.click(screen.getByRole("button", { name: /open larynx/i }));
    expect(onOpen).toHaveBeenCalledWith(1);
  });

  it("renders the in-progress mark overlay only when both marks are set", () => {
    const { rerender } = render(
      <SequenceTimeline
        durationSeconds={100}
        sequences={[]}
        markStart={10}
        markEnd={null}
        onMarkStart={vi.fn()}
        onMarkEnd={vi.fn()}
        onOpenSequence={vi.fn()}
        markStartDisabled={false}
        markEndDisabled={false}
      />
    );
    expect(screen.queryByTestId("pending-mark-overlay")).not.toBeInTheDocument();

    rerender(
      <SequenceTimeline
        durationSeconds={100}
        sequences={[]}
        markStart={10}
        markEnd={40}
        onMarkStart={vi.fn()}
        onMarkEnd={vi.fn()}
        onOpenSequence={vi.fn()}
        markStartDisabled={false}
        markEndDisabled={false}
      />
    );
    expect(screen.getByTestId("pending-mark-overlay")).toBeInTheDocument();
  });

  it("calls onMarkStart and onMarkEnd when their buttons are clicked", async () => {
    const onMarkStart = vi.fn();
    const onMarkEnd = vi.fn();
    render(
      <SequenceTimeline
        durationSeconds={100}
        sequences={[]}
        markStart={null}
        markEnd={null}
        onMarkStart={onMarkStart}
        onMarkEnd={onMarkEnd}
        onOpenSequence={vi.fn()}
        markStartDisabled={false}
        markEndDisabled={false}
      />
    );

    await userEvent.click(screen.getByRole("button", { name: /mark start/i }));
    await userEvent.click(screen.getByRole("button", { name: /mark end/i }));

    expect(onMarkStart).toHaveBeenCalled();
    expect(onMarkEnd).toHaveBeenCalled();
  });
});
