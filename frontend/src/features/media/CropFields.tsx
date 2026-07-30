import { CropOverlay } from "./CropOverlay";

export type Crop = { left: number; right: number; top: number; bottom: number };

export const ZERO_CROP: Crop = { left: 0, right: 0, top: 0, bottom: 0 };

export function CropFields({
  crop,
  onChange,
  videoSrc,
}: {
  crop: Crop;
  onChange: (crop: Crop) => void;
  videoSrc: string;
}) {
  return (
    <>
      <div className="relative">
        <video
          src={videoSrc}
          muted
          preload="metadata"
          className="pointer-events-none max-h-[40vh] w-full rounded bg-black"
        />
        <CropOverlay crop={crop} />
      </div>
      <div className="flex gap-3">
        {(["left", "right", "top", "bottom"] as const).map((side) => (
          <label key={side} className="flex flex-col gap-1 text-sm text-gray-300">
            {side} %
            <input
              type="number"
              min={0}
              max={100}
              value={crop[side]}
              onChange={(e) => onChange({ ...crop, [side]: Number(e.target.value) })}
              className="w-20 rounded border border-gray-700 bg-gray-800 px-3 py-2 text-gray-100"
            />
          </label>
        ))}
      </div>
    </>
  );
}
