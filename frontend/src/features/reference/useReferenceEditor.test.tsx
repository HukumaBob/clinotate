import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { type ReferenceInterval, type ReferenceRead, useReference } from "../../entities/useReference";
import { apiClient } from "../../shared/api/client";
import { useReferenceEditor } from "./useReferenceEditor";

vi.mock("../../shared/api/client", () => ({
  apiClient: { GET: vi.fn(), POST: vi.fn(), PATCH: vi.fn(), DELETE: vi.fn() },
}));

const DURATION = 10000;

function iv(id: number, categoryId: number, labelId: number, start: number, end: number): ReferenceInterval {
  return { id, video_id: 5, category_id: categoryId, label_id: labelId, taxonomy_version: 1, start_ms: start, end_ms: end, orphaned: false };
}

const AXES: ReferenceRead["axes"] = [
  { category_id: 2, name: "Location", classes: [{ label_id: 10, name: "Antrum", key: "1" }, { label_id: 11, name: "Body", key: "2" }] },
  { category_id: 3, name: "Quality", classes: [{ label_id: 20, name: "Good", key: "3" }, { label_id: 21, name: "Bad", key: "4" }] },
];
const CATEGORY_OF: Record<number, number> = { 10: 2, 11: 2, 20: 3, 21: 3 };

type Body = { label_id?: number; start_ms?: number; end_ms?: number };
type Opts = { params: { path: { interval_id?: number } }; body?: Body };

/** A tiny in-memory server behind the mocked apiClient. */
function setup(initial: ReferenceInterval[] = [], options: { holdCreate?: boolean; holdPatch?: boolean } = {}) {
  let rows = [...initial];
  let nextId = 100;
  const heldCreates: (() => void)[] = [];
  const heldPatches: (() => void)[] = [];
  const doc = (): ReferenceRead => ({
    video_id: 5, procedure_id: 1, duration_ms: DURATION, status: "clean", compromised_at: null,
    compromised_by_training_run_id: null, axes: AXES, intervals: rows,
  });
  vi.mocked(apiClient.GET).mockImplementation((async () => ({ data: doc() })) as never);
  vi.mocked(apiClient.POST).mockImplementation((async (_path: string, opts: Opts) => {
    const body = opts.body as Required<Body>;
    const category = CATEGORY_OF[body.label_id];
    if (rows.some((r) => r.category_id === category && r.start_ms < body.end_ms && body.start_ms < r.end_ms)) {
      return { error: { detail: "overlap" } };
    }
    const created = iv(nextId++, category, body.label_id, body.start_ms, body.end_ms);
    if (options.holdCreate) await new Promise<void>((resolve) => heldCreates.push(resolve));
    rows = [...rows, created];
    return { data: created };
  }) as never);
  vi.mocked(apiClient.PATCH).mockImplementation((async (_path: string, opts: Opts) => {
    const id = opts.params.path.interval_id;
    const body = opts.body ?? {};
    if (options.holdPatch) await new Promise<void>((resolve) => heldPatches.push(resolve));
    rows = rows.map((r) => r.id === id
      ? { ...r, label_id: body.label_id ?? r.label_id, start_ms: body.start_ms ?? r.start_ms, end_ms: body.end_ms ?? r.end_ms }
      : r);
    return { data: rows.find((r) => r.id === id) };
  }) as never);
  vi.mocked(apiClient.DELETE).mockImplementation((async (_path: string, opts: Opts) => {
    rows = rows.filter((r) => r.id !== opts.params.path.interval_id);
    return { data: undefined };
  }) as never);

  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  queryClient.setQueryData(["reference", 5], doc());
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  const video = document.createElement("video");
  Object.defineProperty(video, "currentTime", { value: 0, writable: true });
  const videoRef = { current: video };
  const hook = renderHook(() => {
    const { data } = useReference(5);
    return useReferenceEditor({ videoRef, reference: data, durationMs: DURATION });
  }, { wrapper });
  const at = (seconds: number) => { video.currentTime = seconds; };
  const tick = (seconds: number) => {
    video.currentTime = seconds;
    act(() => { video.dispatchEvent(new Event("timeupdate")); });
  };
  const press = (code: string, target: Element | Window = window) => {
    act(() => { fireEvent.keyDown(target, { code, key: code.replace(/^(Digit|Numpad)/, "") }); });
  };
  const releasePatches = async () => {
    await act(async () => { heldPatches.splice(0).forEach((release) => release()); });
  };
  const releaseCreates = async () => {
    await act(async () => { heldCreates.splice(0).forEach((release) => release()); });
  };
  return { ...hook, at, tick, press, releaseCreates, releasePatches, video };
}

const patches = () => vi.mocked(apiClient.PATCH).mock.calls.map((c) => (c[1] as Opts).body);
const posts = () => vi.mocked(apiClient.POST).mock.calls.map((c) => (c[1] as Opts).body);

// Unmounting flushes pending edits; let those settle before the next test so
// they do not show up in its mock calls.
afterEach(async () => {
  cleanup();
  vi.useRealTimers();
  await new Promise((resolve) => setTimeout(resolve, 10));
  vi.clearAllMocks();
  document.body.innerHTML = "";
});

describe("useReferenceEditor", () => {
  it("a mapped digit starts an interval and creates it with end = start + 100", async () => {
    const { result, at, press } = setup();
    at(2); press("Digit1");
    expect(result.current.growing[2]).toMatchObject({ labelId: 10, startMs: 2000 });
    await waitFor(() => expect(posts()).toEqual([{ label_id: 10, start_ms: 2000, end_ms: 2100 }]));
    await waitFor(() => expect(result.current.growing[2]?.id).toBe(100));
  });

  it("the same digit again closes the interval at the current time and saves the end", async () => {
    const { result, at, press } = setup();
    at(2); press("Digit1");
    await waitFor(() => expect(result.current.growing[2]?.id).toBe(100));
    at(5); press("Digit1");
    expect(result.current.growing[2]).toBeUndefined();
    await waitFor(() => expect(patches()).toContainEqual({ end_ms: 5000 }));
    expect(result.current.intervals).toContainEqual({ id: 100, categoryId: 2, labelId: 10, startMs: 2000, endMs: 5000 });
  });

  it("an update for an interval still being created waits for its server id", async () => {
    const { result, at, press, releaseCreates } = setup([], { holdCreate: true });
    at(2); press("Digit1"); at(5); press("Digit1");
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
    expect(apiClient.PATCH).not.toHaveBeenCalled();
    expect(result.current.intervals).toContainEqual(expect.objectContaining({ startMs: 2000, endMs: 5000 }));
    await releaseCreates();
    await waitFor(() => expect(apiClient.PATCH).toHaveBeenCalledTimes(1));
    expect(vi.mocked(apiClient.PATCH).mock.calls[0][1]).toMatchObject({ params: { path: { interval_id: 100 } }, body: { end_ms: 5000 } });
  });

  it("another digit of the same axis closes the growing interval and starts the next one", async () => {
    const { result, at, press } = setup();
    at(2); press("Digit1");
    await waitFor(() => expect(result.current.growing[2]?.id).toBe(100));
    at(4); press("Digit2");
    expect(result.current.growing[2]).toMatchObject({ labelId: 11, startMs: 4000 });
    await waitFor(() => expect(patches()).toContainEqual({ end_ms: 4000 }));
    await waitFor(() => expect(posts()).toContainEqual({ label_id: 11, start_ms: 4000, end_ms: 4100 }));
  });

  it("a digit of the other axis does not touch the first axis", async () => {
    const { result, at, press } = setup();
    at(2); press("Digit1"); at(3); press("Digit3");
    expect(result.current.growing[2]).toMatchObject({ labelId: 10, startMs: 2000 });
    expect(result.current.growing[3]).toMatchObject({ labelId: 20, startMs: 3000 });
    await waitFor(() => expect(posts()).toHaveLength(2));
  });

  it("digits typed into an input do nothing", () => {
    const { result, at, press } = setup();
    const input = document.createElement("input");
    document.body.appendChild(input); input.focus();
    at(2); press("Digit1", input);
    expect(result.current.growing[2]).toBeUndefined();
    expect(apiClient.POST).not.toHaveBeenCalled();
  });

  it("held-key repeats and modified keys are ignored; numpad digits work", () => {
    const { result, at, press } = setup();
    at(2);
    act(() => {
      fireEvent.keyDown(window, { code: "Digit1", key: "1", repeat: true });
      fireEvent.keyDown(window, { code: "Digit1", key: "1", ctrlKey: true });
    });
    expect(result.current.growing[2]).toBeUndefined();
    press("Numpad1");
    expect(result.current.growing[2]).toMatchObject({ labelId: 10 });
  });

  it("Escape closes every growing interval", async () => {
    const { result, at, press } = setup();
    at(2); press("Digit1"); press("Digit3");
    await waitFor(() => expect(result.current.growing[3]?.id).toBe(101));
    at(6);
    act(() => { fireEvent.keyDown(window, { key: "Escape", code: "Escape" }); });
    expect(result.current.growing).toEqual({});
    await waitFor(() => expect(patches()).toEqual([{ end_ms: 6000 }, { end_ms: 6000 }]));
  });

  it("Delete removes the selected interval", async () => {
    const { result } = setup([iv(1, 2, 10, 0, 1000)]);
    act(() => result.current.select(1));
    expect(result.current.selectedId).toBe(1);
    act(() => { fireEvent.keyDown(window, { key: "Delete", code: "Delete" }); });
    expect(result.current.intervals).toEqual([]);
    expect(result.current.selectedId).toBeNull();
    await waitFor(() => expect(apiClient.DELETE).toHaveBeenCalledTimes(1));
  });

  it("a digit with a selected interval and nothing growing relabels it", async () => {
    const { result, at, press } = setup([iv(1, 2, 10, 0, 1000)]);
    act(() => result.current.select(1));
    at(5); press("Digit2");
    expect(result.current.growing[2]).toBeUndefined();
    expect(result.current.intervals[0]).toMatchObject({ id: 1, labelId: 11 });
    await waitFor(() => expect(patches()).toEqual([{ label_id: 11 }]));
  });

  it("the growing end follows the playhead but never passes the next interval's start", async () => {
    const { result, at, tick, press } = setup([iv(1, 2, 11, 5000, 6000)]);
    at(2); press("Digit1");
    tick(3.5);
    expect(result.current.growing[2]?.endMs).toBe(3500);
    tick(8);
    expect(result.current.growing[2]?.endMs).toBe(5000);
  });

  it("a failed create sets saveState to error and rolls the interval back", async () => {
    const { result, at, press } = setup();
    vi.mocked(apiClient.POST).mockResolvedValue({ error: { detail: "overlap" } } as never);
    at(2); press("Digit1");
    await waitFor(() => expect(result.current.saveState).toBe("error"));
    expect(result.current.growing[2]).toBeUndefined();
    expect(result.current.intervals).toEqual([]);
  });

  it("a failed delete restores the interval", async () => {
    const { result } = setup([iv(1, 2, 10, 0, 1000)]);
    vi.mocked(apiClient.DELETE).mockResolvedValue({ error: { detail: "nope" } } as never);
    act(() => result.current.select(1));
    act(() => result.current.deleteSelected());
    expect(result.current.intervals).toEqual([]);
    await waitFor(() => expect(result.current.saveState).toBe("error"));
    expect(result.current.intervals).toEqual([{ id: 1, categoryId: 2, labelId: 10, startMs: 0, endMs: 1000 }]);
  });

  it("sends at most one PATCH per second while the playhead advances", async () => {
    vi.useFakeTimers();
    const { result, at, tick, press } = setup();
    at(1); press("Digit1");
    await act(async () => { await vi.advanceTimersByTimeAsync(50); });
    expect(result.current.growing[2]?.id).toBe(100);
    for (let i = 1; i <= 30; i += 1) {
      tick(1 + i * 0.1);
      await act(async () => { await vi.advanceTimersByTimeAsync(100); });
    }
    const count = vi.mocked(apiClient.PATCH).mock.calls.length;
    expect(count).toBeGreaterThanOrEqual(2);
    expect(count).toBeLessThanOrEqual(3);
  });

  it("pagehide flushes the last end at once", async () => {
    vi.useFakeTimers();
    const { result, at, tick, press } = setup();
    at(2); press("Digit1");
    await act(async () => { await vi.advanceTimersByTimeAsync(50); });
    expect(result.current.growing[2]?.id).toBe(100);
    tick(3.4);
    act(() => { window.dispatchEvent(new Event("pagehide")); });
    await act(async () => { await vi.advanceTimersByTimeAsync(10); });
    expect(patches()).toEqual([{ end_ms: 3400 }]);
  });

  it("dragging an edge moves it and seeks the video there", async () => {
    const { result, video } = setup([iv(1, 2, 10, 0, 1000)]);
    act(() => result.current.dragEdge(1, "end", 2500));
    expect(video.currentTime).toBe(2.5);
    expect(result.current.intervals[0]).toMatchObject({ id: 1, endMs: 2500 });
  });

  it("a create after an unsaved edge drag waits for that PATCH (no overlap 409)", async () => {
    const { result, at, press, releasePatches } = setup([iv(1, 2, 10, 0, 5000)], { holdPatch: true });
    act(() => result.current.select(1));
    act(() => result.current.dragEdge(1, "end", 3000));
    act(() => result.current.select(null));
    at(3);
    press("Digit2");
    expect(result.current.growing[2]).toMatchObject({ labelId: 11, startMs: 3000 });
    await waitFor(() => expect(apiClient.PATCH).toHaveBeenCalledTimes(1));
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
    expect(apiClient.POST).not.toHaveBeenCalled();
    await releasePatches();
    await waitFor(() => expect(posts()).toEqual([{ label_id: 11, start_ms: 3000, end_ms: 3100 }]));
    await waitFor(() => expect(result.current.growing[2]?.id).toBe(100));
    expect(result.current.saveState).not.toBe("error");
  });

  it("Backspace also deletes the selected interval", async () => {
    const { result } = setup([iv(1, 2, 10, 0, 1000)]);
    act(() => result.current.select(1));
    act(() => { fireEvent.keyDown(window, { key: "Backspace", code: "Backspace" }); });
    expect(result.current.intervals).toEqual([]);
    await waitFor(() => expect(apiClient.DELETE).toHaveBeenCalledTimes(1));
  });

  it("Backspace in an input or with a modifier does not delete", () => {
    const { result } = setup([iv(1, 2, 10, 0, 1000)]);
    act(() => result.current.select(1));
    const input = document.createElement("input");
    document.body.appendChild(input);
    act(() => {
      fireEvent.keyDown(input, { key: "Backspace", code: "Backspace" });
      fireEvent.keyDown(window, { key: "Backspace", code: "Backspace", metaKey: true });
    });
    expect(result.current.intervals).toHaveLength(1);
    expect(apiClient.DELETE).not.toHaveBeenCalled();
  });
});
