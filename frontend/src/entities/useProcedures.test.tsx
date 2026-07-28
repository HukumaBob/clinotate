import { afterEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";

import { apiClient } from "../shared/api/client";
import { useProcedures } from "./useProcedures";

vi.mock("../shared/api/client", () => ({
  apiClient: { GET: vi.fn() },
}));

function wrapper({ children }: { children: ReactNode }) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}

describe("useProcedures", () => {
  afterEach(() => vi.clearAllMocks());

  it("fetches the procedure list", async () => {
    const procedures = [{ id: 1, name: "EGD" }];
    vi.mocked(apiClient.GET).mockResolvedValue({ data: procedures, error: undefined } as never);

    const { result } = renderHook(() => useProcedures(), { wrapper });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(apiClient.GET).toHaveBeenCalledWith("/taxonomy/procedures", {});
    expect(result.current.data).toEqual(procedures);
  });
});
