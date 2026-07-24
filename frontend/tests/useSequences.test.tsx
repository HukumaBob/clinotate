import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";

import { apiClient } from "../src/shared/api/client";
import { useSequencesForVideo } from "../src/entities/useSequences";

function wrapper({ children }: { children: ReactNode }) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}

describe("useSequencesForVideo", () => {
  it("fetches sequences for a video id", async () => {
    vi.spyOn(apiClient, "GET").mockResolvedValue({
      data: [{ id: 1, video_id: 9, procedure_id: null, start_time: 0, duration: 2 }],
      error: undefined,
      response: new Response(),
    } as never);

    const { result } = renderHook(() => useSequencesForVideo(9), { wrapper });

    await waitFor(() => expect(result.current.data).toHaveLength(1));
    expect(apiClient.GET).toHaveBeenCalledWith(
      "/media/videos/{video_id}/sequences",
      expect.objectContaining({ params: { path: { video_id: 9 } } }),
    );
  });
});
