import { afterEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor, act } from "@testing-library/react";
import type { ReactNode } from "react";

import { apiClient } from "../shared/api/client";
import { useDeleteSequence, useDeleteVideo, useMediaLibrary } from "./useMediaLibrary";

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
    const envelope = { items, total: 1, page: 1, page_size: 25 };
    vi.mocked(apiClient.GET).mockResolvedValue({ data: envelope, error: undefined } as never);

    const { result } = renderHook(() => useMediaLibrary({ page: 1, pageSize: 25 }), { wrapper });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(apiClient.GET).toHaveBeenCalledWith("/media/library", {
      params: {
        query: {
          search: undefined,
          type: undefined,
          procedure_id: undefined,
          sort: undefined,
          order: undefined,
          page: 1,
          page_size: 25,
        },
      },
    });
    expect(result.current.data).toEqual(envelope);
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

describe("useDeleteSequence", () => {
  afterEach(() => vi.clearAllMocks());

  it("invalidates sequences, video-sequences, and media-library queries on success", async () => {
    vi.mocked(apiClient.DELETE).mockResolvedValue({ data: undefined, error: undefined } as never);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");
    function localWrapper({ children }: { children: ReactNode }) {
      return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
    }

    const { result } = renderHook(() => useDeleteSequence(), { wrapper: localWrapper });

    await act(async () => {
      await result.current.mutateAsync(3);
    });

    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ["sequences"] });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ["video-sequences"] });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ["media-library"] });
  });
});
