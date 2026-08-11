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

  it("shrinks forward to make room when a manual backward edit pushes the total over 20", async () => {
    const { store } = renderControls();
    await screen.findByText(/combined backward \+ forward is capped at 20/i);
    act(() => {
      store.getState().setForward(12);
    });

    const backwardInput = screen.getByLabelText(/backward/i, { selector: "input" });
    fireEvent.change(backwardInput, { target: { value: "30" } });

    // forward(12) gives up all it has (12), leaving backward at 30 - 10 = 20
    // once the remaining overage is trimmed off backward itself.
    expect(store.getState().backward).toBe(20);
    expect(store.getState().forward).toBe(0);
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

  it("clamps manual backward input to the frames actually available behind the current frame", async () => {
    const { store } = renderControls({ maxBackward: 4 });
    await screen.findByText(/combined backward \+ forward is capped at 20/i);

    const backwardInput = screen.getByLabelText(/backward/i, { selector: "input" });
    fireEvent.change(backwardInput, { target: { value: "30" } });

    // Even though the combined cap (20) would allow more, only 4 frames
    // exist behind the current frame in this sequence.
    expect(store.getState().backward).toBe(4);
  });

  it("clamps manual forward input to the frames actually available ahead of the current frame", async () => {
    const { store } = renderControls({ maxForward: 3 });
    await screen.findByText(/combined backward \+ forward is capped at 20/i);

    const forwardInput = screen.getByLabelText(/forward/i, { selector: "input" });
    fireEvent.change(forwardInput, { target: { value: "30" } });

    expect(store.getState().forward).toBe(3);
  });
});
