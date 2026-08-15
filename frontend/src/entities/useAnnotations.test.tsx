import { describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";

import { apiClient } from "../shared/api/client";
import {
  useBulkClassifyFrames,
  useBulkClearClassification,
  useBulkMarkNoFindings,
  useBulkClearNoFindings,
} from "./useAnnotations";

vi.mock("../shared/api/client", () => ({
  apiClient: {
    POST: vi.fn(),
  },
}));

function wrapper({ children }: { children: ReactNode }) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}

describe("useBulkClassifyFrames", () => {
  it("posts frame_ids and label_id to the bulk-classify endpoint", async () => {
    vi.mocked(apiClient.POST).mockResolvedValue({ data: { frame_ids: [1, 2] } } as never);

    const { result } = renderHook(() => useBulkClassifyFrames(10), { wrapper });
    result.current.mutate({ frameIds: [1, 2], labelId: 5 });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(apiClient.POST).toHaveBeenCalledWith("/annotation/frames/bulk-classify", {
      body: { frame_ids: [1, 2], label_id: 5 },
    });
  });
});

describe("useBulkClearClassification", () => {
  it("posts frame_ids, category_id, and evaluation_type_id to the bulk-clear-classification endpoint", async () => {
    vi.mocked(apiClient.POST).mockResolvedValue({ data: { frame_ids: [1, 2] } } as never);

    const { result } = renderHook(() => useBulkClearClassification(10), { wrapper });
    result.current.mutate({ frameIds: [1, 2], categoryId: 3, evaluationTypeId: 9 });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(apiClient.POST).toHaveBeenCalledWith("/annotation/frames/bulk-clear-classification", {
      body: { frame_ids: [1, 2], category_id: 3, evaluation_type_id: 9 },
    });
  });
});

describe("useBulkMarkNoFindings", () => {
  it("posts frame ids and invalidates frames + annotations queries", async () => {
    const postMock = vi.mocked(apiClient.POST);
    postMock.mockResolvedValueOnce({
      data: { marked_frame_ids: [1, 2], skipped_frame_ids: [] },
      error: undefined,
    } as never);

    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { result } = renderHook(() => useBulkMarkNoFindings(42), {
      wrapper: ({ children }) => (
        <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
      ),
    });

    result.current.mutate({ frameIds: [1, 2] });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(postMock).toHaveBeenCalledWith("/annotation/frames/bulk-mark-no-findings", {
      body: { frame_ids: [1, 2] },
    });
  });
});

describe("useBulkClearNoFindings", () => {
  it("posts frame ids to the bulk-clear-no-findings endpoint", async () => {
    vi.mocked(apiClient.POST).mockResolvedValue({
      data: { cleared_frame_ids: [1, 2], skipped_frame_ids: [] },
    } as never);

    const { result } = renderHook(() => useBulkClearNoFindings(42), { wrapper });
    result.current.mutate({ frameIds: [1, 2] });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(apiClient.POST).toHaveBeenCalledWith("/annotation/frames/bulk-clear-no-findings", {
      body: { frame_ids: [1, 2] },
    });
  });
});
