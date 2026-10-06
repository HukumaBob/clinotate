import { useEffect, useRef } from "react";

import { computeVideoMediaRect } from "../media/computeVideoMediaRect";
import { drawDetections } from "./drawDetections";
import { DISPLAY_CONFIDENCE_THRESHOLD, detectionsAt, type FrameIndex } from "./predictions";

interface PredictionOverlayProps {
  videoRef: React.RefObject<HTMLVideoElement | null>;
  index: FrameIndex;
  classes: string[];
}

/** A canvas laid exactly over the <video> element. A rAF loop redraws only
 * when the video time or the element size changed, which covers playback,
 * pausing and scrubbing with one mechanism. */
export function PredictionOverlay({ videoRef, index, classes }: PredictionOverlayProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    let frameHandle = 0;
    let lastKey = "";

    function tick() {
      const video = videoRef.current;
      const canvas = canvasRef.current;
      if (video && canvas) {
        const width = video.clientWidth;
        const height = video.clientHeight;
        const timeMs = Math.round(video.currentTime * 1000);
        const key = `${timeMs}|${width}|${height}|${video.videoWidth}|${video.videoHeight}`;
        if (key !== lastKey) {
          lastKey = key;
          if (canvas.width !== width) canvas.width = width;
          if (canvas.height !== height) canvas.height = height;
          const ctx = canvas.getContext("2d");
          const rect = computeVideoMediaRect(video.videoWidth, video.videoHeight, width, height);
          if (ctx && rect) {
            ctx.clearRect(0, 0, width, height);
            drawDetections(
              ctx,
              rect,
              detectionsAt(index, timeMs),
              classes,
              DISPLAY_CONFIDENCE_THRESHOLD,
            );
          }
        }
      }
      frameHandle = requestAnimationFrame(tick);
    }

    frameHandle = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frameHandle);
  }, [videoRef, index, classes]);

  return <canvas ref={canvasRef} className="pointer-events-none absolute inset-0 h-full w-full" />;
}
