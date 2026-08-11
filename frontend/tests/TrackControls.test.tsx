import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import userEvent from "@testing-library/user-event";

import { apiClient } from "../src/shared/api/client";
import { createFrameEditorStore } from "../src/features/annotation/frameEditorStore";
import { TrackControls } from "../src/features/annotation/TrackControls";

function renderTrackControls(props: Parameters<typeof TrackControls>[0]) {
  vi.spyOn(apiClient, "GET").mockResolvedValue({
    data: { max_track_range_frames: 20 },
    error: undefined,
  } as never);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <TrackControls {...props} />
    </QueryClientProvider>,
  );
}

describe("TrackControls", () => {
  it("disables the Track button when there are no pending prompts", async () => {
    const store = createFrameEditorStore();
    store.getState().setLabelSelection({ labelTagId: 1 });

    renderTrackControls({ store, onTrack: vi.fn(), maxBackward: 10, maxForward: 20 });
    await screen.findByText(/combined backward \+ forward is capped at 20/i);

    expect(screen.getByRole("button", { name: "Track" })).toBeDisabled();
  });

  it("enables the Track button once a point prompt is pending", async () => {
    const store = createFrameEditorStore();
    store.getState().setLabelSelection({ labelTagId: 1 });
    store.getState().addPrompt({ type: "point", coords: [0.5, 0.5], label: true });

    renderTrackControls({ store, onTrack: vi.fn(), maxBackward: 10, maxForward: 20 });
    await screen.findByText(/combined backward \+ forward is capped at 20/i);

    expect(screen.getByRole("button", { name: "Track" })).toBeEnabled();
  });

  it("enables the Track button once a mask prompt is pending", async () => {
    const store = createFrameEditorStore();
    store.getState().setLabelSelection({ labelTagId: 1 });
    store.getState().setMaskPrompt("base64data");

    renderTrackControls({ store, onTrack: vi.fn(), maxBackward: 10, maxForward: 20 });
    await screen.findByText(/combined backward \+ forward is capped at 20/i);

    expect(screen.getByRole("button", { name: "Track" })).toBeEnabled();
  });

  it("disables the Track button when no tag is selected even with pending prompts", async () => {
    const store = createFrameEditorStore();
    store.getState().addPrompt({ type: "point", coords: [0.5, 0.5], label: true });

    renderTrackControls({ store, onTrack: vi.fn(), maxBackward: 10, maxForward: 20 });
    await screen.findByText(/combined backward \+ forward is capped at 20/i);

    expect(screen.getByRole("button", { name: "Track" })).toBeDisabled();
  });

  it("clicking Max next to Backward sets backward to maxBackward", async () => {
    const store = createFrameEditorStore();
    renderTrackControls({ store, onTrack: vi.fn(), maxBackward: 7, maxForward: 20 });
    await screen.findByText(/combined backward \+ forward is capped at 20/i);

    await userEvent.click(screen.getByRole("button", { name: "Max backward" }));

    expect(store.getState().backward).toBe(7);
  });

  it("clicking Max next to Forward sets forward to maxForward", async () => {
    const store = createFrameEditorStore();
    renderTrackControls({ store, onTrack: vi.fn(), maxBackward: 10, maxForward: 13 });
    await screen.findByText(/combined backward \+ forward is capped at 20/i);

    await userEvent.click(screen.getByRole("button", { name: "Max forward" }));

    expect(store.getState().forward).toBe(13);
  });
});
