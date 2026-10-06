import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { apiClient } from "../shared/api/client";
import { useDeleteInferenceRun, useInferenceRuns } from "./useInferenceRuns";

vi.mock("../shared/api/client", () => ({
  apiClient: { GET: vi.fn(), POST: vi.fn(), DELETE: vi.fn() },
}));

function wrapper({ children }: { children: ReactNode }) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}

describe("useInferenceRuns", () => {
  afterEach(() => vi.clearAllMocks());

  it("returns the list from the API", async () => {
    vi.mocked(apiClient.GET).mockResolvedValue({ data: [{ id: 3, status: "succeeded" }] } as never);
    const { result } = renderHook(() => useInferenceRuns(), { wrapper });
    await waitFor(() => expect(result.current.data).toEqual([{ id: 3, status: "succeeded" }]));
    expect(apiClient.GET).toHaveBeenCalledWith("/inference/runs", {});
  });
});

describe("useDeleteInferenceRun", () => {
  afterEach(() => vi.clearAllMocks());

  it("sends force only when asked", async () => {
    vi.mocked(apiClient.DELETE).mockResolvedValue({} as never);
    const { result } = renderHook(() => useDeleteInferenceRun(), { wrapper });
    await act(() => result.current.mutateAsync({ runId: 4 }));
    expect(apiClient.DELETE).toHaveBeenLastCalledWith("/inference/runs/{run_id}", {
      params: { path: { run_id: 4 } },
    });
    await act(() => result.current.mutateAsync({ runId: 5, force: true }));
    expect(apiClient.DELETE).toHaveBeenLastCalledWith("/inference/runs/{run_id}", {
      params: { path: { run_id: 5 }, query: { force: true } },
    });
  });
});
