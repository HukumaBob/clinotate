export type Crop = { left: number; right: number; top: number; bottom: number };

export const ZERO_CROP: Crop = { left: 0, right: 0, top: 0, bottom: 0 };

export function CropFields({
  crop,
  onChange,
}: {
  crop: Crop;
  onChange: (crop: Crop) => void;
}) {
  return (
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
            className="w-20 rounded border border-gray-700 bg-gray-900 px-2 py-1.5 text-sm text-gray-100 focus:border-blue-500 focus:outline-none"
          />
        </label>
      ))}
    </div>
  );
}
