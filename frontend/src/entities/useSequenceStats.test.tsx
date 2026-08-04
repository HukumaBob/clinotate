import { describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";

import { apiClient } from "../shared/api/client";
import { useSequenceStats } from "./useSequenceStats";

vi.mock("../shared/api/client", () => ({
  apiClient: { GET: vi.fn() },
}));

function wrapper({ children }: { children: ReactNode }) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}

describe("useSequenceStats", () => {
  it("fetches stats for the given sequence id and returns the response data", async () => {
    vi.mocked(apiClient.GET).mockResolvedValue({
      data: {
        frame_count: 42,
        frame_width: 720,
        frame_height: 480,
        labels: [{ label_name: "polyp", count: 5 }],
      },
      error: undefined,
    } as never);

    const { result } = renderHook(() => useSequenceStats(9), { wrapper });

    await waitFor(() => expect(result.current.data).toBeDefined());

    expect(apiClient.GET).toHaveBeenCalledWith(
      "/media/sequences/{sequence_id}/stats",
      expect.objectContaining({ params: { path: { sequence_id: 9 } } })
    );
    expect(result.current.data).toEqual({
      frame_count: 42,
      frame_width: 720,
      frame_height: 480,
      labels: [{ label_name: "polyp", count: 5 }],
    });
  });
});
