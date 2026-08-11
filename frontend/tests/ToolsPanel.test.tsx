import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";

import { apiClient } from "../src/shared/api/client";
import { createFrameEditorStore } from "../src/features/annotation/frameEditorStore";
import { ToolsPanel } from "../src/features/annotation/ToolsPanel";

function renderPanel(
  onTrack = vi.fn(),
  store = createFrameEditorStore(),
  vram: { vramUsedBytes: number | null; vramTotalBytes: number | null; isLive: boolean } = {
    vramUsedBytes: null,
    vramTotalBytes: null,
    isLive: false,
  },
) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  vi.spyOn(apiClient, "GET").mockImplementation((async (path: string) => {
    if (path === "/settings") {
      return {
        data: { max_track_range_frames: 20, mask_postprocess_strength: 0.3 },
        error: undefined,
        response: new Response(),
      };
    }
    return { data: [], error: undefined, response: new Response() };
  }) as never);
  render(
    <QueryClientProvider client={queryClient}>
      <ToolsPanel
        store={store}
        annotations={[]}
        frameId={1}
        onTrack={onTrack}
        procedureId={null}
        vramUsedBytes={vram.vramUsedBytes}
        vramTotalBytes={vram.vramTotalBytes}
        vramIsLive={vram.isLive}
        maxBackward={10}
        maxForward={20}
      />
    </QueryClientProvider>,
  );
  return store;
}

describe("ToolsPanel", () => {
  it("defaults to the SAM 2.1 tab active and SAM-3 tab disabled", () => {
    renderPanel();

    expect(screen.getByRole("tab", { name: "SAM 2.1" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tab", { name: "SAM-3" })).toBeDisabled();
  });

  it("shows Point/Box/Mask row with Mask selectable once a tag is chosen", async () => {
    const store = renderPanel();
    store.getState().setLabelSelection({ labelTagId: 1 });

    await userEvent.click(screen.getByRole("button", { name: "Mask" }));

    expect(store.getState().activeTool).toBe("mask");
  });

  it("disables the tool buttons until a tag is selected", () => {
    renderPanel();

    expect(screen.getByRole("button", { name: "Point / Box" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Mask" })).toBeDisabled();
  });

  it("does not render a generic 'Add mask' submit button when Point is the active tool", () => {
    renderPanel();

    expect(screen.queryByRole("button", { name: "Add mask" })).not.toBeInTheDocument();
  });

  it("does not render a 'Generate from mask' button -- tracing and closing an outline predicts immediately", async () => {
    const store = renderPanel();
    store.getState().setLabelSelection({ labelTagId: 1 });

    await userEvent.click(screen.getByRole("button", { name: "Mask" }));
    expect(screen.queryByRole("button", { name: "Generate from mask" })).not.toBeInTheDocument();
  });

  it("passes frameId through to MasksList", async () => {
    renderPanel();
    // MasksList renders an empty list with no annotations passed in this
    // test; this test only needs to confirm ToolsPanel doesn't crash
    // rendering MasksList with a real frameId, which a missing/undefined
    // prop would surface as a runtime TypeError inside MasksList's delete
    // hooks (useDeleteAnnotation(frameId) etc.) -- absence of a thrown
    // error during render is the assertion here.
    await waitFor(() => expect(screen.getByRole("tab", { name: "SAM 2.1" })).toBeInTheDocument());
  });

  it("renders the VRAM gauge section", () => {
    renderPanel();

    expect(screen.getByTestId("vram-gauge")).toBeInTheDocument();
  });

  it("passes job VRAM data through to the gauge", () => {
    renderPanel(vi.fn(), createFrameEditorStore(), {
      vramUsedBytes: 4 * 1024 ** 3,
      vramTotalBytes: 8 * 1024 ** 3,
      isLive: true,
    });

    expect(screen.getByText("4.0 / 8.0 GiB")).toBeInTheDocument();
  });

  it("flashes the Label section when labelPickerPulseAt changes", async () => {
    const store = renderPanel();

    expect(screen.getByTestId("label-picker-section")).not.toHaveClass("animate-label-pulse");

    act(() => {
      store.getState().triggerLabelPickerPulse();
    });

    expect(screen.getByTestId("label-picker-section")).toHaveClass("animate-label-pulse");
  });

  it("passes maxBackward/maxForward through to the Track section's Max buttons", async () => {
    const store = renderPanel();
    await screen.findByText(/combined backward \+ forward is capped at 20/i);

    await userEvent.click(screen.getByRole("button", { name: "Max backward" }));
    expect(store.getState().backward).toBe(10);

    // maxForward is 20, but the combined 20-frame cap leaves only
    // 20 - backward(10) = 10 frames of budget for forward.
    await userEvent.click(screen.getByRole("button", { name: "Max forward" }));
    expect(store.getState().forward).toBe(10);
  });
});
