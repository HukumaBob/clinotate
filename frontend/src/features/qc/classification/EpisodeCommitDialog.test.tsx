import { act, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { CommitEpisodesRead } from "../../../entities/useCommitEpisodes";
import { EpisodeCommitDialog } from "./EpisodeCommitDialog";

type Opts = { onSuccess?: (d: CommitEpisodesRead) => void; onError?: (e: unknown) => void };
const mutate = vi.fn<(vars: Record<string, unknown>, opts?: Opts) => void>();
let sent: { frames: number } | undefined;

vi.mock("../../../entities/useCommitEpisodes", () => ({
  useCommitEpisodes: () => ({ mutate, isPending: false }),
}));
vi.mock("../../../entities/useQcFlags", () => ({
  useVideoSent: () => ({ data: sent }),
}));

const preview = (over: Partial<CommitEpisodesRead> = {}): CommitEpisodesRead => ({
  dry_run: true, episodes: 2, frames: 14, dropped_unlabeled: 3,
  annotations_by_axis: { Finding: 9, Location: 5 }, sequence_id: null, sequence_name: null, ...over,
});
const calls = (dry: boolean) => mutate.mock.calls.filter(([v]) => v.dryRun === dry);

function renderDialog(props: Partial<Parameters<typeof EpisodeCommitDialog>[0]> = {}) {
  const onClose = vi.fn();
  const onCommitted = vi.fn();
  render(
    <MemoryRouter>
      <EpisodeCommitDialog
        runId={7} videoId={9} keys={["Finding|1000", "Finding|5000"]} referenceStatus="none"
        onClose={onClose} onCommitted={onCommitted} {...props}
      />
    </MemoryRouter>,
  );
  return { onClose, onCommitted };
}
const settle = () => act(() => { vi.advanceTimersByTime(450); });
const answer = (data: CommitEpisodesRead, idx = -1) =>
  act(() => { const c = calls(true); c.at(idx)![1]!.onSuccess!(data); });
const send = () => screen.getByRole("button", { name: "Send" });

beforeEach(() => {
  vi.useFakeTimers();
  mutate.mockReset();
  sent = undefined;
});
afterEach(() => vi.useRealTimers());

describe("EpisodeCommitDialog", () => {
  it("requests a dry run after the debounce with seconds converted to ms", () => {
    renderDialog();
    expect(calls(true)).toHaveLength(0);
    expect(screen.getByText("Counting frames…")).toBeInTheDocument();
    settle();
    expect(calls(true)).toHaveLength(1);
    expect(calls(true)[0][0]).toEqual({
      episodes: [{ axis: "Finding", start_ms: 1000 }, { axis: "Finding", start_ms: 5000 }],
      stepMs: 1000, marginMs: 1000, name: null, dryRun: true,
    });
  });

  it("refreshes the preview when step or margin change, debounced", () => {
    renderDialog();
    settle();
    fireEvent.change(screen.getByLabelText("Step (s)"), { target: { value: "0.5" } });
    fireEvent.change(screen.getByLabelText("Margin (s)"), { target: { value: "2" } });
    settle();
    expect(calls(true)).toHaveLength(2);
    expect(calls(true)[1][0]).toMatchObject({ stepMs: 500, marginMs: 2000 });
  });

  it("renders the preview numbers and labels per axis", () => {
    renderDialog();
    settle();
    answer(preview());
    expect(screen.getByText(/2 episodes/)).toBeInTheDocument();
    expect(screen.getByText(/14 frames/)).toBeInTheDocument();
    expect(screen.getByText(/3 frames dropped as unlabeled/)).toBeInTheDocument();
    expect(screen.getByText(/Finding: 9/)).toBeInTheDocument();
    expect(screen.getByText(/Location: 5/)).toBeInTheDocument();
    expect(send()).toBeEnabled();
  });

  it("ignores a stale response", () => {
    renderDialog();
    settle();
    fireEvent.change(screen.getByLabelText("Step (s)"), { target: { value: "2" } });
    settle();
    answer(preview({ frames: 99 }), 1);
    answer(preview({ frames: 11 }), 0);
    expect(screen.getByText(/99 frames/)).toBeInTheDocument();
    expect(screen.queryByText(/11 frames/)).not.toBeInTheDocument();
  });

  it("disables Send while loading, on zero frames and on error", () => {
    renderDialog();
    expect(send()).toBeDisabled();
    settle();
    expect(send()).toBeDisabled();
    answer(preview({ frames: 0, episodes: 0 }));
    expect(screen.getByText("No frames to send")).toBeInTheDocument();
    expect(send()).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Step (s)"), { target: { value: "3" } });
    settle();
    act(() => { calls(true).at(-1)![1]!.onError!({ detail: "Run not found" }); });
    expect(screen.getByRole("alert")).toHaveTextContent("Run not found");
    expect(send()).toBeDisabled();
  });

  it("disables Send and shows a hint for invalid fields", () => {
    renderDialog();
    settle();
    answer(preview());
    fireEvent.change(screen.getByLabelText("Step (s)"), { target: { value: "0" } });
    expect(send()).toBeDisabled();
    expect(screen.getByText(/Step must be between 0\.1 and 60/)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Step (s)"), { target: { value: "1" } });
    fireEvent.change(screen.getByLabelText("Margin (s)"), { target: { value: "61" } });
    expect(screen.getByText(/Margin must be between 0 and 60/)).toBeInTheDocument();
    settle();
    expect(calls(true)).toHaveLength(1);
  });

  it("shows the reference notes and the already-sent note", () => {
    sent = { frames: 12 };
    renderDialog({ referenceStatus: "clean" });
    expect(screen.getByText(/will stop being an independent test/)).toBeInTheDocument();
    expect(screen.getByText("12 frames of this video were already sent to training.")).toBeInTheDocument();
  });

  it("shows the compromised note", () => {
    renderDialog({ referenceStatus: "compromised" });
    expect(screen.getByText(/reference is already compromised/)).toBeInTheDocument();
  });

  it("sends the real commit with the name and shows the result", () => {
    const { onCommitted } = renderDialog();
    settle();
    answer(preview());
    fireEvent.change(screen.getByLabelText("Sequence name"), { target: { value: "  My errors " } });
    fireEvent.click(send());
    const real = calls(false);
    expect(real).toHaveLength(1);
    expect(real[0][0]).toMatchObject({ name: "My errors", dryRun: false, stepMs: 1000, marginMs: 1000 });
    act(() => real[0][1]!.onSuccess!(preview({ dry_run: false, sequence_id: 42, sequence_name: "My errors" })));
    expect(screen.getByText("Created sequence My errors (14 frames)")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Open sequence" })).toHaveAttribute("href", "/sequences/42");
    expect(screen.getByRole("button", { name: "Close" })).toBeInTheDocument();
    expect(onCommitted).toHaveBeenCalledTimes(1);
  });

  it("keeps the dialog open when the real commit fails", () => {
    const { onClose, onCommitted } = renderDialog();
    settle();
    answer(preview());
    fireEvent.click(send());
    act(() => calls(false)[0][1]!.onError!({ detail: "Boom" }));
    expect(screen.getByRole("alert")).toHaveTextContent("Boom");
    expect(onClose).not.toHaveBeenCalled();
    expect(onCommitted).not.toHaveBeenCalled();
  });

  it("cancels on the button and on Escape", () => {
    const { onClose } = renderDialog();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(2);
  });
});
