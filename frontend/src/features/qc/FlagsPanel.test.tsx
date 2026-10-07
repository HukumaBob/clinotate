import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";

import type { QcFlag } from "../../entities/useQcFlags";
import { FlagsPanel } from "./FlagsPanel";

const flag = (over: Partial<QcFlag>): QcFlag => ({
  id: 1,
  run_id: 7,
  kind: "fp",
  frame_index: 5,
  timestamp_ms: 202000,
  note: null,
  created_by_id: 1,
  committed_at: null,
  frame_id: null,
  sequence_id: null,
  ...over,
});

function setup(flags: QcFlag[], overrides = {}) {
  const props = {
    flags,
    loadFailed: false,
    onRetry: vi.fn(),
    onSeek: vi.fn(),
    onRemove: vi.fn(),
    onNoteChange: vi.fn(),
    onSend: vi.fn(),
    lastSequence: null as { id: number; name: string } | null,
    ...overrides,
  };
  render(
    <MemoryRouter>
      <FlagsPanel {...props} />
    </MemoryRouter>,
  );
  return props;
}

describe("FlagsPanel", () => {
  it("counts pending and sent flags", () => {
    setup([
      flag({ id: 1 }),
      flag({ id: 2, frame_index: 10 }),
      flag({ id: 3, frame_index: 15, committed_at: "2026-10-07T10:00:00Z", sequence_id: 4 }),
    ]);
    expect(screen.getByText("2 pending · 1 sent")).toBeInTheDocument();
  });

  it("lists pending flags with time and kind, and seeks when the time is clicked", async () => {
    const user = userEvent.setup();
    const props = setup([flag({ id: 1, kind: "fn", timestamp_ms: 202000 })]);
    const item = screen.getByRole("listitem");
    expect(within(item).getByText("FN")).toBeInTheDocument();
    await user.click(within(item).getByRole("button", { name: "3:22" }));
    expect(props.onSeek).toHaveBeenCalledWith(202000);
  });

  it("removes a flag", async () => {
    const user = userEvent.setup();
    const props = setup([flag({ id: 9 })]);
    await user.click(screen.getByRole("button", { name: "Remove flag at 3:22" }));
    expect(props.onRemove).toHaveBeenCalledWith(9);
  });

  it("saves a changed note when the field loses focus, and only then", async () => {
    const user = userEvent.setup();
    const original = flag({ id: 2, note: null });
    const props = setup([original]);
    const field = screen.getByLabelText("Note for flag at 3:22");
    await user.click(field);
    await user.tab();
    expect(props.onNoteChange).not.toHaveBeenCalled(); // unchanged
    await user.click(field);
    await user.type(field, "phantom fold");
    await user.tab();
    expect(props.onNoteChange).toHaveBeenCalledWith(original, "phantom fold");
  });

  it("keeps Send disabled with nothing pending and counts the frames otherwise", async () => {
    const { unmount } = render(
      <MemoryRouter>
        <FlagsPanel
          flags={[]}
          loadFailed={false}
          onRetry={vi.fn()}
          onSeek={vi.fn()}
          onRemove={vi.fn()}
          onNoteChange={vi.fn()}
          onSend={vi.fn()}
          lastSequence={null}
        />
      </MemoryRouter>,
    );
    expect(screen.getByRole("button", { name: /send/i })).toBeDisabled();
    unmount();

    const user = userEvent.setup();
    const props = setup([flag({ id: 1 }), flag({ id: 2, frame_index: 10 })]);
    const send = screen.getByRole("button", { name: "Send 2 frames to training" });
    await user.click(send);
    expect(props.onSend).toHaveBeenCalled();
  });

  it("says 'frame' for exactly one", () => {
    setup([flag({ id: 1 })]);
    expect(screen.getByRole("button", { name: "Send 1 frame to training" })).toBeInTheDocument();
  });

  it("links the sequences the sent frames went into", () => {
    setup([
      flag({ id: 1, committed_at: "2026-10-07T10:00:00Z", sequence_id: 12 }),
      flag({ id: 2, frame_index: 10, committed_at: "2026-10-07T10:00:00Z", sequence_id: 12 }),
      flag({ id: 3, frame_index: 15, committed_at: "2026-10-07T11:00:00Z", sequence_id: 13 }),
    ]);
    expect(screen.getByRole("link", { name: "#12" })).toHaveAttribute("href", "/sequences/12");
    expect(screen.getByRole("link", { name: "#13" })).toHaveAttribute("href", "/sequences/13");
    expect(screen.getAllByRole("link", { name: "#12" })).toHaveLength(1);
  });

  it("shows the sequence that was just created", () => {
    setup([], { lastSequence: { id: 5, name: "QC · A · run #7" } });
    expect(screen.getByText(/Created sequence/)).toHaveTextContent("QC · A · run #7");
    expect(screen.getByRole("link", { name: "Open in editor" })).toHaveAttribute("href", "/sequences/5");
  });

  it("shows a retry when the flags could not be loaded", async () => {
    const user = userEvent.setup();
    const props = setup([], { loadFailed: true });
    expect(screen.getByText(/could not load the flags/i)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Retry" }));
    expect(props.onRetry).toHaveBeenCalled();
  });
});
