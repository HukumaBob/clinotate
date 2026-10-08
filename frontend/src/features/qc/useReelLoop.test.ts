import { renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { useReelLoop } from "./useReelLoop";

function video(currentTime: number) {
  const el = document.createElement("video");
  el.currentTime = currentTime;
  return el;
}

describe("useReelLoop", () => {
  it("returns to the clip start when playback reaches the end", async () => {
    const el = video(12);
    renderHook(() => useReelLoop({ current: el }, { startMs: 9_000, endMs: 11_000 }));
    await waitFor(() => expect(el.currentTime).toBe(9));
  });

  it("pulls the playhead back when the user scrubs before the clip", async () => {
    const el = video(1);
    renderHook(() => useReelLoop({ current: el }, { startMs: 9_000, endMs: 11_000 }));
    await waitFor(() => expect(el.currentTime).toBe(9));
  });

  it("leaves playback alone inside the clip", async () => {
    const el = video(10);
    renderHook(() => useReelLoop({ current: el }, { startMs: 9_000, endMs: 11_000 }));
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(el.currentTime).toBe(10);
  });

  it("does nothing without a clip or without a video", async () => {
    const el = video(50);
    renderHook(() => useReelLoop({ current: el }, null));
    renderHook(() => useReelLoop({ current: null }, { startMs: 0, endMs: 1 }));
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(el.currentTime).toBe(50);
  });

  it("stops looping when the clip is deselected", async () => {
    const el = video(10);
    const { rerender } = renderHook(
      ({ reel }: { reel: { startMs: number; endMs: number } | null }) => useReelLoop({ current: el }, reel),
      { initialProps: { reel: { startMs: 9_000, endMs: 11_000 } as { startMs: number; endMs: number } | null } },
    );
    rerender({ reel: null });
    el.currentTime = 30;
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(el.currentTime).toBe(30);
  });
});
