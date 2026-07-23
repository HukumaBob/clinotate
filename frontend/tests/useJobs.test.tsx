import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";

import { apiClient } from "../src/shared/api/client";
import { useJob } from "../src/entities/useJobs";

function wrapper({ children }: { children: ReactNode }) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}

describe("useJob", () => {
  it("stops polling once the job status is succeeded", async () => {
    vi.spyOn(apiClient, "GET").mockResolvedValue({
      data: { id: 1, job_type: "sam3_predict", status: "succeeded", progress: 100, result_ref: "masks/1/1.png", error: null, created_by_id: 1, started_at: null, finished_at: null },
      error: undefined,
      response: new Response(),
    } as never);

    const { result } = renderHook(() => useJob(1), { wrapper });

    await waitFor(() => expect(result.current.data?.status).toBe("succeeded"));
    expect(apiClient.GET).toHaveBeenCalledWith(
      "/jobs/{job_id}",
      expect.objectContaining({ params: { path: { job_id: 1 } } }),
    );
  });

  it("returns undefined data when jobId is null and does not call the API", () => {
    vi.spyOn(apiClient, "GET").mockResolvedValue({ data: undefined, error: undefined, response: new Response() } as never);

    const { result } = renderHook(() => useJob(null), { wrapper });

    expect(result.current.data).toBeUndefined();
  });
});
