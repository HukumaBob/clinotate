import { useState } from "react";

import {
  useCreateProcedure,
  useDeleteProcedure,
  useProcedures,
  useUpdateProcedure,
} from "../../entities/useTaxonomy";

export function ProceduresPanel() {
  const proceduresQuery = useProcedures();
  const createProcedure = useCreateProcedure();
  const updateProcedure = useUpdateProcedure();
  const deleteProcedure = useDeleteProcedure();

  const [newName, setNewName] = useState("");
  const [createError, setCreateError] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editingName, setEditingName] = useState("");
  const [confirmingId, setConfirmingId] = useState<number | null>(null);
  const [errorsById, setErrorsById] = useState<Record<number, string>>({});

  const procedures = proceduresQuery.data ?? [];

  async function handleCreate() {
    if (!newName.trim()) {
      setCreateError("Name is required");
      return;
    }
    setCreateError(null);
    const result = await createProcedure.mutateAsync({ name: newName.trim() });
    if (result.error) {
      setCreateError((result.error as { detail?: string }).detail ?? "Create failed");
      return;
    }
    setNewName("");
  }

  async function handleSaveEdit(id: number) {
    if (!editingName.trim()) return;
    const result = await updateProcedure.mutateAsync({ procedureId: id, payload: { name: editingName.trim() } });
    if (result.error) {
      setErrorsById((errors) => ({ ...errors, [id]: (result.error as { detail?: string }).detail ?? "Save failed" }));
      return;
    }
    setErrorsById((errors) => ({ ...errors, [id]: "" }));
    setEditingId(null);
  }

  async function handleDelete(id: number) {
    const result = await deleteProcedure.mutateAsync(id);
    if (result.error) {
      setErrorsById((errors) => ({ ...errors, [id]: (result.error as { detail?: string }).detail ?? "Delete failed" }));
      return;
    }
    setErrorsById((errors) => ({ ...errors, [id]: "" }));
    setConfirmingId(null);
  }

  return (
    <div className="mb-4 shrink-0 rounded border border-gray-800 bg-gray-900 p-4 text-sm">
      <h2 className="mb-2 font-medium text-gray-200">Procedures</h2>
      <ul className="mb-3 flex flex-col gap-1">
        {procedures.map((procedure) => (
          <li key={procedure.id} className="flex items-center justify-between gap-2">
            {editingId === procedure.id ? (
              <>
                <input
                  className="flex-1 rounded border border-gray-700 bg-gray-950 px-2 py-1 text-gray-100"
                  value={editingName}
                  onChange={(e) => setEditingName(e.target.value)}
                />
                <div className="flex gap-2">
                  <button
                    type="button"
                    className="text-xs text-blue-400 hover:text-blue-300"
                    onClick={() => handleSaveEdit(procedure.id)}
                  >
                    Save
                  </button>
                  <button
                    type="button"
                    className="text-xs text-gray-400 hover:text-gray-300"
                    onClick={() => setEditingId(null)}
                  >
                    Cancel
                  </button>
                </div>
              </>
            ) : (
              <>
                <span className="text-gray-100">{procedure.name}</span>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    aria-label={`Edit ${procedure.name}`}
                    className="text-xs text-blue-400 hover:text-blue-300"
                    onClick={() => {
                      setEditingId(procedure.id);
                      setEditingName(procedure.name);
                    }}
                  >
                    Edit
                  </button>
                  {confirmingId === procedure.id ? (
                    <button
                      type="button"
                      aria-label={`Confirm delete ${procedure.name}`}
                      className="text-xs text-red-500 hover:text-red-400"
                      onClick={() => handleDelete(procedure.id)}
                    >
                      Confirm
                    </button>
                  ) : (
                    <button
                      type="button"
                      aria-label={`Delete ${procedure.name}`}
                      className="text-xs text-red-400 hover:text-red-300"
                      onClick={() => setConfirmingId(procedure.id)}
                    >
                      Delete
                    </button>
                  )}
                </div>
              </>
            )}
            {errorsById[procedure.id] && (
              <p className="w-full text-xs text-red-400">{errorsById[procedure.id]}</p>
            )}
          </li>
        ))}
      </ul>
      <div className="flex items-center gap-2">
        <input
          type="text"
          placeholder="New procedure…"
          className="rounded border border-gray-700 bg-gray-950 px-2 py-1 text-gray-100"
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
        />
        <button
          type="button"
          className="rounded bg-blue-600 px-2 py-1 text-xs text-white hover:bg-blue-500"
          onClick={handleCreate}
        >
          Add
        </button>
      </div>
      {createError && <p className="mt-1 text-xs text-red-400">{createError}</p>}
    </div>
  );
}
