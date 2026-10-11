import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { apiClient } from "../../shared/api/client";
import { deferred } from "./testDeferred";
import { useCompareMetrics } from "./useCompareMetrics";

vi.mock("../../shared/api/client", () => ({
  apiClient: { GET: vi.fn(), POST: vi.fn(), DELETE: vi.fn() },
}));

const ok = (data: unknown) => ({ data, error: undefined }) as never;
const fail = () => ({ data: undefined, error: { detail: "x" } }) as never;

describe("useCompareMetrics", () => {
  beforeEach(() => {
    vi.mocked(apiClient.GET).mockReset();
  });

  it("requests each run in parallel and fills byId", async () => {
    vi.mocked(apiClient.GET).mockImplementation((async (_p: string, o: { params: { path: { run_id: number } } }) =>
      ok({ id: o.params.path.run_id })) as never);
    const { result } = renderHook(() => useCompareMetrics([1, 2]));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(apiClient.GET).toHaveBeenCalledWith("/training/runs/{run_id}/metrics", { params: { path: { run_id: 1 } } });
    expect(apiClient.GET).toHaveBeenCalledWith("/training/runs/{run_id}/metrics", { params: { path: { run_id: 2 } } });
    expect(result.current.byId).toEqual({ 1: { id: 1 }, 2: { id: 2 } });
    expect(result.current.error).toBe(false);
  });

  it("makes no request for an empty list", () => {
    const { result } = renderHook(() => useCompareMetrics([]));
    expect(apiClient.GET).not.toHaveBeenCalled();
    expect(result.current).toEqual({ byId: {}, loading: false, error: false });
  });

  it("stays loading until all settle", async () => {
    const a = deferred<never>();
    const b = deferred<never>();
    vi.mocked(apiClient.GET).mockReturnValueOnce(a.promise as never).mockReturnValueOnce(b.promise as never);
    const { result } = renderHook(() => useCompareMetrics([1, 2]));
    expect(result.current.loading).toBe(true);
    await act(async () => a.resolve(ok({ id: 1 })));
    expect(result.current.loading).toBe(true);
    await act(async () => b.resolve(ok({ id: 2 })));
    expect(result.current.loading).toBe(false);
  });

  it("a failed or thrown id sets error and keeps the others", async () => {
    vi.mocked(apiClient.GET)
      .mockResolvedValueOnce(ok({ id: 1 }))
      .mockResolvedValueOnce(fail())
      .mockRejectedValueOnce(new Error("boom"));
    const { result } = renderHook(() => useCompareMetrics([1, 2, 3]));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.error).toBe(true);
    expect(result.current.byId).toEqual({ 1: { id: 1 }, 2: null, 3: null });
  });

  it("drops a late answer from the previous selection", async () => {
    const old = deferred<never>();
    vi.mocked(apiClient.GET).mockReturnValueOnce(old.promise as never).mockResolvedValueOnce(ok({ id: 2 }));
    const { result, rerender } = renderHook(({ ids }) => useCompareMetrics(ids), { initialProps: { ids: [1] } });
    rerender({ ids: [2] });
    await waitFor(() => expect(result.current.byId).toEqual({ 2: { id: 2 } }));
    await act(async () => old.resolve(ok({ id: 1 })));
    expect(result.current.byId).toEqual({ 2: { id: 2 } });
  });

  it("does not refetch for a new array with the same ids", async () => {
    vi.mocked(apiClient.GET).mockResolvedValue(ok({ id: 1 }));
    const { result, rerender } = renderHook(({ ids }) => useCompareMetrics(ids), { initialProps: { ids: [1, 2] } });
    await waitFor(() => expect(result.current.loading).toBe(false));
    rerender({ ids: [1, 2] });
    expect(apiClient.GET).toHaveBeenCalledTimes(2);
  });

  it("ignores answers after unmount", async () => {
    const d = deferred<never>();
    vi.mocked(apiClient.GET).mockReturnValue(d.promise as never);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { result, unmount } = renderHook(() => useCompareMetrics([1]));
    const before = result.current;
    unmount();
    await act(async () => d.resolve(ok({ id: 1 })));
    expect(result.current).toBe(before);
    expect(errorSpy).not.toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it("is loading on the very first render and right after the ids change", async () => {
    vi.mocked(apiClient.GET).mockResolvedValue(ok({ id: 1 }));
    const { result, rerender } = renderHook(({ ids }) => useCompareMetrics(ids), { initialProps: { ids: [1] } });
    expect(result.current.loading).toBe(true);
    await waitFor(() => expect(result.current.loading).toBe(false));
    rerender({ ids: [2] });
    expect(result.current.loading).toBe(true);
    await waitFor(() => expect(result.current.loading).toBe(false));
  });
});
