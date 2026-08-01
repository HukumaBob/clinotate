import { useEffect, useState } from "react";

import { useUpdateSequence } from "../../entities/useSequences";
import type { components } from "../../shared/api/generated/schema";
import { CropFields, ZERO_CROP, type Crop } from "./CropFields";

type SequenceRead = components["schemas"]["SequenceRead"];

export function RecutSequenceForm({
  sequence,
  markStart,
  markEnd,
  onCropChange,
  onDone,
}: {
  sequence: SequenceRead;
  markStart: number;
  markEnd: number;
  onCropChange: (crop: Crop) => void;
  onDone: () => void;
}) {
  const [fps, setFps] = useState<number | "">("");
  const [crop, setCrop] = useState<Crop>(
    (sequence.crop_box as Crop | null) ?? ZERO_CROP
  );
  const [confirming, setConfirming] = useState(false);
  const updateSequence = useUpdateSequence();

  useEffect(() => {
    onCropChange(crop);
  }, [crop, onCropChange]);

  const startTime = Math.round(Math.min(markStart, markEnd));
  const duration = Math.round(Math.abs(markEnd - markStart));

  function handleRecutClick(event: React.FormEvent) {
    event.preventDefault();
    setConfirming(true);
  }

  function handleConfirm() {
    if (fps === "") return;
    updateSequence.mutate(
      { sequenceId: sequence.id, startTime, duration, fps, crop },
      {
        onSuccess: () => onDone(),
        onError: () => setConfirming(false),
      }
    );
  }

  return (
    <form onSubmit={handleRecutClick} className="flex flex-col gap-3 rounded border border-gray-800 bg-gray-900 p-4">
      <CropFields crop={crop} onChange={setCrop} />
      <p className="text-sm text-gray-400">
        New range: {startTime}s – {startTime + duration}s ({duration}s)
      </p>
      <label className="flex w-24 flex-col gap-1 text-sm text-gray-300">
        FPS
        <input
          type="number"
          value={fps}
          onChange={(e) => setFps(e.target.value === "" ? "" : Number(e.target.value))}
          className="rounded border border-gray-700 bg-gray-800 px-3 py-2 text-gray-100"
          required
        />
      </label>
      {sequence.annotation_count > 0 && (
        <p className="text-sm text-red-400">
          This will delete {sequence.annotation_count} annotation{sequence.annotation_count === 1 ? "" : "s"} on this
          sequence&apos;s current frames.
        </p>
      )}
      {updateSequence.isError && (
        <p className="text-sm text-red-400">Re-cut failed. Please try again.</p>
      )}
      {!confirming ? (
        <div className="flex gap-2">
          <button
            type="submit"
            disabled={fps === ""}
            className="rounded bg-blue-600 px-3 py-2 font-medium text-white hover:bg-blue-500 disabled:opacity-50"
          >
            Re-cut
          </button>
          <button
            type="button"
            onClick={onDone}
            className="rounded border border-gray-700 px-3 py-2 text-sm hover:bg-gray-800"
          >
            Close
          </button>
        </div>
      ) : (
        <div className="flex gap-2">
          <button
            type="button"
            onClick={handleConfirm}
            disabled={updateSequence.isPending}
            className="rounded bg-red-600 px-3 py-2 font-medium text-white hover:bg-red-500 disabled:opacity-50"
          >
            Confirm
          </button>
          <button
            type="button"
            onClick={() => setConfirming(false)}
            className="rounded border border-gray-700 px-3 py-2 text-sm hover:bg-gray-800"
          >
            Cancel
          </button>
        </div>
      )}
    </form>
  );
}
