import { useEffect, useState } from "react";

/** The video's current time in milliseconds, for the strip's playhead. A
 * rAF loop reads it and sets state only when it changed, which covers
 * playback, pausing and scrubbing with one mechanism (the same approach as
 * PredictionOverlay). Used inside the strip only, so only the strip
 * re-renders while the video plays. */
export function useVideoClock(videoRef: React.RefObject<HTMLVideoElement | null>): number {
  const [timeMs, setTimeMs] = useState(0);

  useEffect(() => {
    let handle = 0;
    let last = -1;

    function tick() {
      const video = videoRef.current;
      if (video) {
        const now = Math.round(video.currentTime * 1000);
        if (now !== last) {
          last = now;
          setTimeMs(now);
        }
      }
      handle = requestAnimationFrame(tick);
    }

    handle = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(handle);
  }, [videoRef]);

  return timeMs;
}
