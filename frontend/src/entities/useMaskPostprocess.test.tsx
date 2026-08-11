import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { apiClient } from "../shared/api/client";
import { useReapplyMaskPostprocess } from "./useMaskPostprocess";

vi.mock("../shared/api/client", () => ({
  apiClient: { GET: vi.fn(), POST: vi.fn(), PATCH: vi.fn(), DELETE: vi.fn() },
}));

function wrapper({ children }: { children: ReactNode }) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}

describe("useReapplyMaskPostprocess", () => {
  afterEach(() => vi.clearAllMocks());

  it("PATCHes the given annotation's strength and invalidates the frame's annotations query", async () => {
    vi.mocked(apiClient.PATCH).mockResolvedValue({
      data: { id: 5, mask_postprocess_strength: 0.6 },
      error: undefined,
    } as never);

    const { result } = renderHook(() => useReapplyMaskPostprocess(42), { wrapper });
    result.current.mutate({ annotationId: 5, strength: 0.6 });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(apiClient.PATCH).toHaveBeenCalledWith("/annotation/annotations/{annotation_id}/mask-postprocess", {
      params: { path: { annotation_id: 5 } },
      body: { strength: 0.6 },
    });
  });
});
