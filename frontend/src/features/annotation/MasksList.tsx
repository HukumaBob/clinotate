import { useStore } from "zustand/react";

import { useLabelTree } from "../../entities/useLabelTree";
import type { components } from "../../shared/api/generated/schema";
import type { FrameEditorStore } from "./frameEditorStore";

type Annotation = components["schemas"]["AnnotationRead"];

interface MasksListProps {
  annotations: Annotation[];
  store: FrameEditorStore;
}

export function MasksList({ annotations, store }: MasksListProps) {
  const treeQuery = useLabelTree();
  const tree = treeQuery.data ?? [];

  const selectedAnnotationId = useStore(store, (state) => state.selectedAnnotationId);
  const setSelectedAnnotation = useStore(store, (state) => state.setSelectedAnnotation);
  const setLabelSelection = useStore(store, (state) => state.setLabelSelection);
  const setColor = useStore(store, (state) => state.setColor);

  const maskAnnotations = annotations.filter((annotation) => annotation.annotation_type === "mask");

  function resolveLabel(labelId: number) {
    for (const node of tree) {
      if (node.category.id === labelId) {
        return { categoryId: node.category.id, tag: node.category, classification: null };
      }
      const child = node.children.find((c) => c.id === labelId);
      if (child) {
        return { categoryId: node.category.id, tag: child, classification: child.label_type };
      }
    }
    return null;
  }

  function handleSelect(annotation: Annotation) {
    setSelectedAnnotation(annotation.id);
    const resolved = resolveLabel(annotation.label_id);
    if (resolved) {
      setLabelSelection({
        labelCategoryId: resolved.categoryId,
        labelClassification: resolved.classification as never,
        labelTagId: resolved.tag.id,
      });
      setColor(resolved.tag.color);
    }
  }

  return (
    <ul className="max-h-48 space-y-1 overflow-y-auto text-sm">
      {maskAnnotations.map((annotation) => {
        const resolved = resolveLabel(annotation.label_id);
        const categoryName = tree.find((node) => node.category.id === resolved?.categoryId)?.category.name;
        const tagName = resolved?.tag.name;
        return (
          <li key={annotation.id}>
            <button
              type="button"
              onClick={() => handleSelect(annotation)}
              className={`flex w-full items-center gap-2 rounded px-2 py-1 text-left hover:bg-gray-800 ${
                annotation.id === selectedAnnotationId ? "bg-gray-800" : ""
              }`}
            >
              <span
                className="h-3 w-3 rounded-full"
                style={{ backgroundColor: resolved?.tag.color ?? "#666" }}
              />
              {categoryName && tagName ? `${categoryName} / ${tagName}` : `label ${annotation.label_id}`}
            </button>
          </li>
        );
      })}
    </ul>
  );
}
