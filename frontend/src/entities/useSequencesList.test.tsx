import { afterEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";

import { apiClient } from "../shared/api/client";
import { useSequencesList, useSequencesStats } from "./useSequencesList";

vi.mock("../shared/api/client", () => ({
  apiClient: { GET: vi.fn() },
}));

function wrapper({ children }: { children: ReactNode }) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}

describe("useSequencesList", () => {
  afterEach(() => vi.clearAllMocks());

  it("fetches a page of sequences with the given filters", async () => {
    vi.mocked(apiClient.GET).mockResolvedValue({
      data: { items: [{ id: 1, name: "seq-a" }], total: 1, page: 1, page_size: 25 },
      error: undefined,
    } as never);

    const { result } = renderHook(
      () =>
        useSequencesList({
          procedureId: 3,
          videoId: null,
          labeled: "labeled",
          search: "abc",
          page: 2,
          pageSize: 10,
        }),
      { wrapper },
    );

    await waitFor(() => expect(result.current.data).toBeDefined());
    expect(apiClient.GET).toHaveBeenCalledWith(
      "/media/sequences",
      expect.objectContaining({
        params: {
          query: {
            procedure_id: 3,
            video_id: undefined,
            labeled: "labeled",
            search: "abc",
            page: 2,
            page_size: 10,
          },
        },
      }),
    );
  });
});

describe("useSequencesStats", () => {
  afterEach(() => vi.clearAllMocks());

  it("fetches aggregate stats for the given filters", async () => {
    vi.mocked(apiClient.GET).mockResolvedValue({
      data: { total_sequences: 2, total_frames: 5, labeled_sequences: 1, unlabeled_sequences: 1 },
      error: undefined,
    } as never);

    const { result } = renderHook(
      () => useSequencesStats({ procedureId: null, videoId: null, search: "" }),
      { wrapper },
    );

    await waitFor(() => expect(result.current.data?.total_sequences).toBe(2));
    expect(apiClient.GET).toHaveBeenCalledWith(
      "/media/sequences/stats",
      expect.objectContaining({
        params: { query: { procedure_id: undefined, video_id: undefined, search: undefined } },
      }),
    );
  });
});
