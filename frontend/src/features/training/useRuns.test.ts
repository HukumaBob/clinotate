import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { apiClient } from "../../shared/api/client";
import { deferred } from "./testDeferred";
import { useRuns } from "./useRuns";

vi.mock("../../shared/api/client", () => ({
  apiClient: { GET: vi.fn(), POST: vi.fn(), DELETE: vi.fn() },
}));

describe("useRuns", () => {
  beforeEach(() => {
    vi.mocked(apiClient.GET).mockReset();
  });

  it("requests the runs of the dataset, newest first from the server, with a limit", async () => {
    vi.mocked(apiClient.GET).mockResolvedValue({ data: [{ id: 2 }, { id: 1 }], error: undefined } as never);
    const { result } = renderHook(() => useRuns(496));
    await waitFor(() => expect(result.current.runs).toHaveLength(2));
    expect(apiClient.GET).toHaveBeenCalledWith("/training/runs", {
      params: { query: { dataset_id: 496, limit: 200 } },
    });
  });

  it("does nothing without a dataset", async () => {
    const { result } = renderHook(() => useRuns(null));
    expect(result.current.runs).toEqual([]);
    expect(result.current.loading).toBe(false);
    expect(apiClient.GET).not.toHaveBeenCalled();
  });

  it("empties the list when the dataset changes and ignores a late answer for the old one", async () => {
    const first = deferred<unknown>();
    const second = deferred<unknown>();
    vi.mocked(apiClient.GET)
      .mockReturnValueOnce(first.promise as never)
      .mockReturnValueOnce(second.promise as never);
    const { result, rerender } = renderHook(({ id }) => useRuns(id), { initialProps: { id: 1 } });
    rerender({ id: 2 });
    await act(async () => {
      second.resolve({ data: [{ id: 20 }], error: undefined });
    });
    await waitFor(() => expect(result.current.runs).toEqual([{ id: 20 }]));
    await act(async () => {
      first.resolve({ data: [{ id: 10 }], error: undefined });
    });
    expect(result.current.runs).toEqual([{ id: 20 }]);
    expect(result.current.loading).toBe(false);
  });

  it("clears the previous dataset's runs immediately on change", async () => {
    vi.mocked(apiClient.GET).mockResolvedValueOnce({ data: [{ id: 10 }], error: undefined } as never);
    const pending = deferred<unknown>();
    vi.mocked(apiClient.GET).mockReturnValueOnce(pending.promise as never);
    const { result, rerender } = renderHook(({ id }) => useRuns(id), { initialProps: { id: 1 } });
    await waitFor(() => expect(result.current.runs).toHaveLength(1));
    rerender({ id: 2 });
    await waitFor(() => expect(result.current.runs).toEqual([]));
  });

  it("reports a failed request", async () => {
    vi.mocked(apiClient.GET).mockResolvedValue({ data: undefined, error: { detail: "x" } } as never);
    const { result } = renderHook(() => useRuns(5));
    await waitFor(() => expect(result.current.error).toBe("Could not load runs."));
    expect(result.current.runs).toEqual([]);
  });

  it("reports a thrown request", async () => {
    vi.mocked(apiClient.GET).mockRejectedValue(new Error("network"));
    const { result } = renderHook(() => useRuns(5));
    await waitFor(() => expect(result.current.error).toBe("Could not load runs."));
    expect(result.current.loading).toBe(false);
  });

  it("refresh() reloads", async () => {
    vi.mocked(apiClient.GET).mockResolvedValueOnce({ data: [{ id: 1 }], error: undefined } as never);
    const { result } = renderHook(() => useRuns(5));
    await waitFor(() => expect(result.current.runs).toHaveLength(1));
    vi.mocked(apiClient.GET).mockResolvedValueOnce({ data: [{ id: 2 }, { id: 1 }], error: undefined } as never);
    await act(async () => {
      await result.current.refresh();
    });
    expect(result.current.runs).toHaveLength(2);
    expect(apiClient.GET).toHaveBeenCalledTimes(2);
  });
});
