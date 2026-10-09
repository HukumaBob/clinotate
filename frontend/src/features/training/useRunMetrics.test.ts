import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { apiClient } from "../../shared/api/client";
import { deferred } from "./testDeferred";
import { useRunMetrics } from "./useRunMetrics";

vi.mock("../../shared/api/client", () => ({
  apiClient: { GET: vi.fn(), POST: vi.fn(), DELETE: vi.fn() },
}));

const ok = (data: unknown) => ({ data, error: undefined }) as never;
const metricsCalls = () =>
  vi.mocked(apiClient.GET).mock.calls.filter((c) => c[0] === "/training/runs/{run_id}/metrics");

describe("useRunMetrics", () => {
  beforeEach(() => {
    vi.mocked(apiClient.GET).mockReset();
  });

  it("requests the metrics of the run", async () => {
    vi.mocked(apiClient.GET).mockResolvedValue(ok({ metrics: {}, history: [], per_class: [] }));
    const { result } = renderHook(() => useRunMetrics(7, false, 0));
    await waitFor(() => expect(result.current.data).not.toBeNull());
    expect(apiClient.GET).toHaveBeenCalledWith("/training/runs/{run_id}/metrics", {
      params: { path: { run_id: 7 } },
    });
    expect(result.current.error).toBe(false);
    expect(result.current.loading).toBe(false);
  });

  it("reloads when epoch increments while active", async () => {
    vi.mocked(apiClient.GET).mockResolvedValue(ok({ history: [] }));
    const { rerender } = renderHook(({ e }) => useRunMetrics(7, true, e), { initialProps: { e: 1 } });
    await waitFor(() => expect(metricsCalls()).toHaveLength(1));
    rerender({ e: 2 });
    await waitFor(() => expect(metricsCalls()).toHaveLength(2));
  });

  it("does not reload on an unrelated re-render or an epoch change while inactive", async () => {
    vi.mocked(apiClient.GET).mockResolvedValue(ok({ history: [] }));
    const { rerender } = renderHook(({ e }) => useRunMetrics(7, false, e), { initialProps: { e: 1 } });
    await waitFor(() => expect(metricsCalls()).toHaveLength(1));
    rerender({ e: 1 });
    rerender({ e: 4 });
    await act(async () => {});
    expect(metricsCalls()).toHaveLength(1);
  });

  it("loads once more when active becomes false", async () => {
    vi.mocked(apiClient.GET).mockResolvedValue(ok({ history: [] }));
    const { rerender } = renderHook(({ a }) => useRunMetrics(7, a, 3), { initialProps: { a: true } });
    await waitFor(() => expect(metricsCalls()).toHaveLength(1));
    rerender({ a: false });
    await waitFor(() => expect(metricsCalls()).toHaveLength(2));
  });

  it("ignores a stale answer after the run id changed and resets data", async () => {
    const first = deferred<unknown>();
    const second = deferred<unknown>();
    vi.mocked(apiClient.GET)
      .mockReturnValueOnce(first.promise as never)
      .mockReturnValueOnce(second.promise as never);
    const { result, rerender } = renderHook(({ id }) => useRunMetrics(id, false, 0), {
      initialProps: { id: 1 },
    });
    rerender({ id: 2 });
    await act(async () => {
      second.resolve(ok({ tag: "two" }));
    });
    await waitFor(() => expect(result.current.data).toEqual({ tag: "two" }));
    await act(async () => {
      first.resolve(ok({ tag: "one" }));
    });
    expect(result.current.data).toEqual({ tag: "two" });
  });

  it("clears data when the run id changes", async () => {
    const second = deferred<unknown>();
    vi.mocked(apiClient.GET)
      .mockResolvedValueOnce(ok({ tag: "one" }))
      .mockReturnValueOnce(second.promise as never);
    const { result, rerender } = renderHook(({ id }) => useRunMetrics(id, false, 0), {
      initialProps: { id: 1 },
    });
    await waitFor(() => expect(result.current.data).toEqual({ tag: "one" }));
    rerender({ id: 2 });
    await waitFor(() => expect(result.current.data).toBeNull());
  });

  it("flags an error for a failed or thrown request", async () => {
    vi.mocked(apiClient.GET).mockResolvedValueOnce({ data: undefined, error: {} } as never);
    const { result } = renderHook(() => useRunMetrics(7, false, 0));
    await waitFor(() => expect(result.current.error).toBe(true));
    expect(result.current.loading).toBe(false);
  });

  it("returns null data and makes no request without a run id", async () => {
    const { result } = renderHook(() => useRunMetrics(null, true, 0));
    expect(result.current.data).toBeNull();
    expect(apiClient.GET).not.toHaveBeenCalled();
  });
});
