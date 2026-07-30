import { useEffect, useState } from "react";

import { useProcedures } from "../../entities/useProcedures";
import { useCreateSequenceFromVideo } from "../../entities/useSequences";
import { useSuggestSequenceName } from "../../entities/useSuggestSequenceName";
import type { components } from "../../shared/api/generated/schema";
import { CropFields, ZERO_CROP, type Crop } from "./CropFields";

type SequenceRead = components["schemas"]["SequenceRead"];

function mostRecentCrop(sequences: SequenceRead[]): Crop {
  const mostRecent = [...sequences].sort((a, b) => b.id - a.id)[0];
  return (mostRecent?.crop_box as Crop | null | undefined) ?? ZERO_CROP;
}

export function SequenceFromMarksForm({
  videoId,
  markStart,
  markEnd,
  procedureId: procedureIdProp,
  videoSrc,
  existingSequences,
  onCreated,
}: {
  videoId: number;
  markStart: number;
  markEnd: number;
  procedureId?: number;
  videoSrc: string;
  existingSequences: SequenceRead[];
  onCreated: () => void;
}) {
  const proceduresQuery = useProcedures();
  const [procedureId, setProcedureId] = useState<number | undefined>(procedureIdProp);
  const suggestedNameQuery = useSuggestSequenceName(procedureId);
  const [name, setName] = useState("");
  const [fps, setFps] = useState(1);
  const [crop, setCrop] = useState<Crop>(() => mostRecentCrop(existingSequences));
  const createSequence = useCreateSequenceFromVideo();

  useEffect(() => {
    if (
      procedureIdProp === undefined &&
      procedureId === undefined &&
      proceduresQuery.data &&
      proceduresQuery.data.length > 0
    ) {
      setProcedureId(proceduresQuery.data[0].id);
    }
  }, [procedureIdProp, procedureId, proceduresQuery.data]);

  useEffect(() => {
    if (suggestedNameQuery.data?.name) {
      setName(suggestedNameQuery.data.name);
    }
  }, [suggestedNameQuery.data?.name]);

  const startTime = Math.round(Math.min(markStart, markEnd));
  const duration = Math.round(Math.abs(markEnd - markStart));

  function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    createSequence.mutate(
      { videoId, name, procedureId, startTime, duration, fps, crop },
      {
        onSuccess: () => onCreated(),
      }
    );
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-3 rounded border border-gray-800 bg-gray-900 p-4">
      <CropFields crop={crop} onChange={setCrop} videoSrc={videoSrc} />
      <p className="text-sm text-gray-400">
        Range: {startTime}s – {startTime + duration}s ({duration}s)
      </p>
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
      <label className="flex w-24 flex-col gap-1 text-sm text-gray-300">
        FPS
        <input
          type="number"
          value={fps}
          onChange={(e) => setFps(Number(e.target.value))}
          className="rounded border border-gray-700 bg-gray-800 px-3 py-2 text-gray-100"
        />
      </label>
      {createSequence.isError && (
        <p className="text-sm text-red-400">Failed to create sequence. Please try again.</p>
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
