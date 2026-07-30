import { useState } from "react";

import { useProcedures } from "../../entities/useProcedures";
import { useUpdateSequence } from "../../entities/useSequences";
import type { components } from "../../shared/api/generated/schema";

type SequenceRead = components["schemas"]["SequenceRead"];

export function RenameSequenceForm({
  sequence,
  onDone,
}: {
  sequence: SequenceRead;
  onDone: () => void;
}) {
  const proceduresQuery = useProcedures();
  const [name, setName] = useState(sequence.name);
  const [procedureId, setProcedureId] = useState<number | undefined>(sequence.procedure_id ?? undefined);
  const updateSequence = useUpdateSequence();

  function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    updateSequence.mutate(
      { sequenceId: sequence.id, name, procedureId },
      { onSuccess: () => onDone() }
    );
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-3 rounded border border-gray-800 bg-gray-900 p-4">
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
      <label className="flex flex-col gap-1 text-sm text-gray-300">
        Procedure
        <select
          value={procedureId ?? ""}
          onChange={(e) => setProcedureId(e.target.value ? Number(e.target.value) : undefined)}
          className="rounded border border-gray-700 bg-gray-800 px-3 py-2 text-gray-100"
        >
          <option value="">None</option>
          {(proceduresQuery.data ?? []).map((procedure) => (
            <option key={procedure.id} value={procedure.id}>
              {procedure.name}
            </option>
          ))}
        </select>
      </label>
      <div className="flex gap-2">
        <button type="submit" className="rounded bg-blue-600 px-3 py-2 font-medium text-white hover:bg-blue-500">
          Save
        </button>
        <button
          type="button"
          onClick={onDone}
          className="rounded border border-gray-700 px-3 py-2 text-sm hover:bg-gray-800"
        >
          Cancel
        </button>
      </div>
    </form>
  );
}
