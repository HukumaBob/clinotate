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
  useRegionLabels,
  useTagRegionsPreview,
  useTagRegions,
  useRemoveRegionCopies,
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
      data: { frame_ids: [1, 2] },
    } as never);

    const { result } = renderHook(() => useBulkClearNoFindings(42), { wrapper });
    result.current.mutate({ frameIds: [1, 2] });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(apiClient.POST).toHaveBeenCalledWith("/annotation/frames/bulk-clear-no-findings", {
      body: { frame_ids: [1, 2] },
    });
  });
});

describe("tag-regions hooks", () => {
  it("useTagRegionsPreview posts dry_run true and snake_case body", async () => {
    const data = { dry_run: true, regions: 3 };
    vi.mocked(apiClient.POST).mockResolvedValue({ data } as never);
    const { result } = renderHook(
      () =>
        useTagRegionsPreview({ frameIds: [1, 2], sourceLabelId: 5, targetLabelId: 6, skipManualFrames: true }),
      { wrapper },
    );
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(apiClient.POST).toHaveBeenCalledWith("/annotation/frames/tag-regions", {
      body: { frame_ids: [1, 2], source_label_id: 5, target_label_id: 6, skip_manual_frames: true, dry_run: true },
    });
    expect(result.current.data).toEqual(data);
  });

  it("useTagRegionsPreview does not fire when params is null", async () => {
    vi.mocked(apiClient.POST).mockClear();
    const { result } = renderHook(() => useTagRegionsPreview(null), { wrapper });
    expect(result.current.fetchStatus).toBe("idle");
    expect(apiClient.POST).not.toHaveBeenCalled();
  });

  it("useTagRegionsPreview reports isError when the API returns no data", async () => {
    vi.mocked(apiClient.POST).mockResolvedValue({ error: { detail: "boom" } } as never);
    const { result } = renderHook(
      () => useTagRegionsPreview({ frameIds: [1], sourceLabelId: 5, targetLabelId: 6, skipManualFrames: false }),
      { wrapper },
    );
    await waitFor(() => expect(result.current.isError).toBe(true));
  });

  it("useTagRegions posts dry_run false and invalidates annotations for every frame", async () => {
    vi.mocked(apiClient.POST).mockResolvedValue({ data: { dry_run: false } } as never);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const spy = vi.spyOn(queryClient, "invalidateQueries");
    const local = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );
    const { result } = renderHook(() => useTagRegions(10), { wrapper: local });
    result.current.mutate({ frameIds: [1, 2], sourceLabelId: 5, targetLabelId: 6, skipManualFrames: false });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(apiClient.POST).toHaveBeenCalledWith("/annotation/frames/tag-regions", {
      body: { frame_ids: [1, 2], source_label_id: 5, target_label_id: 6, skip_manual_frames: false, dry_run: false },
    });
    const keys = spy.mock.calls.map((c) => c[0]?.queryKey);
    expect(keys).toContainEqual(["annotations", 1]);
    expect(keys).toContainEqual(["annotations", 2]);
    expect(keys).toContainEqual(["frames", 10]);
    expect(keys).toContainEqual(["region-labels"]);
    expect(keys).toContainEqual(["tag-regions-preview"]);
    expect(keys).toContainEqual(["remove-copies-preview"]);
  });

  it("useRegionLabels posts frame_ids", async () => {
    const data = [{ label_id: 5, name: "polyp", count: 2, category_name: "Findings" }];
    vi.mocked(apiClient.POST).mockResolvedValue({ data } as never);
    const { result } = renderHook(() => useRegionLabels([2, 1], true), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(apiClient.POST).toHaveBeenCalledWith("/annotation/frames/region-labels", {
      body: { frame_ids: [1, 2] },
    });
    expect(result.current.data).toEqual(data);
  });

  it("useRemoveRegionCopies posts target_label_id and invalidates", async () => {
    vi.mocked(apiClient.POST).mockResolvedValue({ data: { dry_run: false, removed: 1, kept_reviewed: 0 } } as never);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const spy = vi.spyOn(queryClient, "invalidateQueries");
    const local = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );
    const { result } = renderHook(() => useRemoveRegionCopies(10), { wrapper: local });
    result.current.mutate({ frameIds: [1], targetLabelId: 6 });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(apiClient.POST).toHaveBeenCalledWith("/annotation/frames/remove-region-copies", {
      body: { frame_ids: [1], target_label_id: 6, dry_run: false },
    });
    const keys = spy.mock.calls.map((c) => c[0]?.queryKey);
    expect(keys).toContainEqual(["annotations", 1]);
    expect(keys).toContainEqual(["frames", 10]);
  });
});
