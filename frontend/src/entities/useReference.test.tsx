import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { apiClient } from "../shared/api/client";
import {
  type ReferenceRead,
  useCreateInterval,
  useDeleteInterval,
  useReference,
  useReferenceExposure,
  useRestoreClean,
  useUpdateInterval,
} from "./useReference";

vi.mock("../shared/api/client", () => ({
  apiClient: { GET: vi.fn(), POST: vi.fn(), PATCH: vi.fn(), DELETE: vi.fn() },
}));

const existing = {
  id: 1,
  video_id: 5,
  category_id: 2,
  label_id: 10,
  taxonomy_version: 1,
  start_ms: 0,
  end_ms: 1000,
  orphaned: false,
};

const reference: ReferenceRead = {
  video_id: 5,
  procedure_id: 1,
  duration_ms: 10000,
  status: "clean",
  compromised_at: null,
  compromised_by_training_run_id: null,
  axes: [
    {
      category_id: 2,
      name: "Axis",
      classes: [
        { label_id: 10, name: "A", key: "a" },
        { label_id: 11, name: "B", key: "b" },
      ],
    },
  ],
  intervals: [existing],
};

function setup() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  queryClient.setQueryData(["reference", 5], reference);
  const invalidate = vi.spyOn(queryClient, "invalidateQueries");
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  return { wrapper, invalidate, queryClient };
}

const cached = (qc: QueryClient) => qc.getQueryData<ReferenceRead>(["reference", 5])!;

afterEach(() => vi.clearAllMocks());

describe("useReference", () => {
  it("reads the reference of the video", async () => {
    vi.mocked(apiClient.GET).mockResolvedValue({ data: reference } as never);
    const { wrapper } = setup();
    const { result } = renderHook(() => useReference(5), { wrapper });
    await waitFor(() => expect(result.current.data).toEqual(reference));
    expect(apiClient.GET).toHaveBeenCalledWith("/reference/videos/{video_id}", {
      params: { path: { video_id: 5 } },
    });
  });

  it("does not fetch without a video id", () => {
    const { wrapper } = setup();
    renderHook(() => useReference(null), { wrapper });
    expect(apiClient.GET).not.toHaveBeenCalled();
  });
});

describe("useCreateInterval", () => {
  it("adds the interval before the server answers, then swaps in the server row", async () => {
    let resolve!: (v: unknown) => void;
    vi.mocked(apiClient.POST).mockReturnValue(new Promise((r) => (resolve = r)) as never);
    const { wrapper, queryClient } = setup();
    const { result } = renderHook(() => useCreateInterval(5), { wrapper });

    let promise!: Promise<unknown>;
    act(() => {
      promise = result.current.mutateAsync({ labelId: 11, startMs: 2000, endMs: 3000 });
    });
    await waitFor(() => expect(cached(queryClient).intervals).toHaveLength(2));
    const temp = cached(queryClient).intervals[1];
    expect(temp.id).toBeLessThan(0);
    expect(temp).toMatchObject({ label_id: 11, category_id: 2, start_ms: 2000, end_ms: 3000 });

    const server = { ...existing, id: 42, label_id: 11, start_ms: 2000, end_ms: 3000 };
    await act(async () => {
      resolve({ data: server });
      await promise;
    });
    expect(apiClient.POST).toHaveBeenCalledWith("/reference/videos/{video_id}/intervals", {
      params: { path: { video_id: 5 } },
      body: { label_id: 11, start_ms: 2000, end_ms: 3000 },
    });
    expect(cached(queryClient).intervals.map((i) => i.id)).toEqual([1, 42]);
  });

  it("rolls back on a 409 and surfaces the error body", async () => {
    vi.mocked(apiClient.POST).mockResolvedValue({ error: { detail: "overlaps" } } as never);
    const { wrapper, queryClient, invalidate } = setup();
    const { result } = renderHook(() => useCreateInterval(5), { wrapper });
    await act(async () => {
      await expect(
        result.current.mutateAsync({ labelId: 11, startMs: 500, endMs: 900 }),
      ).rejects.toEqual({ detail: "overlaps" });
    });
    expect(cached(queryClient).intervals).toEqual([existing]);
    expect(invalidate.mock.calls.map((c) => JSON.stringify(c[0]?.queryKey))).toContain(
      JSON.stringify(["reference", 5]),
    );
  });
});

describe("useUpdateInterval", () => {
  it("applies the change optimistically and sends snake_case", async () => {
    let resolve!: (v: unknown) => void;
    vi.mocked(apiClient.PATCH).mockReturnValue(new Promise((r) => (resolve = r)) as never);
    const { wrapper, queryClient } = setup();
    const { result } = renderHook(() => useUpdateInterval(5), { wrapper });
    let promise!: Promise<unknown>;
    act(() => {
      promise = result.current.mutateAsync({ intervalId: 1, endMs: 1500 });
    });
    await waitFor(() => expect(cached(queryClient).intervals[0].end_ms).toBe(1500));
    await act(async () => {
      resolve({ data: { ...existing, end_ms: 1500 } });
      await promise;
    });
    expect(apiClient.PATCH).toHaveBeenCalledWith(
      "/reference/videos/{video_id}/intervals/{interval_id}",
      { params: { path: { video_id: 5, interval_id: 1 } }, body: { end_ms: 1500 } },
    );
  });

  it("restores the interval on failure", async () => {
    vi.mocked(apiClient.PATCH).mockResolvedValue({ error: { detail: "bad" } } as never);
    const { wrapper, queryClient } = setup();
    const { result } = renderHook(() => useUpdateInterval(5), { wrapper });
    await act(async () => {
      await expect(result.current.mutateAsync({ intervalId: 1, startMs: 100 })).rejects.toBeTruthy();
    });
    expect(cached(queryClient).intervals).toEqual([existing]);
  });
});

describe("useDeleteInterval", () => {
  it("removes optimistically", async () => {
    let resolve!: (v: unknown) => void;
    vi.mocked(apiClient.DELETE).mockReturnValue(new Promise((r) => (resolve = r)) as never);
    const { wrapper, queryClient } = setup();
    const { result } = renderHook(() => useDeleteInterval(5), { wrapper });
    let promise!: Promise<unknown>;
    act(() => {
      promise = result.current.mutateAsync(1);
    });
    await waitFor(() => expect(cached(queryClient).intervals).toHaveLength(0));
    await act(async () => {
      resolve({});
      await promise;
    });
    expect(apiClient.DELETE).toHaveBeenCalledWith(
      "/reference/videos/{video_id}/intervals/{interval_id}",
      { params: { path: { video_id: 5, interval_id: 1 } } },
    );
  });

  it("restores the interval when the server refuses", async () => {
    vi.mocked(apiClient.DELETE).mockResolvedValue({ error: { detail: "no" } } as never);
    const { wrapper, queryClient } = setup();
    const { result } = renderHook(() => useDeleteInterval(5), { wrapper });
    await act(async () => {
      await expect(result.current.mutateAsync(1)).rejects.toBeTruthy();
    });
    expect(cached(queryClient).intervals).toEqual([existing]);
  });
});

describe("useRestoreClean", () => {
  it("invalidates the reference", async () => {
    vi.mocked(apiClient.POST).mockResolvedValue({} as never);
    const { wrapper, invalidate } = setup();
    const { result } = renderHook(() => useRestoreClean(5), { wrapper });
    await act(async () => {
      await result.current.mutateAsync();
    });
    expect(apiClient.POST).toHaveBeenCalledWith("/reference/videos/{video_id}/restore-clean", {
      params: { path: { video_id: 5 } },
    });
    expect(invalidate.mock.calls.map((c) => JSON.stringify(c[0]?.queryKey))).toContain(
      JSON.stringify(["reference", 5]),
    );
  });
});

describe("useReferenceExposure", () => {
  it("reads the exposure of the dataset", async () => {
    vi.mocked(apiClient.GET).mockResolvedValue({ data: [{ video_id: 5 }] } as never);
    const { wrapper } = setup();
    const { result } = renderHook(() => useReferenceExposure(3), { wrapper });
    await waitFor(() => expect(result.current.data).toEqual([{ video_id: 5 }]));
    expect(apiClient.GET).toHaveBeenCalledWith("/reference/datasets/{dataset_id}/exposure", {
      params: { path: { dataset_id: 3 } },
    });
  });

  it("does not fetch without a dataset id", () => {
    const { wrapper } = setup();
    renderHook(() => useReferenceExposure(null), { wrapper });
    expect(apiClient.GET).not.toHaveBeenCalled();
  });
});
