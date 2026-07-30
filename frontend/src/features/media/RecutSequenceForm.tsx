import { useState } from "react";

import { useUpdateSequence } from "../../entities/useSequences";
import type { components } from "../../shared/api/generated/schema";

type SequenceRead = components["schemas"]["SequenceRead"];

export function RecutSequenceForm({
  sequence,
  markStart,
  markEnd,
  onDone,
}: {
  sequence: SequenceRead;
  markStart: number;
  markEnd: number;
  onDone: () => void;
}) {
  const [fps, setFps] = useState<number | "">("");
  const [confirming, setConfirming] = useState(false);
  const updateSequence = useUpdateSequence();

  const startTime = Math.round(Math.min(markStart, markEnd));
  const duration = Math.round(Math.abs(markEnd - markStart));

  function handleRecutClick(event: React.FormEvent) {
    event.preventDefault();
    setConfirming(true);
  }

  function handleConfirm() {
    if (fps === "") return;
    updateSequence.mutate(
      { sequenceId: sequence.id, startTime, duration, fps },
      { onSuccess: () => onDone() }
    );
  }

  return (
    <form onSubmit={handleRecutClick} className="flex flex-col gap-3 rounded border border-gray-800 bg-gray-900 p-4">
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
        />
      </label>
      {sequence.annotation_count > 0 && (
        <p className="text-sm text-red-400">
          This will delete {sequence.annotation_count} annotation{sequence.annotation_count === 1 ? "" : "s"} on this
          sequence&apos;s current frames.
        </p>
      )}
      {!confirming ? (
        <button
          type="submit"
          disabled={fps === ""}
          className="rounded bg-blue-600 px-3 py-2 font-medium text-white hover:bg-blue-500 disabled:opacity-50"
        >
          Re-cut
        </button>
      ) : (
        <div className="flex gap-2">
          <button
            type="button"
            onClick={handleConfirm}
            className="rounded bg-red-600 px-3 py-2 font-medium text-white hover:bg-red-500"
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
