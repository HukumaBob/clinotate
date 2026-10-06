import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { apiClient } from "../shared/api/client";
import { useInferenceRuns } from "./useInferenceRuns";

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
