import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { CommitEpisodesRead } from "../../../entities/useCommitEpisodes";
import { apiClient } from "../../../shared/api/client";
import { EpisodeCommitDialog } from "./EpisodeCommitDialog";

vi.mock("../../../shared/api/client", () => ({ apiClient: { POST: vi.fn() } }));
let sent: { frames: number } | undefined;
vi.mock("../../../entities/useQcFlags", () => ({
  useVideoSent: () => ({ data: sent }),
}));

type Pending = { body: Record<string, unknown>; resolve: (r: unknown) => void };
let pending: Pending[] = [];

const preview = (over: Partial<CommitEpisodesRead> = {}): CommitEpisodesRead => ({
  dry_run: true, episodes: 2, frames: 14, dropped_unlabeled: 3,
  annotations_by_axis: { Finding: 9, Location: 5 }, sequence_id: null, sequence_name: null, ...over,
});
const dry = () => pending.filter((p) => p.body.dry_run === true);
const real = () => pending.filter((p) => p.body.dry_run === false);

function renderDialog(props: Partial<Parameters<typeof EpisodeCommitDialog>[0]> = {}) {
  const onClose = vi.fn();
  const onCommitted = vi.fn();
  const queryClient = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  const ui = (p: Partial<Parameters<typeof EpisodeCommitDialog>[0]>) => (
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <EpisodeCommitDialog
          runId={7} videoId={9} keys={["Finding|1000", "Finding|5000"]} referenceStatus="none"
          onClose={onClose} onCommitted={onCommitted} {...props} {...p}
        />
      </MemoryRouter>
    </QueryClientProvider>
  );
  const view = render(ui(props));
  return { onClose, onCommitted, unmount: view.unmount };
}
const tick = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });
const settle = () => tick(450);
const answer = async (p: Pending, data: unknown) => { p.resolve({ data }); await tick(5); };
const fail = async (p: Pending, error: unknown) => { p.resolve({ error }); await tick(5); };
const send = () => screen.getByRole("button", { name: "Send" });

beforeEach(() => {
  vi.useFakeTimers();
  pending = [];
  sent = undefined;
  vi.mocked(apiClient.POST).mockReset();
  vi.mocked(apiClient.POST).mockImplementation(((_path: string, init: { body: Record<string, unknown> }) =>
    new Promise((resolve) => pending.push({ body: init.body, resolve }))) as never);
});
afterEach(() => vi.useRealTimers());

describe("EpisodeCommitDialog", () => {
  it("requests a dry run after the debounce with seconds converted to ms", async () => {
    renderDialog();
    expect(dry()).toHaveLength(0);
    expect(screen.getByText("Counting frames…")).toBeInTheDocument();
    await settle();
    expect(dry()).toHaveLength(1);
    expect(dry()[0].body).toEqual({
      episodes: [{ axis: "Finding", start_ms: 1000 }, { axis: "Finding", start_ms: 5000 }],
      step_ms: 1000, margin_ms: 1000, name: null, dry_run: true,
    });
  });

  it("refreshes the preview when step or margin change, debounced", async () => {
    renderDialog();
    await settle();
    fireEvent.change(screen.getByLabelText("Step (s)"), { target: { value: "0.5" } });
    fireEvent.change(screen.getByLabelText("Margin (s)"), { target: { value: "2" } });
    await settle();
    expect(dry()).toHaveLength(2);
    expect(dry()[1].body).toMatchObject({ step_ms: 500, margin_ms: 2000 });
  });

  it("renders the preview numbers and labels per axis", async () => {
    renderDialog();
    await settle();
    await answer(dry()[0], preview());
    expect(screen.getByText(/2 episodes/)).toBeInTheDocument();
    expect(screen.getByText(/14 frames/)).toBeInTheDocument();
    expect(screen.getByText(/3 frames dropped as unlabeled/)).toBeInTheDocument();
    expect(screen.getByText(/Finding: 9/)).toBeInTheDocument();
    expect(screen.getByText(/Location: 5/)).toBeInTheDocument();
    expect(send()).toBeEnabled();
  });

  it("ignores a stale response", async () => {
    renderDialog();
    await settle();
    fireEvent.change(screen.getByLabelText("Step (s)"), { target: { value: "2" } });
    await settle();
    await answer(dry()[1], preview({ frames: 99 }));
    await answer(dry()[0], preview({ frames: 11 }));
    expect(screen.getByText(/99 frames/)).toBeInTheDocument();
    expect(screen.queryByText(/11 frames/)).not.toBeInTheDocument();
  });

  it("disables Send while loading, on zero frames and on error", async () => {
    renderDialog();
    expect(send()).toBeDisabled();
    await settle();
    expect(send()).toBeDisabled();
    await answer(dry()[0], preview({ frames: 0, episodes: 0 }));
    expect(screen.getByText("No frames to send")).toBeInTheDocument();
    expect(send()).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Step (s)"), { target: { value: "3" } });
    await settle();
    await fail(dry()[1], { detail: "Run not found" });
    expect(screen.getByRole("alert")).toHaveTextContent("Run not found");
    expect(send()).toBeDisabled();
  });

  it("joins the messages of an array detail", async () => {
    renderDialog();
    await settle();
    await fail(dry()[0], { detail: [{ msg: "bad one" }, { msg: "bad two" }] });
    expect(screen.getByRole("alert")).toHaveTextContent("bad one; bad two");
  });

  it("disables Send and shows a hint for invalid fields", async () => {
    renderDialog();
    await settle();
    await answer(dry()[0], preview());
    fireEvent.change(screen.getByLabelText("Step (s)"), { target: { value: "0" } });
    expect(send()).toBeDisabled();
    expect(screen.getByText(/Step must be between 0\.1 and 60/)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Step (s)"), { target: { value: "1" } });
    fireEvent.change(screen.getByLabelText("Margin (s)"), { target: { value: "61" } });
    expect(screen.getByText(/Margin must be between 0 and 60/)).toBeInTheDocument();
    await settle();
    expect(dry()).toHaveLength(1);
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

  it("uses a plain placeholder for the server-generated name", () => {
    renderDialog();
    expect(screen.getByPlaceholderText("Default name (server-generated)")).toBeInTheDocument();
  });

  it("sends the real commit with the name and shows the result", async () => {
    const { onCommitted } = renderDialog();
    await settle();
    await answer(dry()[0], preview());
    fireEvent.change(screen.getByLabelText("Sequence name"), { target: { value: "  My errors " } });
    fireEvent.click(send());
    await tick(5);
    expect(real()).toHaveLength(1);
    expect(real()[0].body).toMatchObject({ name: "My errors", dry_run: false, step_ms: 1000, margin_ms: 1000 });
    await answer(real()[0], preview({ dry_run: false, sequence_id: 42, sequence_name: "My errors" }));
    expect(screen.getByText("Created sequence My errors (14 frames)")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Open sequence" })).toHaveAttribute("href", "/sequences/42");
    expect(screen.getByRole("button", { name: "Close" })).toBeInTheDocument();
    expect(onCommitted).toHaveBeenCalledTimes(1);
    await settle();
    expect(dry()).toHaveLength(1);
  });

  it("keeps the dialog open when the real commit fails", async () => {
    const { onClose, onCommitted } = renderDialog();
    await settle();
    await answer(dry()[0], preview());
    fireEvent.click(send());
    await tick(5);
    await fail(real()[0], { detail: [{ msg: "Boom" }] });
    expect(screen.getByRole("alert")).toHaveTextContent("Boom");
    expect(onClose).not.toHaveBeenCalled();
    expect(onCommitted).not.toHaveBeenCalled();
    expect(send()).toBeEnabled();
  });

  it("locks the inputs and fires no preview while a commit is pending", async () => {
    renderDialog();
    await settle();
    await answer(dry()[0], preview());
    fireEvent.click(send());
    await tick(5);
    expect(screen.getByLabelText("Step (s)")).toBeDisabled();
    expect(screen.getByLabelText("Margin (s)")).toBeDisabled();
    expect(screen.getByLabelText("Sequence name")).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Step (s)"), { target: { value: "2" } });
    await settle();
    expect(dry()).toHaveLength(1);
  });

  it("a pending preview and a pending commit coexist", async () => {
    const { onCommitted } = renderDialog();
    await settle();
    await answer(dry()[0], preview());
    fireEvent.change(screen.getByLabelText("Step (s)"), { target: { value: "2" } });
    await settle(); // second preview in flight, never answered
    expect(dry()).toHaveLength(2);
    await answer(dry()[1], preview());
    fireEvent.click(send());
    await tick(5);
    await answer(real()[0], preview({ dry_run: false, sequence_id: 3, sequence_name: "S" }));
    expect(screen.getByText("Created sequence S (14 frames)")).toBeInTheDocument();
    expect(onCommitted).toHaveBeenCalledTimes(1);
  });

  it("still calls onCommitted once when the dialog unmounts while committing", async () => {
    const { onCommitted, unmount } = renderDialog();
    await settle();
    await answer(dry()[0], preview());
    fireEvent.click(send());
    await tick(5);
    unmount();
    await answer(real()[0], preview({ dry_run: false, sequence_id: 3, sequence_name: "S" }));
    expect(onCommitted).toHaveBeenCalledTimes(1);
  });

  it("cancels on the button and on Escape", () => {
    const { onClose } = renderDialog();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(2);
  });
});
