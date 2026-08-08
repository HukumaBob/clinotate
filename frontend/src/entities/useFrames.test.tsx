import { afterEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";

import { apiClient } from "../shared/api/client";
import { useDeleteFrames, useFrame } from "./useFrames";

vi.mock("../shared/api/client", () => ({
  apiClient: { GET: vi.fn(), DELETE: vi.fn() },
}));

function wrapper({ children }: { children: ReactNode }) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}

describe("useFrame", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("fetches a single frame's data, including its image_url, by id", async () => {
    const frame = {
      id: 42,
      sequence_id: 7,
      storage_key: "frames/7/0.png",
      frame_index: 0,
      width: 256,
      height: 256,
      image_url: "http://minio.local/bucket/frames/7/0.png?signature=abc",
    };
    vi.mocked(apiClient.GET).mockResolvedValue({ data: frame, error: undefined } as never);

    const { result } = renderHook(() => useFrame(42), { wrapper });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(apiClient.GET).toHaveBeenCalledWith("/media/frames/{frame_id}", {
      params: { path: { frame_id: 42 } },
    });
    expect(result.current.data?.image_url).toBe(frame.image_url);
  });

  it("does not fetch when frameId is not a finite number", () => {
    renderHook(() => useFrame(Number.NaN), { wrapper });
    expect(apiClient.GET).not.toHaveBeenCalled();
  });
});

describe("useDeleteFrames", () => {
  afterEach(() => vi.clearAllMocks());

  it("calls the bulk-delete endpoint with the sequence id and frame ids", async () => {
    vi.mocked(apiClient.DELETE).mockResolvedValue({
      data: { deleted_ids: [1, 2] },
      error: undefined,
    } as never);

    const { result } = renderHook(() => useDeleteFrames(9), { wrapper });

    result.current.mutate([1, 2]);

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(apiClient.DELETE).toHaveBeenCalledWith(
      "/media/sequences/{sequence_id}/frames",
      expect.objectContaining({
        params: { path: { sequence_id: 9 } },
        body: { frame_ids: [1, 2] },
      }),
    );
  });
});
