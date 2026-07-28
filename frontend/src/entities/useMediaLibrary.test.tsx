import { afterEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor, act } from "@testing-library/react";
import type { ReactNode } from "react";

import { apiClient } from "../shared/api/client";
import { useDeleteVideo, useMediaLibrary } from "./useMediaLibrary";

vi.mock("../shared/api/client", () => ({
  apiClient: { GET: vi.fn(), DELETE: vi.fn() },
}));

function wrapper({ children }: { children: ReactNode }) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}

describe("useMediaLibrary", () => {
  afterEach(() => vi.clearAllMocks());

  it("fetches the media library list", async () => {
    const items = [{ id: 1, kind: "video", filename: "a.mp4", procedure_id: null, uploaded_at: "2026-07-28T00:00:00Z", size_bytes: 100, linked_sequence_count: 0 }];
    vi.mocked(apiClient.GET).mockResolvedValue({ data: items, error: undefined } as never);

    const { result } = renderHook(() => useMediaLibrary(), { wrapper });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(apiClient.GET).toHaveBeenCalledWith("/media/library", {});
    expect(result.current.data).toEqual(items);
  });
});

describe("useDeleteVideo", () => {
  afterEach(() => vi.clearAllMocks());

  it("calls DELETE with the video id", async () => {
    vi.mocked(apiClient.DELETE).mockResolvedValue({ data: undefined, error: undefined } as never);

    const { result } = renderHook(() => useDeleteVideo(), { wrapper });

    await act(async () => {
      await result.current.mutateAsync(7);
    });

    expect(apiClient.DELETE).toHaveBeenCalledWith("/media/videos/{video_id}", {
      params: { path: { video_id: 7 } },
    });
  });
});
