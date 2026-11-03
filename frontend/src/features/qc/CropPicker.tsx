import { useEffect, useRef, useState } from "react";

import { useDetectCrop } from "../../entities/useDetectCrop";
import { useVideoSequences } from "../../entities/useSequences";
import { useVideo } from "../../entities/useVideo";
import { computeVideoMediaRect } from "../media/computeVideoMediaRect";
import { CropFields, type Crop } from "../media/CropFields";
import { CropOverlay } from "../media/CropOverlay";
import { mostRecentCrop } from "../media/mostRecentCrop";

type MediaRect = { left: number; top: number; width: number; height: number };

/** Chooses the working area of a run: the part of the picture the model sees.
 * Starts from the video's latest sequence crop; "Detect automatically" asks
 * the backend for a proposal the user can still edit. */
export function CropPicker({
  videoId,
  crop,
  onChange,
}: {
  videoId: number;
  crop: Crop;
  onChange: (crop: Crop) => void;
}) {
  const video = useVideo(videoId).data;
  const sequences = useVideoSequences(videoId);
  const detect = useDetectCrop();
  const videoRef = useRef<HTMLVideoElement>(null);
  const [mediaRect, setMediaRect] = useState<MediaRect | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const suggested = useRef(false);

  useEffect(() => {
    if (suggested.current || !sequences.isSuccess) return;
    suggested.current = true;
    onChange(mostRecentCrop(sequences.data ?? []));
  }, [sequences.isSuccess, sequences.data, onChange]);

  function recomputeMediaRect() {
    const el = videoRef.current;
    if (!el) return;
    setMediaRect(computeVideoMediaRect(el.videoWidth, el.videoHeight, el.clientWidth, el.clientHeight));
  }

  useEffect(() => {
    window.addEventListener("resize", recomputeMediaRect);
    return () => window.removeEventListener("resize", recomputeMediaRect);
  }, []);

  async function handleDetect() {
    setMessage(null);
    try {
      const result = await detect.mutateAsync(videoId);
      if (result?.crop) onChange(result.crop);
      else setMessage("No border found");
    } catch {
      setMessage("Could not detect the border");
    }
  }

  const hasCrop = Object.values(crop).some((value) => value > 0);

  return (
    <div className="flex flex-col gap-2">
      <span className="text-sm text-gray-300">Working area</span>
      <div className="relative">
        {video && (
          <video
            ref={videoRef}
            src={video.stream_url}
            muted
            preload="metadata"
            className="max-h-[30vh] w-full rounded bg-black"
            onLoadedMetadata={recomputeMediaRect}
          />
        )}
        {hasCrop && <CropOverlay crop={crop} mediaRect={mediaRect ?? undefined} />}
      </div>
      <CropFields crop={crop} onChange={onChange} />
      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={handleDetect}
          disabled={detect.isPending}
          className="rounded border border-gray-700 px-3 py-1 text-sm text-gray-300 hover:text-white disabled:opacity-50"
        >
          Detect automatically
        </button>
        {message && <span className="text-sm text-gray-400">{message}</span>}
      </div>
    </div>
  );
}
