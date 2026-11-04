import { useEffect, useState } from "react";

import { useCropFrames, useDetectFramesCrop } from "../../entities/useFrameCrop";
import { CropFields, ZERO_CROP, type Crop } from "../media/CropFields";
import { CropOverlay } from "../media/CropOverlay";

interface FrameCropPanelProps {
  sequenceId: number;
  frameIds: number[];
  previewUrl: string | undefined;
  hasVideo: boolean;
  onClose: () => void;
}

type Preview = { key: string; frames: number; annotations: number; masksClipped: number };

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

const BUTTON = "rounded px-3 py-1.5 text-sm disabled:opacity-40";

/** Cuts the selected frames, and every mask on them, to one rectangle. The crop
 * cannot be undone, so Apply needs a preview of exactly this crop and selection
 * and a second, confirming click. */
export function FrameCropPanel({ sequenceId, frameIds, previewUrl, hasVideo, onClose }: FrameCropPanelProps) {
  const [crop, setCrop] = useState<Crop>(ZERO_CROP);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [armed, setArmed] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const cropFrames = useCropFrames();
  const detect = useDetectFramesCrop();

  // What the preview and the confirmation are valid for.
  const key = `${frameIds.join(",")}|${crop.left},${crop.right},${crop.top},${crop.bottom}`;
  const previewIsCurrent = preview !== null && preview.key === key;
  const hasCrop = Object.values(crop).some((value) => value > 0);

  useEffect(() => {
    setArmed(false);
  }, [key]);

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
    }
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  function changeCrop(next: Crop) {
    setCrop(next);
    setMessage(null);
    setError(null);
  }

  async function handleDetect() {
    setMessage(null);
    setError(null);
    try {
      const result = await detect.mutateAsync({ sequenceId, frameIds });
      if (result.crop) changeCrop(result.crop as Crop);
      else setMessage("No border found");
    } catch (caught) {
      setError((caught as Error).message);
    }
  }

  async function handlePreview() {
    setError(null);
    setMessage(null);
    try {
      const result = await cropFrames.mutateAsync({ sequenceId, frameIds, crop, dryRun: true });
      setPreview({
        key,
        frames: result.frames,
        annotations: result.annotations,
        masksClipped: result.masks_clipped,
      });
    } catch (caught) {
      setPreview(null);
      setError((caught as Error).message);
    }
  }

  async function handleApply() {
    if (!previewIsCurrent) return;
    if (!armed) {
      setArmed(true);
      return;
    }
    setArmed(false);
    setError(null);
    try {
      await cropFrames.mutateAsync({ sequenceId, frameIds, crop, dryRun: false });
      onClose();
    } catch (caught) {
      setError((caught as Error).message);
    }
  }

  const busy = cropFrames.isPending || detect.isPending;

  return (
    <div className="w-[28rem] space-y-3 rounded border border-gray-700 bg-gray-900 p-4 text-sm text-gray-200 shadow-xl">
      <div className="flex items-center justify-between">
        <h2 className="font-semibold">Crop {plural(frameIds.length, "selected frame")}</h2>
        <button type="button" onClick={onClose} className="text-gray-400 hover:text-gray-200">
          Close
        </button>
      </div>

      {previewUrl && (
        <div className="relative mx-auto w-full max-w-[16rem] bg-black">
          <img src={previewUrl} alt="First selected frame" className="block w-full" />
          {hasCrop && <CropOverlay crop={crop} />}
        </div>
      )}

      <CropFields crop={crop} onChange={changeCrop} />

      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={handleDetect}
          disabled={busy}
          className={`${BUTTON} border border-gray-700 text-gray-300 hover:text-white`}
        >
          Detect automatically
        </button>
        {message && <span className="text-gray-400">{message}</span>}
      </div>

      {hasVideo && (
        <p className="text-xs text-gray-500">
          Re-cutting this sequence from its video regenerates its frames and discards a crop made here.
        </p>
      )}

      {previewIsCurrent && preview && (
        <div className="space-y-1 rounded border border-gray-800 bg-gray-950 p-2 text-gray-300">
          <p>
            {plural(preview.frames, "frame")}, {plural(preview.annotations, "mask")} will be cut.
          </p>
          {preview.masksClipped > 0 && (
            <p className="text-amber-300">
              {plural(preview.masksClipped, "mask")} {preview.masksClipped === 1 ? "has" : "have"} pixels in the
              area being removed.
            </p>
          )}
        </div>
      )}

      {armed && (
        <p className="text-amber-300">
          This replaces the stored images and masks and cannot be undone.
        </p>
      )}
      {error && <p className="text-red-400">{error}</p>}

      <div className="flex gap-2">
        <button
          type="button"
          onClick={handlePreview}
          disabled={!hasCrop || busy}
          className={`${BUTTON} bg-gray-800 text-gray-200 hover:bg-gray-700`}
        >
          Preview
        </button>
        <button
          type="button"
          onClick={handleApply}
          disabled={!previewIsCurrent || busy}
          className={`${BUTTON} ${armed ? "bg-red-700 text-white" : "bg-gray-800 text-gray-200 hover:bg-gray-700"}`}
        >
          {armed && preview ? `Confirm crop of ${plural(preview.frames, "frame")}` : "Apply"}
        </button>
      </div>
    </div>
  );
}
