import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
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
      />
    );
    expect(screen.getByTestId("pending-mark-overlay")).toBeInTheDocument();
  });
});
