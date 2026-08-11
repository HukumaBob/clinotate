import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";

import { apiClient } from "../../shared/api/client";
import { MaskSmoothingControl } from "./MaskSmoothingControl";

vi.mock("../../shared/api/client", () => ({
  apiClient: { GET: vi.fn(), POST: vi.fn(), PATCH: vi.fn(), DELETE: vi.fn() },
}));

function renderControl(initialStrength: number | null = 0.3) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <MaskSmoothingControl annotationId={7} initialStrength={initialStrength} frameId={1} />
    </QueryClientProvider>,
  );
}

describe("MaskSmoothingControl", () => {
  it("pre-fills from initialStrength", () => {
    renderControl(0.6);
    expect(screen.getByLabelText(/smoothing/i)).toHaveValue("0.6");
  });

  it("falls back to 0 when initialStrength is null", () => {
    renderControl(null);
    expect(screen.getByLabelText(/smoothing/i)).toHaveValue("0");
  });

  it("PATCHes the new strength after the user stops dragging (debounced)", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.mocked(apiClient.PATCH).mockResolvedValue({
      data: { id: 7, mask_postprocess_strength: 0.9 },
      error: undefined,
    } as never);

    renderControl(0.3);
    const slider = screen.getByLabelText(/smoothing/i);
    fireEvent.change(slider, { target: { value: "0.9" } });

    expect(apiClient.PATCH).not.toHaveBeenCalled();

    vi.advanceTimersByTime(300);

    await waitFor(() =>
      expect(apiClient.PATCH).toHaveBeenCalledWith(
        "/annotation/annotations/{annotation_id}/mask-postprocess",
        { params: { path: { annotation_id: 7 } }, body: { strength: 0.9 } },
      ),
    );
    vi.useRealTimers();
  });
});
