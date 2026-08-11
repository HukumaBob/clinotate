import { useStore } from "zustand/react";

import { useTaxonomyTree } from "../../entities/useTaxonomyTree";
import type { FrameEditorStore } from "./frameEditorStore";

interface CascadingLabelPickerProps {
  store: FrameEditorStore;
  procedureId: number | null;
}

const SELECT_CLASSES =
  "mt-1 w-full rounded-md border border-gray-700 bg-gray-900 px-2 py-1.5 text-sm text-gray-100 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 disabled:cursor-not-allowed disabled:opacity-50";

export function CascadingLabelPicker({ store, procedureId }: CascadingLabelPickerProps) {
  const treeQuery = useTaxonomyTree(procedureId);
  const tree = treeQuery.data ?? [];

  const labelCategoryId = useStore(store, (state) => state.labelCategoryId);
  const labelClassification = useStore(store, (state) => state.labelClassification);
  const labelTagId = useStore(store, (state) => state.labelTagId);
  const setLabelSelection = useStore(store, (state) => state.setLabelSelection);

  const selectedCategory = tree.find((node) => node.category.id === labelCategoryId);
  const evaluationTypeOptions = selectedCategory?.evaluation_types ?? [];
  const selectedEvaluationTypeNode = evaluationTypeOptions.find(
    (node) => node.evaluation_type.id === labelClassification,
  );
  const tagOptions = labelClassification === null
    ? evaluationTypeOptions.flatMap((node) => node.labels)
    : (selectedEvaluationTypeNode?.labels ?? []);

  return (
    <div className="flex gap-2">
      <label className="block flex-1 text-xs text-gray-400">
        Category
        <select
          className={SELECT_CLASSES}
          value={labelCategoryId ?? ""}
          onChange={(event) =>
            setLabelSelection({
              labelCategoryId: event.target.value ? Number(event.target.value) : null,
              labelClassification: null,
              labelTagId: null,
            })
          }
        >
          <option value="">Select category</option>
          {tree.map((node) => (
            <option key={node.category.id} value={node.category.id}>
              {node.category.name}
            </option>
          ))}
        </select>
      </label>

      <label className="block flex-1 text-xs text-gray-400">
        Classification
        <select
          className={SELECT_CLASSES}
          value={labelClassification ?? ""}
          disabled={!selectedCategory}
          onChange={(event) =>
            setLabelSelection({
              labelClassification: event.target.value ? Number(event.target.value) : null,
              labelTagId: null,
            } as never)
          }
        >
          <option value="">All</option>
          {evaluationTypeOptions.map(({ evaluation_type: evaluationType }) => (
            <option key={evaluationType.id} value={evaluationType.id}>
              {evaluationType.name}
            </option>
          ))}
        </select>
      </label>

      <label className="block flex-1 text-xs text-gray-400">
        Tag
        <select
          className={SELECT_CLASSES}
          value={labelTagId ?? ""}
          disabled={!selectedCategory}
          onChange={(event) =>
            setLabelSelection({ labelTagId: event.target.value ? Number(event.target.value) : null })
          }
        >
          <option value="">Select tag</option>
          {tagOptions.map((tag) => (
            <option key={tag.id} value={tag.id}>
              {tag.name}
            </option>
          ))}
        </select>
      </label>
    </div>
  );
}
