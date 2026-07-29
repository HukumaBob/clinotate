import { afterEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, act } from "@testing-library/react";
import type { ReactNode } from "react";

import { apiClient } from "../shared/api/client";
import { useUploadVideo } from "./useVideos";

vi.mock("../shared/api/client", () => ({
  apiClient: { GET: vi.fn(), POST: vi.fn() },
}));

function wrapper({ children }: { children: ReactNode }) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}

describe("useUploadVideo", () => {
  afterEach(() => vi.clearAllMocks());

  it("includes procedureId in the form data when provided", async () => {
    vi.mocked(apiClient.POST).mockResolvedValue({ data: { id: 1 }, error: undefined } as never);
    const { result } = renderHook(() => useUploadVideo(), { wrapper });

    const file = new File(["x"], "a.mp4", { type: "video/mp4" });
    await act(async () => {
      await result.current.mutateAsync({ file, title: "Test", procedureId: 5 });
    });

    const call = vi.mocked(apiClient.POST).mock.calls[0];
    const formData = call[1]?.body as FormData;
    expect(formData.get("procedure_id")).toBe("5");
    expect(formData.get("title")).toBe("Test");
  });
});
