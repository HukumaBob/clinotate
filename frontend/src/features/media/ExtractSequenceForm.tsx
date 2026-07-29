import { useEffect, useState } from "react";

import { useProcedures } from "../../entities/useProcedures";
import { useCreateSequenceFromVideo } from "../../entities/useSequences";
import { useSuggestSequenceName } from "../../entities/useSuggestSequenceName";

export function ExtractSequenceForm({
  videoId,
  onCreated,
}: {
  videoId: number;
  onCreated: (sequenceId: number) => void;
}) {
  const proceduresQuery = useProcedures();
  const [procedureId, setProcedureId] = useState<number | undefined>(undefined);
  const suggestedNameQuery = useSuggestSequenceName(procedureId);
  const [name, setName] = useState("");
  const [startTime, setStartTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [fps, setFps] = useState(1);
  const [cropOpen, setCropOpen] = useState(false);
  const [crop, setCrop] = useState({ left: 0, right: 0, top: 0, bottom: 0 });
  const createSequence = useCreateSequenceFromVideo();

  useEffect(() => {
    if (procedureId === undefined && proceduresQuery.data && proceduresQuery.data.length > 0) {
      setProcedureId(proceduresQuery.data[0].id);
    }
  }, [procedureId, proceduresQuery.data]);

  useEffect(() => {
    if (suggestedNameQuery.data?.name) {
      setName(suggestedNameQuery.data.name);
    }
  }, [suggestedNameQuery.data?.name]);

  function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    createSequence.mutate(
      { videoId, name, startTime, duration, fps, crop },
      {
        onSuccess: (sequence) => {
          if (sequence) onCreated(sequence.id);
        },
      }
    );
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-3 rounded border border-gray-800 bg-gray-900 p-4">
      <label className="flex flex-col gap-1 text-sm text-gray-300">
        Procedure
        <select
          value={procedureId ?? ""}
          onChange={(e) => setProcedureId(e.target.value ? Number(e.target.value) : undefined)}
          className="rounded border border-gray-700 bg-gray-800 px-3 py-2 text-gray-100"
          required
        >
          <option value="" disabled>
            Select a procedure
          </option>
          {(proceduresQuery.data ?? []).map((procedure) => (
            <option key={procedure.id} value={procedure.id}>
              {procedure.name}
            </option>
          ))}
        </select>
      </label>
      <label className="flex flex-col gap-1 text-sm text-gray-300">
        Name
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          className="rounded border border-gray-700 bg-gray-800 px-3 py-2 text-gray-100"
          required
        />
      </label>
      <div className="flex gap-3">
        <label className="flex flex-col gap-1 text-sm text-gray-300">
          Start (s)
          <input
            type="number"
            value={startTime}
            onChange={(e) => setStartTime(Number(e.target.value))}
            className="w-24 rounded border border-gray-700 bg-gray-800 px-3 py-2 text-gray-100"
          />
        </label>
        <label className="flex flex-col gap-1 text-sm text-gray-300">
          Duration (s)
          <input
            type="number"
            value={duration}
            onChange={(e) => setDuration(Number(e.target.value))}
            className="w-24 rounded border border-gray-700 bg-gray-800 px-3 py-2 text-gray-100"
          />
        </label>
        <label className="flex flex-col gap-1 text-sm text-gray-300">
          FPS
          <input
            type="number"
            value={fps}
            onChange={(e) => setFps(Number(e.target.value))}
            className="w-24 rounded border border-gray-700 bg-gray-800 px-3 py-2 text-gray-100"
          />
        </label>
      </div>
      <button type="button" onClick={() => setCropOpen((open) => !open)} className="text-left text-sm text-blue-400">
        {cropOpen ? "▾" : "▸"} Crop box
      </button>
      {cropOpen && (
        <div className="flex gap-3">
          {(["left", "right", "top", "bottom"] as const).map((side) => (
            <label key={side} className="flex flex-col gap-1 text-sm text-gray-300">
              {side} %
              <input
                type="number"
                value={crop[side]}
                onChange={(e) => setCrop((c) => ({ ...c, [side]: Number(e.target.value) }))}
                className="w-20 rounded border border-gray-700 bg-gray-800 px-3 py-2 text-gray-100"
              />
            </label>
          ))}
        </div>
      )}
      <button
        type="submit"
        className="rounded bg-blue-600 px-3 py-2 font-medium text-white hover:bg-blue-500"
      >
        Create sequence
      </button>
    </form>
  );
}
