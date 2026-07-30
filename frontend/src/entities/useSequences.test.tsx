import { afterEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";

import { apiClient } from "../shared/api/client";
import { useUpdateSequence } from "./useSequences";

vi.mock("../shared/api/client", () => ({
  apiClient: { GET: vi.fn(), POST: vi.fn(), PATCH: vi.fn() },
}));

function wrapper({ children }: { children: ReactNode }) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}

describe("useUpdateSequence", () => {
  afterEach(() => vi.clearAllMocks());

  it("PATCHes only the rename fields when temporal fields are omitted", async () => {
    vi.mocked(apiClient.PATCH).mockResolvedValue({
      data: { id: 1, name: "renamed", video_id: 5, procedure_id: 2, start_time: 0, duration: 10, annotation_count: 0 },
      error: undefined,
    } as never);

    const { result } = renderHook(() => useUpdateSequence(), { wrapper });
    result.current.mutate({ sequenceId: 1, name: "renamed", procedureId: 2 });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(apiClient.PATCH).toHaveBeenCalledWith(
      "/media/sequences/{sequence_id}",
      expect.objectContaining({
        params: { path: { sequence_id: 1 } },
        body: { name: "renamed", procedure_id: 2, start_time: undefined, duration: undefined, fps: undefined },
      })
    );
  });

  it("PATCHes the temporal fields together for a re-cut", async () => {
    vi.mocked(apiClient.PATCH).mockResolvedValue({
      data: { id: 1, name: "cut", video_id: 5, procedure_id: 2, start_time: 5, duration: 20, annotation_count: 0 },
      error: undefined,
    } as never);

    const { result } = renderHook(() => useUpdateSequence(), { wrapper });
    result.current.mutate({ sequenceId: 1, startTime: 5, duration: 20, fps: 2.0 });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(apiClient.PATCH).toHaveBeenCalledWith(
      "/media/sequences/{sequence_id}",
      expect.objectContaining({
        body: expect.objectContaining({ start_time: 5, duration: 20, fps: 2.0 }),
      })
    );
  });
});
