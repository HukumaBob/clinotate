import { useState } from "react";

import {
  useCreateEvaluationType,
  useDeleteEvaluationType,
  useEvaluationTypes,
  useUpdateEvaluationType,
} from "../../entities/useTaxonomy";

export function ClassificationsPanel() {
  const evaluationTypesQuery = useEvaluationTypes();
  const createEvaluationType = useCreateEvaluationType();
  const updateEvaluationType = useUpdateEvaluationType();
  const deleteEvaluationType = useDeleteEvaluationType();

  const [newName, setNewName] = useState("");
  const [newScope, setNewScope] = useState<"frame" | "region" | "">("");
  const [createError, setCreateError] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editingName, setEditingName] = useState("");
  const [confirmingId, setConfirmingId] = useState<number | null>(null);
  const [errorsById, setErrorsById] = useState<Record<number, string>>({});

  const evaluationTypes = evaluationTypesQuery.data ?? [];

  async function handleCreate() {
    if (!newName.trim()) {
      setCreateError("Name is required");
      return;
    }
    if (!newScope) {
      setCreateError("Scope is required");
      return;
    }
    setCreateError(null);
    const result = await createEvaluationType.mutateAsync({
      name: newName.trim(),
      annotation_scope: newScope,
    });
    if (result.error) {
      setCreateError((result.error as { detail?: string }).detail ?? "Create failed");
      return;
    }
    setNewName("");
    setNewScope("");
  }

  async function handleSaveEdit(id: number) {
    if (!editingName.trim()) return;
    const result = await updateEvaluationType.mutateAsync({
      evaluationTypeId: id,
      payload: { name: editingName.trim() },
    });
    if (result.error) {
      setErrorsById((errors) => ({ ...errors, [id]: (result.error as { detail?: string }).detail ?? "Save failed" }));
      return;
    }
    setErrorsById((errors) => ({ ...errors, [id]: "" }));
    setEditingId(null);
  }

  async function handleDelete(id: number) {
    const result = await deleteEvaluationType.mutateAsync(id);
    if (result.error) {
      setErrorsById((errors) => ({
        ...errors,
        [id]: (result.error as { detail?: string }).detail ?? "Delete failed",
      }));
      return;
    }
    setErrorsById((errors) => ({ ...errors, [id]: "" }));
    setConfirmingId(null);
  }

  return (
    <div className="mb-4 shrink-0 rounded border border-gray-800 bg-gray-900 p-4 text-sm">
      <h2 className="mb-2 font-medium text-gray-200">Classifications</h2>
      <ul className="mb-3 flex flex-col gap-1">
        {evaluationTypes.map((evaluationType) => (
          <li key={evaluationType.id} className="flex items-center justify-between gap-2">
            {editingId === evaluationType.id ? (
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
                    onClick={() => handleSaveEdit(evaluationType.id)}
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
                <span className="text-gray-100">{evaluationType.name}</span>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    aria-label={`Edit ${evaluationType.name}`}
                    className="text-xs text-blue-400 hover:text-blue-300"
                    onClick={() => {
                      setEditingId(evaluationType.id);
                      setEditingName(evaluationType.name);
                    }}
                  >
                    Edit
                  </button>
                  {confirmingId === evaluationType.id ? (
                    <button
                      type="button"
                      aria-label={`Confirm delete ${evaluationType.name}`}
                      className="text-xs text-red-500 hover:text-red-400"
                      onClick={() => handleDelete(evaluationType.id)}
                    >
                      Confirm
                    </button>
                  ) : (
                    <button
                      type="button"
                      aria-label={`Delete ${evaluationType.name}`}
                      className="text-xs text-red-400 hover:text-red-300"
                      onClick={() => setConfirmingId(evaluationType.id)}
                    >
                      Delete
                    </button>
                  )}
                </div>
              </>
            )}
            {errorsById[evaluationType.id] && (
              <p className="w-full text-xs text-red-400">{errorsById[evaluationType.id]}</p>
            )}
          </li>
        ))}
      </ul>
      <div className="flex items-center gap-2">
        <input
          type="text"
          placeholder="New classification…"
          className="rounded border border-gray-700 bg-gray-950 px-2 py-1 text-gray-100"
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
        />
        <label className="flex items-center gap-1 text-xs text-gray-300">
          <input
            type="radio"
            name="new-classification-scope"
            value="frame"
            checked={newScope === "frame"}
            onChange={() => setNewScope("frame")}
          />
          Frame
        </label>
        <label className="flex items-center gap-1 text-xs text-gray-300">
          <input
            type="radio"
            name="new-classification-scope"
            value="region"
            checked={newScope === "region"}
            onChange={() => setNewScope("region")}
          />
          Region
        </label>
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
