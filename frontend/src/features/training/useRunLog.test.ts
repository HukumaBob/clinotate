import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { apiClient } from "../../shared/api/client";
import { deferred } from "./testDeferred";
import { useRunLog } from "./useRunLog";

vi.mock("../../shared/api/client", () => ({
  apiClient: { GET: vi.fn(), POST: vi.fn(), DELETE: vi.fn() },
}));

const ok = (data: unknown) => ({ data, error: undefined }) as never;
const args = (run_id: number, offset: number) => [
  "/training/runs/{run_id}/log",
  { params: { path: { run_id }, query: { offset } } },
];

describe("useRunLog", () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.mocked(apiClient.GET).mockReset();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("loads the log from offset 0", async () => {
    vi.mocked(apiClient.GET).mockResolvedValue(ok({ text: "abc", offset: 3, status: "succeeded" }));
    const { result } = renderHook(() => useRunLog(4, false));
    await waitFor(() => expect(result.current.text).toBe("abc"));
    expect(apiClient.GET).toHaveBeenCalledWith(...(args(4, 0) as [string, object]));
  });

  it("while active asks for the tail past the stored offset and appends", async () => {
    vi.mocked(apiClient.GET)
      .mockResolvedValueOnce(ok({ text: "abc", offset: 3, status: "running" }))
      .mockResolvedValueOnce(ok({ text: "def", offset: 6, status: "running" }))
      .mockResolvedValue(ok({ text: "", offset: 6, status: "running" }));
    const { result } = renderHook(() => useRunLog(4, true));
    await waitFor(() => expect(result.current.text).toBe("abc"));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2100);
    });
    await waitFor(() => expect(result.current.text).toBe("abcdef"));
    expect(apiClient.GET).toHaveBeenNthCalledWith(2, ...(args(4, 3) as [string, object]));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2100);
    });
    expect(apiClient.GET).toHaveBeenNthCalledWith(3, ...(args(4, 6) as [string, object]));
    expect(result.current.text).toBe("abcdef");
  });

  it("restarts from offset 0 when the server returns a smaller offset", async () => {
    vi.mocked(apiClient.GET)
      .mockResolvedValueOnce(ok({ text: "aaaaaaaaaa", offset: 10, status: "running" }))
      .mockResolvedValueOnce(ok({ text: "new", offset: 3, status: "running" }))
      .mockResolvedValueOnce(ok({ text: "newlog", offset: 6, status: "running" }))
      .mockResolvedValue(ok({ text: "", offset: 6, status: "running" }));
    const { result } = renderHook(() => useRunLog(4, true));
    await waitFor(() => expect(result.current.text).toBe("aaaaaaaaaa"));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2100);
    });
    await waitFor(() => expect(result.current.text).toBe("newlog"));
    expect(apiClient.GET).toHaveBeenNthCalledWith(2, ...(args(4, 10) as [string, object]));
    expect(apiClient.GET).toHaveBeenNthCalledWith(3, ...(args(4, 0) as [string, object]));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2100);
    });
    expect(apiClient.GET).toHaveBeenNthCalledWith(4, ...(args(4, 6) as [string, object]));
  });

  it("does not poll when inactive and stops when active flips to false", async () => {
    vi.mocked(apiClient.GET).mockResolvedValue(ok({ text: "x", offset: 1, status: "running" }));
    const { rerender } = renderHook(({ a }) => useRunLog(4, a), { initialProps: { a: true } });
    await waitFor(() => expect(apiClient.GET).toHaveBeenCalledTimes(1));
    rerender({ a: false });
    const count = vi.mocked(apiClient.GET).mock.calls.length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(6100);
    });
    expect(vi.mocked(apiClient.GET).mock.calls.length).toBe(count);
  });

  it("stops polling on unmount", async () => {
    vi.mocked(apiClient.GET).mockResolvedValue(ok({ text: "x", offset: 1, status: "running" }));
    const { unmount } = renderHook(() => useRunLog(4, true));
    await waitFor(() => expect(apiClient.GET).toHaveBeenCalledTimes(1));
    unmount();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(6100);
    });
    expect(apiClient.GET).toHaveBeenCalledTimes(1);
  });

  it("ignores a stale answer after the run id changed and resets text", async () => {
    const stale = deferred<unknown>();
    vi.mocked(apiClient.GET)
      .mockResolvedValueOnce(ok({ text: "one", offset: 3, status: "succeeded" }))
      .mockReturnValueOnce(stale.promise as never)
      .mockResolvedValueOnce(ok({ text: "three", offset: 5, status: "succeeded" }));
    const { result, rerender } = renderHook(({ id }) => useRunLog(id, false), { initialProps: { id: 1 } });
    await waitFor(() => expect(result.current.text).toBe("one"));
    rerender({ id: 2 });
    await waitFor(() => expect(result.current.text).toBe(""));
    rerender({ id: 3 });
    await waitFor(() => expect(result.current.text).toBe("three"));
    await act(async () => {
      stale.resolve(ok({ text: "LATE", offset: 4, status: "succeeded" }));
    });
    expect(result.current.text).toBe("three");
  });

  it("makes one final tail fetch from the stored offset when active flips to false", async () => {
    vi.mocked(apiClient.GET)
      .mockResolvedValueOnce(ok({ text: "abc", offset: 3, status: "running" }))
      .mockResolvedValueOnce(ok({ text: "def", offset: 6, status: "running" }))
      .mockResolvedValueOnce(ok({ text: "TAIL", offset: 10, status: "failed" }));
    const { result, rerender } = renderHook(({ a }) => useRunLog(4, a), { initialProps: { a: true } });
    await waitFor(() => expect(result.current.text).toBe("abc"));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2100);
    });
    await waitFor(() => expect(result.current.text).toBe("abcdef"));
    rerender({ a: false });
    await waitFor(() => expect(result.current.text).toBe("abcdefTAIL"));
    expect(apiClient.GET).toHaveBeenCalledTimes(3);
    expect(apiClient.GET).toHaveBeenNthCalledWith(3, ...(args(4, 6) as [string, object]));
  });

  it("makes no extra fetch when active was never true", async () => {
    vi.mocked(apiClient.GET).mockResolvedValue(ok({ text: "x", offset: 1, status: "succeeded" }));
    const { result, rerender } = renderHook(({ a }) => useRunLog(4, a), { initialProps: { a: false } });
    await waitFor(() => expect(result.current.text).toBe("x"));
    rerender({ a: false });
    await act(async () => {});
    expect(apiClient.GET).toHaveBeenCalledTimes(1);
  });

  it("makes no final fetch when the run id changes while active turns false", async () => {
    vi.mocked(apiClient.GET).mockResolvedValue(ok({ text: "x", offset: 1, status: "running" }));
    const { rerender } = renderHook(({ id, a }) => useRunLog(id, a), { initialProps: { id: 1, a: true } });
    await waitFor(() => expect(apiClient.GET).toHaveBeenCalledTimes(1));
    rerender({ id: 2, a: false });
    await waitFor(() => expect(apiClient.GET).toHaveBeenCalledTimes(2));
    await act(async () => {});
    expect(apiClient.GET).toHaveBeenCalledTimes(2);
    expect(apiClient.GET).toHaveBeenNthCalledWith(2, ...(args(2, 0) as [string, object]));
  });

  it("skips ticks while a request is pending, applies its answer, then requests again", async () => {
    const slow = deferred<unknown>();
    vi.mocked(apiClient.GET)
      .mockReturnValueOnce(slow.promise as never)
      .mockResolvedValue(ok({ text: "", offset: 3, status: "running" }));
    const { result } = renderHook(() => useRunLog(4, true));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(4100);
    });
    expect(apiClient.GET).toHaveBeenCalledTimes(1);
    await act(async () => {
      slow.resolve(ok({ text: "abc", offset: 3, status: "running" }));
    });
    await waitFor(() => expect(result.current.text).toBe("abc"));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2100);
    });
    expect(apiClient.GET).toHaveBeenCalledTimes(2);
    expect(apiClient.GET).toHaveBeenNthCalledWith(2, ...(args(4, 3) as [string, object]));
  });

  it("a pending request of the old run never blocks the new run", async () => {
    const slow = deferred<unknown>();
    vi.mocked(apiClient.GET)
      .mockReturnValueOnce(slow.promise as never)
      .mockResolvedValue(ok({ text: "new", offset: 3, status: "running" }));
    const { result, rerender } = renderHook(({ id }) => useRunLog(id, true), { initialProps: { id: 1 } });
    rerender({ id: 2 });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2100);
    });
    await waitFor(() => expect(apiClient.GET).toHaveBeenCalledTimes(3));
    expect(result.current.text).toBe("newnew");
  });

  it("a failed response sets error and keeps the old text", async () => {
    vi.mocked(apiClient.GET)
      .mockResolvedValueOnce(ok({ text: "abc", offset: 3, status: "running" }))
      .mockResolvedValueOnce({ data: undefined, error: { detail: "x" } } as never);
    const { result } = renderHook(() => useRunLog(4, true));
    await waitFor(() => expect(result.current.text).toBe("abc"));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2100);
    });
    await waitFor(() => expect(result.current.error).toBe(true));
    expect(result.current.text).toBe("abc");
  });

  it("makes no request and keeps empty text without a run id", () => {
    const { result } = renderHook(() => useRunLog(null, true));
    expect(result.current.text).toBe("");
    expect(apiClient.GET).not.toHaveBeenCalled();
  });

  it("flags an error when the request throws", async () => {
    vi.mocked(apiClient.GET).mockRejectedValue(new Error("x"));
    const { result } = renderHook(() => useRunLog(5, false));
    await waitFor(() => expect(result.current.error).toBe(true));
  });
});
