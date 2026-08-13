import { useState } from "react";

import { useCreateCategory, useProcedures, useUpdateCategory } from "../../entities/useTaxonomy";
import type { components } from "../../shared/api/generated/schema";

type CategoryRead = components["schemas"]["CategoryRead"];

export function CategoryForm({
  defaultProcedureId,
  editingCategory,
  onDone,
}: {
  defaultProcedureId: number | null;
  editingCategory?: CategoryRead | null;
  onDone: () => void;
}) {
  const proceduresQuery = useProcedures();
  const createCategory = useCreateCategory();
  const updateCategory = useUpdateCategory();

  const [name, setName] = useState(editingCategory?.name ?? "");
  const [procedureId, setProcedureId] = useState<string>(
    editingCategory
      ? String(editingCategory.procedure_id)
      : defaultProcedureId !== null
        ? String(defaultProcedureId)
        : ""
  );
  const [error, setError] = useState<string | null>(null);

  const procedures = proceduresQuery.data ?? [];

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (!name.trim()) {
      setError("Name is required");
      return;
    }
    if (!editingCategory && !procedureId) {
      setError("Procedure is required");
      return;
    }
    setError(null);

    const result = editingCategory
      ? await updateCategory.mutateAsync({
          categoryId: editingCategory.id,
          payload: { name: name.trim() },
        })
      : await createCategory.mutateAsync({ name: name.trim(), procedure_id: Number(procedureId) });

    if (result.error) {
      setError((result.error as { detail?: string }).detail ?? "Save failed");
      return;
    }
    onDone();
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-3 text-sm">
      {error && <p className="text-red-400">{error}</p>}
      <label className="flex flex-col gap-1">
        <span>Name</span>
        <input
          className="rounded border border-gray-700 bg-gray-900 px-2 py-1 text-gray-100"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
      </label>
      <label className="flex flex-col gap-1">
        <span>Procedure</span>
        <select
          className="rounded border border-gray-700 bg-gray-900 px-2 py-1 text-gray-100 disabled:opacity-60"
          value={procedureId}
          onChange={(e) => setProcedureId(e.target.value)}
          disabled={Boolean(editingCategory)}
        >
          <option value="">Select…</option>
          {procedures.map((procedure) => (
            <option key={procedure.id} value={procedure.id}>
              {procedure.name}
            </option>
          ))}
        </select>
      </label>
      <div className="flex justify-end gap-2">
        <button
          type="button"
          className="rounded bg-gray-700 px-3 py-1 text-white hover:bg-gray-600"
          onClick={onDone}
        >
          Cancel
        </button>
        <button type="submit" className="rounded bg-blue-600 px-3 py-1 text-white hover:bg-blue-500">
          Save
        </button>
      </div>
    </form>
  );
}
