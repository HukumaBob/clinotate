import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { apiClient } from "../shared/api/client";
import {
  useCommitQcFlags,
  useDeleteQcFlag,
  usePutQcFlag,
  useQcFlags,
  useVideoSent,
} from "./useQcFlags";

vi.mock("../shared/api/client", () => ({
  apiClient: { GET: vi.fn(), PUT: vi.fn(), DELETE: vi.fn(), POST: vi.fn() },
}));

function setup() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const invalidate = vi.spyOn(queryClient, "invalidateQueries");
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  return { wrapper, invalidate };
}

afterEach(() => vi.clearAllMocks());

describe("useQcFlags", () => {
  it("lists the flags of the run", async () => {
    vi.mocked(apiClient.GET).mockResolvedValue({ data: [{ id: 1 }] } as never);
    const { wrapper } = setup();
    const { result } = renderHook(() => useQcFlags(7), { wrapper });
    await waitFor(() => expect(result.current.data).toEqual([{ id: 1 }]));
    expect(apiClient.GET).toHaveBeenCalledWith("/inference/runs/{run_id}/flags", {
      params: { path: { run_id: 7 } },
    });
  });

  it("does not fetch without a run id", () => {
    const { wrapper } = setup();
    renderHook(() => useQcFlags(null), { wrapper });
    expect(apiClient.GET).not.toHaveBeenCalled();
  });
});

describe("usePutQcFlag", () => {
  it("sends the flag and refreshes the flags and the run counters", async () => {
    vi.mocked(apiClient.PUT).mockResolvedValue({ data: { id: 1 } } as never);
    const { wrapper, invalidate } = setup();
    const { result } = renderHook(() => usePutQcFlag(7), { wrapper });

    await act(async () => {
      await result.current.mutateAsync({ frame_index: 10, timestamp_ms: 1000, kind: "fn", note: null });
    });

    expect(apiClient.PUT).toHaveBeenCalledWith("/inference/runs/{run_id}/flags", {
      params: { path: { run_id: 7 } },
      body: { frame_index: 10, timestamp_ms: 1000, kind: "fn", note: null },
    });
    const keys = invalidate.mock.calls.map((call) => JSON.stringify(call[0]?.queryKey));
    expect(keys).toContain(JSON.stringify(["qc-flags", 7]));
    expect(keys).toContain(JSON.stringify(["inference-run", 7]));
    expect(keys).toContain(JSON.stringify(["inference-runs"]));
  });

  it("surfaces the server's error body", async () => {
    vi.mocked(apiClient.PUT).mockResolvedValue({ error: { detail: "already sent" } } as never);
    const { wrapper } = setup();
    const { result } = renderHook(() => usePutQcFlag(7), { wrapper });
    await act(async () => {
      await expect(
        result.current.mutateAsync({ frame_index: 0, timestamp_ms: 0, kind: "fp", note: null }),
      ).rejects.toEqual({ detail: "already sent" });
    });
  });
});

describe("useDeleteQcFlag", () => {
  it("removes the flag and refreshes", async () => {
    vi.mocked(apiClient.DELETE).mockResolvedValue({} as never);
    const { wrapper, invalidate } = setup();
    const { result } = renderHook(() => useDeleteQcFlag(7), { wrapper });
    await act(async () => {
      await result.current.mutateAsync(3);
    });
    expect(apiClient.DELETE).toHaveBeenCalledWith("/inference/runs/{run_id}/flags/{flag_id}", {
      params: { path: { run_id: 7, flag_id: 3 } },
    });
    expect(invalidate.mock.calls.map((c) => JSON.stringify(c[0]?.queryKey))).toContain(
      JSON.stringify(["qc-flags", 7]),
    );
  });
});

describe("useCommitQcFlags", () => {
  it("commits with the name and refreshes flags, runs, the video count and its sequences", async () => {
    vi.mocked(apiClient.POST).mockResolvedValue({ data: { id: 12, name: "QC" } } as never);
    const { wrapper, invalidate } = setup();
    const { result } = renderHook(() => useCommitQcFlags(7, 99), { wrapper });

    await act(async () => {
      await result.current.mutateAsync({ name: "QC" });
    });

    expect(apiClient.POST).toHaveBeenCalledWith("/inference/runs/{run_id}/commit", {
      params: { path: { run_id: 7 } },
      body: { name: "QC" },
    });
    const keys = invalidate.mock.calls.map((c) => JSON.stringify(c[0]?.queryKey));
    expect(keys).toContain(JSON.stringify(["qc-flags", 7]));
    expect(keys).toContain(JSON.stringify(["inference-runs"]));
    expect(keys).toContain(JSON.stringify(["video-sent", 99]));
    expect(keys).toContain(JSON.stringify(["video-sequences", 99]));
  });
});

describe("useCommitQcFlags on a 409", () => {
  it("still refreshes the flags and run counters", async () => {
    vi.mocked(apiClient.POST).mockResolvedValue({ error: { detail: "no pending flags" } } as never);
    const { wrapper, invalidate } = setup();
    const { result } = renderHook(() => useCommitQcFlags(7, 99), { wrapper });

    await act(async () => {
      await expect(result.current.mutateAsync({ name: "QC" })).rejects.toBeTruthy();
    });

    const keys = invalidate.mock.calls.map((c) => JSON.stringify(c[0]?.queryKey));
    expect(keys).toContain(JSON.stringify(["qc-flags", 7]));
    expect(keys).toContain(JSON.stringify(["inference-run", 7]));
  });
});

describe("usePutQcFlag partial update", () => {
  it("sends no note key when none is given, so the server keeps the stored note", async () => {
    vi.mocked(apiClient.PUT).mockResolvedValue({ data: { id: 1 } } as never);
    const { wrapper } = setup();
    const { result } = renderHook(() => usePutQcFlag(7), { wrapper });

    await act(async () => {
      await result.current.mutateAsync({ frame_index: 5, timestamp_ms: 500, kind: "fn" });
    });

    const body = vi.mocked(apiClient.PUT).mock.calls[0][1]?.body as Record<string, unknown>;
    expect("note" in body).toBe(false);
  });
});

describe("useVideoSent", () => {
  it("reads how much of the video was sent", async () => {
    vi.mocked(apiClient.GET).mockResolvedValue({ data: { sequences: 1, frames: 3 } } as never);
    const { wrapper } = setup();
    const { result } = renderHook(() => useVideoSent(5), { wrapper });
    await waitFor(() => expect(result.current.data).toEqual({ sequences: 1, frames: 3 }));
    expect(apiClient.GET).toHaveBeenCalledWith("/inference/videos/{video_id}/sent", {
      params: { path: { video_id: 5 } },
    });
  });
});
