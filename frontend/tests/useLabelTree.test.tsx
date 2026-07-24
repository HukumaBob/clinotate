import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";

import { apiClient } from "../src/shared/api/client";
import { useLabelTree } from "../src/entities/useLabelTree";

function wrapper({ children }: { children: ReactNode }) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}

describe("useLabelTree", () => {
  it("fetches the label tree", async () => {
    vi.spyOn(apiClient, "GET").mockResolvedValue({
      data: [
        {
          category: { id: 1, name: "lesion", label_type: "geometric", color: "#fff", procedure_id: null, taxonomy_version: 1 },
          children: [],
        },
      ],
      error: undefined,
      response: new Response(),
    } as never);

    const { result } = renderHook(() => useLabelTree(), { wrapper });

    await waitFor(() => expect(result.current.data).toHaveLength(1));
    expect(apiClient.GET).toHaveBeenCalledWith("/taxonomy/labels/tree", expect.anything());
  });
});
