import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { apiClient } from "../../shared/api/client";
import { useActiveRun } from "./useActiveRun";

vi.mock("../../shared/api/client", () => ({
  apiClient: { GET: vi.fn(), POST: vi.fn(), DELETE: vi.fn() },
}));

const ok = (data: unknown) => ({ data, error: undefined }) as never;

describe("useActiveRun", () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.mocked(apiClient.GET).mockReset();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("picks the pending/running run from the list", async () => {
    vi.mocked(apiClient.GET).mockResolvedValue(
      ok([
        { id: 3, status: "succeeded" },
        { id: 2, status: "running" },
      ]),
    );
    const { result } = renderHook(() => useActiveRun(vi.fn()));
    await waitFor(() => expect(result.current.run?.id).toBe(2));
    expect(apiClient.GET).toHaveBeenCalledWith("/training/runs", { params: { query: { limit: 20 } } });
  });

  it("does not poll when there is no active run", async () => {
    vi.mocked(apiClient.GET).mockResolvedValue(ok([{ id: 3, status: "succeeded" }]));
    const { result } = renderHook(() => useActiveRun(vi.fn()));
    await waitFor(() => expect(apiClient.GET).toHaveBeenCalledTimes(1));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(6100);
    });
    expect(result.current.run).toBeNull();
    expect(apiClient.GET).toHaveBeenCalledTimes(1);
  });

  it("polls the run every 2 s while active, then calls onFinished once and stops", async () => {
    const onFinished = vi.fn();
    vi.mocked(apiClient.GET).mockImplementation((async (path: string) => {
      if (path === "/training/runs") return ok([{ id: 2, status: "running" }]);
      const calls = vi.mocked(apiClient.GET).mock.calls.filter((c) => c[0] !== "/training/runs").length;
      return ok({ id: 2, status: calls >= 2 ? "succeeded" : "running" });
    }) as never);
    const { result } = renderHook(() => useActiveRun(onFinished));
    await waitFor(() => expect(result.current.run?.id).toBe(2));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2100);
    });
    expect(apiClient.GET).toHaveBeenCalledWith("/training/runs/{run_id}", { params: { path: { run_id: 2 } } });
    expect(onFinished).not.toHaveBeenCalled();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2100);
    });
    await waitFor(() => expect(onFinished).toHaveBeenCalledTimes(1));
    expect(onFinished).toHaveBeenCalledWith({ id: 2, status: "succeeded" });
    const callCount = vi.mocked(apiClient.GET).mock.calls.length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(6100);
    });
    expect(vi.mocked(apiClient.GET).mock.calls.length).toBe(callCount);
    expect(onFinished).toHaveBeenCalledTimes(1);
  });

  it("does not restart polling when the callback identity changes", async () => {
    vi.mocked(apiClient.GET).mockImplementation((async (path: string) =>
      path === "/training/runs" ? ok([{ id: 2, status: "running" }]) : ok({ id: 2, status: "running" })) as never);
    const { result, rerender } = renderHook(({ cb }) => useActiveRun(cb), {
      initialProps: { cb: vi.fn() },
    });
    await waitFor(() => expect(result.current.run?.id).toBe(2));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1500);
    });
    rerender({ cb: vi.fn() });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(600);
    });
    // interval kept its phase: exactly one poll by t=2.1 s
    const polls = vi.mocked(apiClient.GET).mock.calls.filter((c) => c[0] === "/training/runs/{run_id}");
    expect(polls).toHaveLength(1);
  });

  it("uses the latest onFinished callback", async () => {
    const first = vi.fn();
    const second = vi.fn();
    vi.mocked(apiClient.GET).mockImplementation((async (path: string) =>
      path === "/training/runs" ? ok([{ id: 2, status: "running" }]) : ok({ id: 2, status: "failed" })) as never);
    const { result, rerender } = renderHook(({ cb }) => useActiveRun(cb), { initialProps: { cb: first } });
    await waitFor(() => expect(result.current.run?.id).toBe(2));
    rerender({ cb: second });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2100);
    });
    await waitFor(() => expect(second).toHaveBeenCalledTimes(1));
    expect(first).not.toHaveBeenCalled();
  });

  it("refresh() re-discovers a newly started run", async () => {
    vi.mocked(apiClient.GET).mockResolvedValueOnce(ok([]));
    const { result } = renderHook(() => useActiveRun(vi.fn()));
    await waitFor(() => expect(apiClient.GET).toHaveBeenCalledTimes(1));
    expect(result.current.run).toBeNull();
    vi.mocked(apiClient.GET).mockResolvedValueOnce(ok([{ id: 9, status: "pending" }]));
    await act(async () => {
      await result.current.refresh();
    });
    expect(result.current.run?.id).toBe(9);
  });

  it("ignores a stale poll answer that arrives after a newer one and does not update after unmount", async () => {
    let resolveSlow!: (v: unknown) => void;
    let n = 0;
    vi.mocked(apiClient.GET).mockImplementation((async (path: string) => {
      if (path === "/training/runs") return ok([{ id: 2, status: "running", current_epoch: 0 }]);
      n += 1;
      if (n === 1) return new Promise((r) => (resolveSlow = r));
      return ok({ id: 2, status: "running", current_epoch: 5 });
    }) as never);
    const { result, unmount } = renderHook(() => useActiveRun(vi.fn()));
    await waitFor(() => expect(result.current.run?.id).toBe(2));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(4100);
    });
    await waitFor(() => expect((result.current.run as { current_epoch: number }).current_epoch).toBe(5));
    await act(async () => {
      resolveSlow(ok({ id: 2, status: "running", current_epoch: 1 }));
    });
    expect((result.current.run as { current_epoch: number }).current_epoch).toBe(5);
    unmount();
  });
});
