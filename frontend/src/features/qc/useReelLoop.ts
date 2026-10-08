import { useEffect } from "react";

import type { Reel } from "./reels";

/** Slack before the clip start, so a seek that lands a hair early is not fought. */
const BEFORE_START_SLACK_MS = 250;

/** Keeps the video inside `reel`: at the end, or when scrubbed out before the
 * start, it returns to the clip start. A rAF loop like PredictionOverlay's, so
 * playback, pausing and scrubbing share one mechanism. */
export function useReelLoop(
  videoRef: React.RefObject<HTMLVideoElement | null>,
  reel: Pick<Reel, "startMs" | "endMs"> | null,
): void {
  const startMs = reel?.startMs;
  const endMs = reel?.endMs;

  useEffect(() => {
    if (startMs === undefined || endMs === undefined) return;
    let handle = 0;

    function tick() {
      const el = videoRef.current;
      if (el) {
        const nowMs = el.currentTime * 1000;
        if (nowMs >= endMs! || nowMs < startMs! - BEFORE_START_SLACK_MS) {
          el.currentTime = startMs! / 1000;
        }
      }
      handle = requestAnimationFrame(tick);
    }

    handle = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(handle);
  }, [videoRef, startMs, endMs]);
}
