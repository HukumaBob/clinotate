import { afterEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";

import { apiClient } from "../shared/api/client";
import { useSuggestSequenceName } from "./useSuggestSequenceName";

vi.mock("../shared/api/client", () => ({
  apiClient: { GET: vi.fn() },
}));

function wrapper({ children }: { children: ReactNode }) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}

describe("useSuggestSequenceName", () => {
  afterEach(() => vi.clearAllMocks());

  it("fetches a suggested name once a procedure id is set", async () => {
    vi.mocked(apiClient.GET).mockResolvedValue({
      data: { name: "EGD 2026-07-28 #1" },
      error: undefined,
    } as never);

    const { result } = renderHook(() => useSuggestSequenceName(3), { wrapper });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(apiClient.GET).toHaveBeenCalledWith("/media/sequences/suggest-name", {
      params: { query: { procedure_id: 3 } },
    });
    expect(result.current.data?.name).toBe("EGD 2026-07-28 #1");
  });

  it("does not fetch when procedureId is undefined", () => {
    renderHook(() => useSuggestSequenceName(undefined), { wrapper });
    expect(apiClient.GET).not.toHaveBeenCalled();
  });
});
