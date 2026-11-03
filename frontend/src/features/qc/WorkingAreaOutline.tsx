import { useEffect, useState } from "react";

import { computeVideoMediaRect } from "../media/computeVideoMediaRect";
import type { Crop } from "../media/CropFields";
import { CropOverlay } from "../media/CropOverlay";

type MediaRect = { left: number; top: number; width: number; height: number };

/** The run's working area, outlined over the full video. Sits in the same
 * `relative` wrapper as the <video>; the rect follows the letterboxing. */
export function WorkingAreaOutline({
  videoRef,
  crop,
}: {
  videoRef: React.RefObject<HTMLVideoElement | null>;
  // The API types crop_box as a loose object; its shape is the media CropBox.
  crop: object | null | undefined;
}) {
  const [mediaRect, setMediaRect] = useState<MediaRect | null>(null);

  useEffect(() => {
    const video = videoRef.current;
    if (!video || !crop) return;
    const recompute = () =>
      setMediaRect(
        computeVideoMediaRect(video.videoWidth, video.videoHeight, video.clientWidth, video.clientHeight),
      );
    recompute();
    video.addEventListener("loadedmetadata", recompute);
    window.addEventListener("resize", recompute);
    const observer = typeof ResizeObserver !== "undefined" ? new ResizeObserver(recompute) : null;
    observer?.observe(video);
    return () => {
      video.removeEventListener("loadedmetadata", recompute);
      window.removeEventListener("resize", recompute);
      observer?.disconnect();
    };
  }, [videoRef, crop]);

  if (!crop) return null;
  return <CropOverlay crop={crop as Crop} mediaRect={mediaRect ?? undefined} />;
}
