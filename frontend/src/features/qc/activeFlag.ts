import { useEffect, useState } from "react";

/** How far the playhead may be from a flag and still count as sitting on it:
 * covers the rounding of `currentTime` to whole milliseconds. */
const TOLERANCE_MS = 40;

export function flagAtTime(
  flags: { id: number; timestamp_ms: number }[],
  timeMs: number,
): number | null {
  return flags.find((f) => Math.abs(f.timestamp_ms - timeMs) <= TOLERANCE_MS)?.id ?? null;
}

/** The id of the flag the video is parked on, for highlighting it in the
 * list. State changes only when the id does, so playback does not re-render
 * the page every frame. */
export function useActiveFlagId(
  videoRef: React.RefObject<HTMLVideoElement | null>,
  flags: { id: number; timestamp_ms: number }[],
): number | null {
  const [activeId, setActiveId] = useState<number | null>(null);

  useEffect(() => {
    let handle = 0;
    function tick() {
      const video = videoRef.current;
      if (video) setActiveId(flagAtTime(flags, video.currentTime * 1000));
      handle = requestAnimationFrame(tick);
    }
    handle = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(handle);
  }, [videoRef, flags]);

  return activeId;
}
