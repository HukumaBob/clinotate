import { useStore } from "zustand/react";

import { useLabelTree } from "../../entities/useLabelTree";
import type { FrameEditorStore } from "./frameEditorStore";

interface CascadingLabelPickerProps {
  store: FrameEditorStore;
}

const SELECT_CLASSES =
  "mt-1 w-full rounded-md border border-gray-700 bg-gray-900 px-2 py-1.5 text-sm text-gray-100 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 disabled:cursor-not-allowed disabled:opacity-50";

export function CascadingLabelPicker({ store }: CascadingLabelPickerProps) {
  const treeQuery = useLabelTree();
  const tree = treeQuery.data ?? [];

  const labelCategoryId = useStore(store, (state) => state.labelCategoryId);
  const labelClassification = useStore(store, (state) => state.labelClassification);
  const labelTagId = useStore(store, (state) => state.labelTagId);
  const setLabelSelection = useStore(store, (state) => state.setLabelSelection);

  const selectedCategory = tree.find((node) => node.category.id === labelCategoryId);
  const classificationOptions = Array.from(
    new Set((selectedCategory?.children ?? []).map((child) => child.label_type)),
  );
  const tagOptions = (selectedCategory?.children ?? []).filter(
    (child) => labelClassification === null || child.label_type === labelClassification,
  );

  return (
    <div className="space-y-2">
      <label className="block text-xs text-gray-400">
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

      <label className="block text-xs text-gray-400">
        Classification
        <select
          className={SELECT_CLASSES}
          value={labelClassification ?? ""}
          disabled={!selectedCategory}
          onChange={(event) =>
            setLabelSelection({
              labelClassification: (event.target.value || null) as never,
              labelTagId: null,
            })
          }
        >
          <option value="">All</option>
          {classificationOptions.map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </select>
      </label>

      <label className="block text-xs text-gray-400">
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
