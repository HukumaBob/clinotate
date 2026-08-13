import type { JSX } from "react";
import { useState } from "react";

import {
  useDeleteCategory,
  useDeleteLabel,
  useLabelMaskCounts,
  useProcedures,
  useTagsTree,
} from "../../entities/useTaxonomy";
import type { components } from "../../shared/api/generated/schema";

type LabelRead = components["schemas"]["LabelRead"];
type CategoryRead = components["schemas"]["CategoryRead"];

export function TagsTable({
  procedureId,
  evaluationTypeId,
  search,
  onEditCategory,
  onEditLabel,
}: {
  procedureId: number | null;
  evaluationTypeId?: number | null;
  search?: string;
  onEditCategory?: (category: CategoryRead) => void;
  onEditLabel?: (label: LabelRead) => void;
}) {
  const treeQuery = useTagsTree(procedureId);
  const maskCountsQuery = useLabelMaskCounts();
  const proceduresQuery = useProcedures();
  const deleteCategory = useDeleteCategory();
  const deleteLabel = useDeleteLabel();
  const [confirmingKey, setConfirmingKey] = useState<string | null>(null);
  const [errorsByKey, setErrorsByKey] = useState<Record<string, string>>({});

  const tree = treeQuery.data ?? [];
  const maskCounts = maskCountsQuery.data ?? {};
  const procedures = proceduresQuery.data ?? [];
  const searchLower = (search ?? "").trim().toLowerCase();

  function procedureName(procedureIdValue: number): string {
    return procedures.find((procedure) => procedure.id === procedureIdValue)?.name ?? String(procedureIdValue);
  }

  async function handleDelete(kind: "category" | "label", id: number) {
    const key = `${kind}-${id}`;
    const result = kind === "category" ? await deleteCategory.mutateAsync(id) : await deleteLabel.mutateAsync(id);
    if (result.error) {
      const detail = (result.error as { detail?: string }).detail ?? "Delete failed";
      setErrorsByKey((errors) => ({ ...errors, [key]: detail }));
      return;
    }
    setErrorsByKey((errors) => ({ ...errors, [key]: "" }));
    setConfirmingKey(null);
  }

  if (treeQuery.isLoading) {
    return <p className="text-sm text-gray-400">Loading tags…</p>;
  }
  if (treeQuery.isError) {
    return <p className="text-sm text-red-400">Failed to load tags</p>;
  }

  const rows: JSX.Element[] = [];
  for (const node of tree) {
    if (evaluationTypeId != null && !node.evaluation_types.some((et) => et.evaluation_type.id === evaluationTypeId)) {
      continue;
    }

    const matchingEvalTypes = node.evaluation_types
      .filter((et) => evaluationTypeId == null || et.evaluation_type.id === evaluationTypeId)
      .map((et) => ({
        ...et,
        labels: searchLower
          ? et.labels.filter((label) => label.name.toLowerCase().includes(searchLower))
          : et.labels,
      }));

    const categoryMatches = !searchLower || node.category.name.toLowerCase().includes(searchLower);
    const hasVisibleLabels = matchingEvalTypes.some((et) => et.labels.length > 0);
    if (searchLower && !categoryMatches && !hasVisibleLabels) continue;

    const categoryKey = `category-${node.category.id}`;
    rows.push(
      <tr key={categoryKey} className="border-b border-gray-800">
        <td className="px-4 py-2 font-medium text-gray-100">{node.category.name}</td>
        <td className="px-4 py-2 text-gray-400">{procedureName(node.category.procedure_id)}</td>
        <td className="px-4 py-2" />
        <td className="px-4 py-2" />
        <td className="px-4 py-2 text-right">
          <RowActions
            label={node.category.name}
            confirming={confirmingKey === categoryKey}
            error={errorsByKey[categoryKey]}
            onEdit={() => onEditCategory?.(node.category)}
            onDeleteClick={() => setConfirmingKey(categoryKey)}
            onDeleteConfirm={() => handleDelete("category", node.category.id)}
          />
        </td>
      </tr>
    );

    const labelsToShow = searchLower ? matchingEvalTypes : node.evaluation_types;
    for (const evalTypeNode of labelsToShow) {
      for (const label of evalTypeNode.labels) {
        const labelKey = `label-${label.id}`;
        rows.push(
          <tr key={labelKey} className="border-b border-gray-800">
            <td className="px-4 py-2 pl-8 text-gray-300">
              <span className="mr-1 text-gray-500">↳</span>
              <span
                className="mr-2 inline-block h-3 w-3 rounded-full align-middle"
                style={{ backgroundColor: label.color }}
              />
              {label.name}
            </td>
            <td className="px-4 py-2" />
            <td className="px-4 py-2">
              <span className="rounded bg-gray-800 px-2 py-0.5 text-xs text-gray-300">
                {evalTypeNode.evaluation_type.name}
              </span>
            </td>
            <td className="px-4 py-2 text-gray-300">{maskCounts[String(label.id)] ?? 0}</td>
            <td className="px-4 py-2 text-right">
              <RowActions
                label={label.name}
                confirming={confirmingKey === labelKey}
                error={errorsByKey[labelKey]}
                onEdit={() => onEditLabel?.(label)}
                onDeleteClick={() => setConfirmingKey(labelKey)}
                onDeleteConfirm={() => handleDelete("label", label.id)}
              />
            </td>
          </tr>
        );
      }
    }
  }

  return (
    <div>
      <table className="w-full text-left text-sm">
        <thead>
          <tr className="border-b border-gray-700 text-gray-400">
            <th className="px-4 py-2 font-normal">Name</th>
            <th className="px-4 py-2 font-normal">Procedure</th>
            <th className="px-4 py-2 font-normal">Classification</th>
            <th className="px-4 py-2 font-normal">Masks</th>
            <th className="px-4 py-2 font-normal text-right">Actions</th>
          </tr>
        </thead>
        <tbody>{rows}</tbody>
      </table>
    </div>
  );
}

function RowActions({
  label,
  confirming,
  error,
  onEdit,
  onDeleteClick,
  onDeleteConfirm,
}: {
  label: string;
  confirming: boolean;
  error?: string;
  onEdit: () => void;
  onDeleteClick: () => void;
  onDeleteConfirm: () => void;
}) {
  return (
    <div>
      <div className="flex justify-end gap-2">
        <button
          type="button"
          aria-label={`Edit ${label}`}
          className="text-xs text-blue-400 hover:text-blue-300"
          onClick={onEdit}
        >
          Edit
        </button>
        {confirming ? (
          <button
            type="button"
            aria-label={`Confirm delete ${label}`}
            className="text-xs text-red-500 hover:text-red-400"
            onClick={onDeleteConfirm}
          >
            Confirm
          </button>
        ) : (
          <button
            type="button"
            aria-label={`Delete ${label}`}
            className="text-xs text-red-400 hover:text-red-300"
            onClick={onDeleteClick}
          >
            Delete
          </button>
        )}
      </div>
      {error && <p className="mt-1 text-xs text-red-400">{error}</p>}
    </div>
  );
}
