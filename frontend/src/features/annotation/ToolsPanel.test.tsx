import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";

import { apiClient } from "../../shared/api/client";
import { createFrameEditorStore } from "./frameEditorStore";
import { ToolsPanel } from "./ToolsPanel";

vi.mock("../../shared/api/client", () => ({
  apiClient: { GET: vi.fn(), POST: vi.fn(), PATCH: vi.fn(), DELETE: vi.fn() },
}));

function renderPanel() {
  vi.mocked(apiClient.GET).mockResolvedValue({
    data: { max_track_range_frames: 20, mask_postprocess_strength: 0.4 },
    error: undefined,
  } as never);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const store = createFrameEditorStore();
  render(
    <QueryClientProvider client={queryClient}>
      <ToolsPanel
        store={store}
        annotations={[]}
        frameId={1}
        onTrack={vi.fn()}
        procedureId={null}
        vramUsedBytes={null}
        vramTotalBytes={null}
        vramIsLive={false}
        maxBackward={10}
        maxForward={10}
      />
    </QueryClientProvider>,
  );
  return { store };
}

describe("ToolsPanel mask smoothing", () => {
  it("seeds the smoothing slider from GET /settings on first load", async () => {
    const { store } = renderPanel();
    await waitFor(() => expect(store.getState().maskSmoothingStrength).toBe(0.4));
  });

  it("updates the store when the user drags the slider, without calling PATCH /settings", async () => {
    const { store } = renderPanel();
    await waitFor(() => expect(store.getState().maskSmoothingStrength).toBe(0.4));

    const slider = screen.getByLabelText(/mask smoothing/i);
    fireEvent.change(slider, { target: { value: "0.8" } });

    expect(store.getState().maskSmoothingStrength).toBe(0.8);
    expect(apiClient.PATCH).not.toHaveBeenCalled();
  });
});
