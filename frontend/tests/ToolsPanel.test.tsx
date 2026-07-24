import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";

import { apiClient } from "../src/shared/api/client";
import { createFrameEditorStore } from "../src/features/annotation/frameEditorStore";
import { ToolsPanel } from "../src/features/annotation/ToolsPanel";

function renderPanel(onAddMask = vi.fn(), onTrack = vi.fn(), store = createFrameEditorStore()) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  vi.spyOn(apiClient, "GET").mockResolvedValue({ data: [], error: undefined, response: new Response() } as never);
  render(
    <QueryClientProvider client={queryClient}>
      <ToolsPanel store={store} annotations={[]} onAddMask={onAddMask} onTrack={onTrack} />
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

  it("shows Point/Box/Mask row with Mask selectable", async () => {
    const store = renderPanel();

    await userEvent.click(screen.getByRole("button", { name: "Mask" }));

    expect(store.getState().activeTool).toBe("mask");
  });

  it("calls onAddMask when Add mask is clicked", async () => {
    const onAddMask = vi.fn();
    renderPanel(onAddMask);

    await userEvent.click(screen.getByRole("button", { name: "Add mask" }));

    expect(onAddMask).toHaveBeenCalled();
  });
});
