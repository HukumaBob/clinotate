import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { apiClient } from "../shared/api/client";
import { useQcCompare } from "./useQcCompare";

vi.mock("../shared/api/client", () => ({ apiClient: { GET: vi.fn() } }));

function wrapper({ children }: { children: ReactNode }) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}

afterEach(() => vi.clearAllMocks());

describe("useQcCompare", () => {
  it("asks the compare endpoint with both runs and thresholds", async () => {
    vi.mocked(apiClient.GET).mockResolvedValue({ data: { frames: [], total: 0, disagreements: 0 } } as never);
    const { result } = renderHook(() => useQcCompare(1, 2, 0.25, 0.4), { wrapper });
    await waitFor(() => expect(result.current.data).toBeDefined());
    expect(apiClient.GET).toHaveBeenCalledWith("/inference/compare", {
      params: { query: { run_a: 1, run_b: 2, conf_a: 0.25, conf_b: 0.4 } },
    });
  });

  it("stays idle until both runs are known", () => {
    renderHook(() => useQcCompare(1, null, 0.25, 0.25), { wrapper });
    expect(apiClient.GET).not.toHaveBeenCalled();
  });
});
