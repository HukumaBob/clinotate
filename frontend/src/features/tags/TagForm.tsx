import { useEffect, useState } from "react";

import {
  useCreateLabel,
  useEvaluationTypes,
  useProcedures,
  useTagsTree,
  useUpdateLabel,
} from "../../entities/useTaxonomy";
import type { components } from "../../shared/api/generated/schema";

type LabelRead = components["schemas"]["LabelRead"];

const COLOR_PRESETS = ["#EF4444", "#F59E0B", "#10B981", "#3B82F6", "#8B5CF6", "#EC4899"];

export function TagForm({
  defaultProcedureId,
  editingLabel,
  onDone,
}: {
  defaultProcedureId: number | null;
  editingLabel?: LabelRead | null;
  onDone: () => void;
}) {
  const proceduresQuery = useProcedures();
  const treeQuery = useTagsTree(null);
  const evaluationTypesQuery = useEvaluationTypes();
  const createLabel = useCreateLabel();
  const updateLabel = useUpdateLabel();

  const allCategories = (treeQuery.data ?? []).map((node) => node.category);
  const editingCategory = editingLabel
    ? allCategories.find((category) => category.id === editingLabel.category_id)
    : undefined;

  const [procedureId, setProcedureId] = useState<string>(
    defaultProcedureId !== null ? String(defaultProcedureId) : ""
  );
  const [name, setName] = useState(editingLabel?.name ?? "");
  const [categoryId, setCategoryId] = useState<string>(
    editingLabel ? String(editingLabel.category_id) : ""
  );
  const [evaluationTypeId, setEvaluationTypeId] = useState<string>(
    editingLabel ? String(editingLabel.evaluation_type_id) : ""
  );
  const [color, setColor] = useState(editingLabel?.color ?? COLOR_PRESETS[0]);
  const [parentLabelId, setParentLabelId] = useState<string>(
    editingLabel?.parent_label_id != null ? String(editingLabel.parent_label_id) : ""
  );
  const [isAbstract, setIsAbstract] = useState<boolean>(editingLabel?.is_abstract ?? false);
  const [error, setError] = useState<string | null>(null);

  const procedures = proceduresQuery.data ?? [];
  const evaluationTypes = evaluationTypesQuery.data ?? [];
  const categories = procedureId
    ? allCategories.filter((category) => String(category.procedure_id) === procedureId)
    : [];

  const labelsInSelectedCategory = (treeQuery.data ?? [])
    .find((node) => String(node.category.id) === categoryId)
    ?.evaluation_types.flatMap((evaluationType) => evaluationType.labels) ?? [];
  const parentCandidates = labelsInSelectedCategory.filter(
    (candidate) => candidate.id !== editingLabel?.id
  );

  useEffect(() => {
    if (editingCategory && !procedureId) {
      setProcedureId(String(editingCategory.procedure_id));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editingCategory]);

  function handleProcedureChange(value: string) {
    setProcedureId(value);
    setCategoryId("");
  }

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (!name.trim()) {
      setError("Name is required");
      return;
    }
    if (!procedureId || !categoryId || !evaluationTypeId) {
      setError("Procedure, parent tag, and classification are required");
      return;
    }
    setError(null);

    const payload = {
      name: name.trim(),
      color,
      category_id: Number(categoryId),
      evaluation_type_id: Number(evaluationTypeId),
      parent_label_id: parentLabelId === "" ? null : Number(parentLabelId),
      is_abstract: isAbstract,
    };

    const result = editingLabel
      ? await updateLabel.mutateAsync({ labelId: editingLabel.id, payload })
      : await createLabel.mutateAsync(payload);

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
          className="rounded border border-gray-700 bg-gray-900 px-2 py-1 text-gray-100"
          value={procedureId}
          onChange={(e) => handleProcedureChange(e.target.value)}
        >
          <option value="">Select…</option>
          {procedures.map((procedure) => (
            <option key={procedure.id} value={procedure.id}>
              {procedure.name}
            </option>
          ))}
        </select>
      </label>
      <label className="flex flex-col gap-1">
        <span>Parent tag</span>
        <select
          className="rounded border border-gray-700 bg-gray-900 px-2 py-1 text-gray-100"
          value={categoryId}
          onChange={(e) => setCategoryId(e.target.value)}
          disabled={!procedureId}
        >
          <option value="">Select…</option>
          {categories.map((category) => (
            <option key={category.id} value={category.id}>
              {category.name}
            </option>
          ))}
        </select>
      </label>
      <label className="flex flex-col gap-1">
        <span>Classification</span>
        <select
          className="rounded border border-gray-700 bg-gray-900 px-2 py-1 text-gray-100"
          value={evaluationTypeId}
          onChange={(e) => setEvaluationTypeId(e.target.value)}
        >
          <option value="">Select…</option>
          {evaluationTypes.map((evaluationType) => (
            <option key={evaluationType.id} value={evaluationType.id}>
              {evaluationType.name}
            </option>
          ))}
        </select>
      </label>
      <label className="flex flex-col gap-1">
        <span>Parent label</span>
        <select
          className="rounded border border-gray-700 bg-gray-900 px-2 py-1 text-gray-100"
          value={parentLabelId}
          onChange={(e) => setParentLabelId(e.target.value)}
        >
          <option value="">None</option>
          {parentCandidates.map((candidate) => (
            <option key={candidate.id} value={candidate.id}>
              {candidate.name}
            </option>
          ))}
        </select>
      </label>
      <label className="flex items-center gap-2">
        <input
          type="checkbox"
          checked={isAbstract}
          onChange={(e) => setIsAbstract(e.target.checked)}
        />
        <span>Abstract (grouping only, not annotatable)</span>
      </label>
      <div className="flex flex-col gap-1">
        <span>Color</span>
        <div className="flex items-center gap-2">
          <input
            type="color"
            aria-label="Color"
            value={color}
            onChange={(e) => setColor(e.target.value)}
            className="h-7 w-10 rounded border border-gray-700 bg-gray-900"
          />
          {COLOR_PRESETS.map((preset) => (
            <button
              key={preset}
              type="button"
              aria-label={`Preset ${preset}`}
              className="h-5 w-5 rounded-full border border-gray-700"
              style={{ backgroundColor: preset }}
              onClick={() => setColor(preset)}
            />
          ))}
        </div>
      </div>
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
