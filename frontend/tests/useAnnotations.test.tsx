import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";

import { apiClient } from "../src/shared/api/client";
import { useDeleteAnnotation, useDeleteJobAnnotations } from "../src/entities/useAnnotations";

function wrapper({ children }: { children: ReactNode }) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}

describe("useDeleteAnnotation", () => {
  it("calls DELETE /annotation/annotations/{annotation_id} with the given id", async () => {
    vi.spyOn(apiClient, "DELETE").mockResolvedValue({ data: undefined, error: undefined, response: new Response() } as never);

    const { result } = renderHook(() => useDeleteAnnotation(42), { wrapper });
    result.current.mutate(7);

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(apiClient.DELETE).toHaveBeenCalledWith(
      "/annotation/annotations/{annotation_id}",
      expect.objectContaining({ params: { path: { annotation_id: 7 } } }),
    );
  });
});

describe("useDeleteJobAnnotations", () => {
  it("calls DELETE /annotation/jobs/{job_id}/annotations with the given job id", async () => {
    vi.spyOn(apiClient, "DELETE").mockResolvedValue({
      data: { deleted_ids: [7, 8] },
      error: undefined,
      response: new Response(),
    } as never);

    const { result } = renderHook(() => useDeleteJobAnnotations(42), { wrapper });
    result.current.mutate(99);

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(apiClient.DELETE).toHaveBeenCalledWith(
      "/annotation/jobs/{job_id}/annotations",
      expect.objectContaining({ params: { path: { job_id: 99 } } }),
    );
  });
});
