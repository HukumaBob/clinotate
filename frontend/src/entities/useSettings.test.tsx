import { afterEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";

import { apiClient } from "../shared/api/client";
import { useSettings, useUpdateSettings } from "./useSettings";

vi.mock("../shared/api/client", () => ({
  apiClient: { GET: vi.fn(), POST: vi.fn(), PATCH: vi.fn(), DELETE: vi.fn() },
}));

function wrapper({ children }: { children: ReactNode }) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}

describe("useSettings", () => {
  afterEach(() => vi.clearAllMocks());

  it("fetches the current max_track_range_frames value", async () => {
    vi.mocked(apiClient.GET).mockResolvedValue({
      data: { max_track_range_frames: 10 },
      error: undefined,
    } as never);

    const { result } = renderHook(() => useSettings(), { wrapper });

    await waitFor(() => expect(result.current.data).toEqual({ max_track_range_frames: 10 }));
    expect(apiClient.GET).toHaveBeenCalledWith("/settings", {});
  });
});

describe("useUpdateSettings", () => {
  afterEach(() => vi.clearAllMocks());

  it("PATCHes the new value and invalidates the settings query", async () => {
    vi.mocked(apiClient.PATCH).mockResolvedValue({
      data: { max_track_range_frames: 8 },
      error: undefined,
    } as never);

    const { result } = renderHook(() => useUpdateSettings(), { wrapper });
    result.current.mutate({ maxTrackRangeFrames: 8, maskPostprocessStrength: 0.3 });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(apiClient.PATCH).toHaveBeenCalledWith("/settings", {
      body: { max_track_range_frames: 8, mask_postprocess_strength: 0.3 },
    });
  });

  it("PATCHes both settings fields and invalidates the settings query", async () => {
    vi.mocked(apiClient.PATCH).mockResolvedValue({
      data: { max_track_range_frames: 8, mask_postprocess_strength: 0.6 },
      error: undefined,
    } as never);

    const { result } = renderHook(() => useUpdateSettings(), { wrapper });
    result.current.mutate({ maxTrackRangeFrames: 8, maskPostprocessStrength: 0.6 });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(apiClient.PATCH).toHaveBeenCalledWith("/settings", {
      body: { max_track_range_frames: 8, mask_postprocess_strength: 0.6 },
    });
  });
});
