import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";

import { apiClient } from "../src/shared/api/client";
import { useTaxonomyTree } from "../src/entities/useTaxonomyTree";

function wrapper({ children }: { children: ReactNode }) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}

describe("useTaxonomyTree", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("fetches the tree for the given procedure id", async () => {
    const treeData = [
      {
        category: { id: 1, name: "Anatomy", procedure_id: 5 },
        evaluation_types: [
          {
            evaluation_type: { id: 1, name: "geometric" },
            labels: [{ id: 10, name: "pharynx", color: "#2E81DA", category_id: 1, evaluation_type_id: 1, taxonomy_version: 1 }],
          },
        ],
      },
    ];
    vi.spyOn(apiClient, "GET").mockResolvedValue({ data: treeData, error: undefined, response: new Response() } as never);

    const { result } = renderHook(() => useTaxonomyTree(5), { wrapper });

    await waitFor(() => expect(result.current.data).toEqual(treeData));
    expect(apiClient.GET).toHaveBeenCalledWith(
      "/taxonomy/tree",
      expect.objectContaining({ params: { query: { procedure_id: 5 } } }),
    );
  });

  it("does not fetch when procedureId is null", () => {
    const spy = vi.spyOn(apiClient, "GET").mockResolvedValue({ data: [], error: undefined, response: new Response() } as never);

    renderHook(() => useTaxonomyTree(null), { wrapper });

    expect(spy).not.toHaveBeenCalled();
  });
});
