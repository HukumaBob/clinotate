import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { apiClient } from "../shared/api/client";
import { useCommitEpisodes } from "./useCommitEpisodes";

vi.mock("../shared/api/client", () => ({ apiClient: { POST: vi.fn() } }));

function setup() {
  const queryClient = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  const spy = vi.spyOn(queryClient, "invalidateQueries");
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  return { wrapper, spy };
}

const vars = {
  episodes: [{ axis: "a|b", start_ms: 5 }],
  stepMs: 500,
  marginMs: 1000,
  name: "n",
  dryRun: false,
};

afterEach(() => vi.clearAllMocks());

describe("useCommitEpisodes", () => {
  it("posts a snake_case body", async () => {
    vi.mocked(apiClient.POST).mockResolvedValue({ data: { frames: 3 } } as never);
    const { wrapper } = setup();
    const { result } = renderHook(() => useCommitEpisodes(7, 9), { wrapper });
    await act(async () => {
      await result.current.mutateAsync(vars);
    });
    expect(apiClient.POST).toHaveBeenCalledWith("/reference/runs/{run_id}/commit-episodes", {
      params: { path: { run_id: 7 } },
      body: {
        episodes: [{ axis: "a|b", start_ms: 5 }],
        step_ms: 500,
        margin_ms: 1000,
        name: "n",
        dry_run: false,
      },
    });
  });

  it("invalidates sequences after a real commit only", async () => {
    vi.mocked(apiClient.POST).mockResolvedValue({ data: {} } as never);
    const { wrapper, spy } = setup();
    const { result } = renderHook(() => useCommitEpisodes(7, 9), { wrapper });
    await act(async () => {
      await result.current.mutateAsync({ ...vars, dryRun: true });
    });
    expect(spy).not.toHaveBeenCalled();
    await act(async () => {
      await result.current.mutateAsync(vars);
    });
    const keys = spy.mock.calls.map((c) => (c[0] as { queryKey: unknown[] }).queryKey);
    expect(keys).toContainEqual(["video-sent", 9]);
    expect(keys).toContainEqual(["video-sequences", 9]);
  });

  it("throws the server error", async () => {
    vi.mocked(apiClient.POST).mockResolvedValue({ error: { detail: "bad" } } as never);
    const { wrapper } = setup();
    const { result } = renderHook(() => useCommitEpisodes(7), { wrapper });
    await act(async () => {
      await result.current.mutateAsync(vars).catch(() => {});
    });
    await waitFor(() => expect(result.current.error).toEqual({ detail: "bad" }));
  });
});
