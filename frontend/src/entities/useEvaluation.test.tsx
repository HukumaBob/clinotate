import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { apiClient } from "../shared/api/client";
import { useEvaluation } from "./useEvaluation";

vi.mock("../shared/api/client", () => ({ apiClient: { GET: vi.fn() } }));

function setup() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  return { wrapper, queryClient };
}

afterEach(() => vi.clearAllMocks());

describe("useEvaluation", () => {
  it("requests the evaluation of the run with the tolerance", async () => {
    vi.mocked(apiClient.GET).mockResolvedValue({ data: { run_id: 7 } } as never);
    const { wrapper, queryClient } = setup();
    const { result } = renderHook(() => useEvaluation(7, 500, true), { wrapper });
    await waitFor(() => expect(result.current.data).toEqual({ run_id: 7 }));
    expect(apiClient.GET).toHaveBeenCalledWith("/reference/runs/{run_id}/evaluation", {
      params: { path: { run_id: 7 }, query: { boundary_ms: 500 } },
    });
    expect(queryClient.getQueryData(["evaluation", 7, 500])).toEqual({ run_id: 7 });
  });

  it("does not fetch when disabled or without a run", () => {
    const { wrapper } = setup();
    renderHook(() => useEvaluation(7, 500, false), { wrapper });
    renderHook(() => useEvaluation(null, 500, true), { wrapper });
    expect(apiClient.GET).not.toHaveBeenCalled();
  });

  it("throws the API error", async () => {
    vi.mocked(apiClient.GET).mockResolvedValue({ error: { detail: "nope" } } as never);
    const { wrapper } = setup();
    const { result } = renderHook(() => useEvaluation(7, 500, true), { wrapper });
    await waitFor(() => expect(result.current.isError).toBe(true));
  });
});
