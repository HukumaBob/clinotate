import { act, render, screen, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";

import { apiClient } from "../../shared/api/client";
import { createFrameEditorStore } from "./frameEditorStore";
import { TrackControls } from "./TrackControls";

vi.mock("../../shared/api/client", () => ({
  apiClient: { GET: vi.fn(), POST: vi.fn(), PATCH: vi.fn(), DELETE: vi.fn() },
}));

function renderControls(overrides: Partial<{ maxBackward: number; maxForward: number }> = {}) {
  vi.mocked(apiClient.GET).mockResolvedValue({
    data: { max_track_range_frames: 20 },
    error: undefined,
  } as never);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const store = createFrameEditorStore();
  const onTrack = vi.fn();
  render(
    <QueryClientProvider client={queryClient}>
      <TrackControls
        store={store}
        onTrack={onTrack}
        maxBackward={overrides.maxBackward ?? 50}
        maxForward={overrides.maxForward ?? 50}
      />
    </QueryClientProvider>,
  );
  return { store };
}

describe("TrackControls combined-range cap", () => {
  it("clamps 'Max backward' to leave room under the 20-frame combined cap", async () => {
    const { store } = renderControls();
    await screen.findByText(/combined backward \+ forward is capped at 20/i);
    act(() => {
      store.getState().setForward(15);
    });

    fireEvent.click(screen.getByLabelText("Max backward"));

    // 20 - forward(15) = 5, even though maxBackward (sequence-relative) is 50.
    expect(store.getState().backward).toBe(5);
  });

  it("clamps 'Max forward' to leave room under the 20-frame combined cap", async () => {
    const { store } = renderControls();
    await screen.findByText(/combined backward \+ forward is capped at 20/i);
    act(() => {
      store.getState().setBackward(18);
    });

    fireEvent.click(screen.getByLabelText("Max forward"));

    expect(store.getState().forward).toBe(2);
  });

  it("clamps manual backward input so backward + forward never exceeds 20", async () => {
    const { store } = renderControls();
    await screen.findByText(/combined backward \+ forward is capped at 20/i);
    act(() => {
      store.getState().setForward(12);
    });

    const backwardInput = screen.getByLabelText(/backward/i, { selector: "input" });
    fireEvent.change(backwardInput, { target: { value: "30" } });

    expect(store.getState().backward).toBe(8);
  });

  it("clamps manual forward input so backward + forward never exceeds 20", async () => {
    const { store } = renderControls();
    await screen.findByText(/combined backward \+ forward is capped at 20/i);
    act(() => {
      store.getState().setBackward(19);
    });

    const forwardInput = screen.getByLabelText(/forward/i, { selector: "input" });
    fireEvent.change(forwardInput, { target: { value: "30" } });

    expect(store.getState().forward).toBe(1);
  });
});
