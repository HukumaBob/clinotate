import { afterEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";

import { apiClient } from "../shared/api/client";
import { useVideo } from "./useVideo";

vi.mock("../shared/api/client", () => ({
  apiClient: { GET: vi.fn(), POST: vi.fn() },
}));

function wrapper({ children }: { children: ReactNode }) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}

describe("useVideo", () => {
  afterEach(() => vi.clearAllMocks());

  it("fetches the video once an id is provided", async () => {
    vi.mocked(apiClient.GET).mockResolvedValue({
      data: {
        id: 1,
        filename: "a.mp4",
        title: "A",
        procedure_id: null,
        fps: 1,
        duration_seconds: 10,
        size_bytes: 100,
        browser_playable: true,
        container: "mov,mp4,m4a,3gp,3g2,mj2",
        video_codec: "h264",
        stream_url: "https://minio.local/videos/a.mp4?signed=1",
      },
      error: undefined,
    } as never);

    const { result } = renderHook(() => useVideo(1), { wrapper });

    await waitFor(() => expect(result.current.data?.id).toBe(1));
    expect(apiClient.GET).toHaveBeenCalledWith(
      "/media/videos/{video_id}",
      expect.objectContaining({ params: { path: { video_id: 1 } } })
    );
  });

  it("does not fetch when videoId is null", () => {
    renderHook(() => useVideo(null), { wrapper });
    expect(apiClient.GET).not.toHaveBeenCalled();
  });
});
