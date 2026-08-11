import { useState } from "react";
import { useStore } from "zustand/react";

import { useDeleteAnnotation, useDeleteJobAnnotations } from "../../entities/useAnnotations";
import { useTaxonomyTree } from "../../entities/useTaxonomyTree";
import type { components } from "../../shared/api/generated/schema";
import { MaskSmoothingControl } from "./MaskSmoothingControl";
import { resolveLabelFromTree } from "./resolveLabel";
import type { FrameEditorStore } from "./frameEditorStore";

type Annotation = components["schemas"]["AnnotationRead"];

interface MasksListProps {
  annotations: Annotation[];
  store: FrameEditorStore;
  frameId: number;
  procedureId: number | null;
}

export function MasksList({ annotations, store, frameId, procedureId }: MasksListProps) {
  const treeQuery = useTaxonomyTree(procedureId);
  const tree = treeQuery.data ?? [];
  const deleteAnnotation = useDeleteAnnotation(frameId);
  const deleteJobAnnotations = useDeleteJobAnnotations(frameId);

  const [pendingDeleteId, setPendingDeleteId] = useState<number | null>(null);
  const [pendingBulkJobId, setPendingBulkJobId] = useState<number | null>(null);

  const selectedAnnotationId = useStore(store, (state) => state.selectedAnnotationId);
  const setSelectedAnnotation = useStore(store, (state) => state.setSelectedAnnotation);
  const setHoveredAnnotation = useStore(store, (state) => state.setHoveredAnnotation);
  const setLabelSelection = useStore(store, (state) => state.setLabelSelection);
  const setColor = useStore(store, (state) => state.setColor);
  const hiddenAnnotationIds = useStore(store, (state) => state.hiddenAnnotationIds);
  const toggleAnnotationVisibility = useStore(store, (state) => state.toggleAnnotationVisibility);

  const maskAnnotations = annotations.filter((annotation) => annotation.annotation_type === "mask");

  function handleSelect(annotation: Annotation) {
    setSelectedAnnotation(annotation.id);
    const resolved = resolveLabelFromTree(tree, annotation.label_id);
    if (resolved) {
      setLabelSelection({
        labelCategoryId: resolved.categoryId,
        labelClassification: resolved.classification,
        labelTagId: resolved.tag.id,
      });
      setColor(resolved.tag.color);
    }
  }

  // Deleting the mask currently being refined (the draft) must also drop
  // its accumulated point/box markers -- otherwise the points stay on
  // screen pointing at a mask that no longer exists (mirrors the same
  // check in FrameEditor's own handleRemoveAnnotation, for the ctrl-click-
  // on-canvas delete path).
  function clearPromptsIfDraft(annotationId: number) {
    if (store.getState().draftAnnotationId === annotationId) {
      store.getState().clearPrompts();
    }
  }

  function handleDeleteClick(annotationId: number) {
    if (pendingDeleteId === annotationId) {
      deleteAnnotation.mutate(annotationId);
      clearPromptsIfDraft(annotationId);
      setPendingDeleteId(null);
    } else {
      setPendingDeleteId(annotationId);
      setPendingBulkJobId(null);
    }
  }

  function handleBulkDeleteClick(jobId: number) {
    if (pendingBulkJobId === jobId) {
      const draftId = store.getState().draftAnnotationId;
      const draftAnnotation = maskAnnotations.find((a) => a.id === draftId);
      deleteJobAnnotations.mutate(jobId);
      if (draftAnnotation?.job_id === jobId) {
        store.getState().clearPrompts();
      }
      setPendingBulkJobId(null);
    } else {
      setPendingBulkJobId(jobId);
      setPendingDeleteId(null);
    }
  }

  return (
    <ul className="max-h-48 space-y-1 overflow-y-auto text-sm">
      {maskAnnotations.map((annotation) => {
        const resolved = resolveLabelFromTree(tree, annotation.label_id);
        const categoryName = resolved?.categoryName;
        const tagName = resolved?.tag.name;
        const isPendingDelete = pendingDeleteId === annotation.id;
        const isPendingBulk = annotation.job_id !== null && pendingBulkJobId === annotation.job_id;

        return (
          <li key={annotation.id} className="flex items-center gap-1">
            <input
              type="checkbox"
              aria-label="Toggle visibility"
              title="Show/hide this mask on the frame"
              checked={!hiddenAnnotationIds.has(annotation.id)}
              onChange={() => toggleAnnotationVisibility(annotation.id)}
              className="shrink-0"
            />
            <button
              type="button"
              onClick={() => handleSelect(annotation)}
              onMouseEnter={() => setHoveredAnnotation(annotation.id)}
              onMouseLeave={() => setHoveredAnnotation(null)}
              className={`flex flex-1 items-center gap-2 rounded px-2 py-1 text-left hover:bg-gray-800 ${
                annotation.id === selectedAnnotationId ? "bg-gray-800" : ""
              }`}
            >
              <span
                className="h-3 w-3 rounded-full"
                style={{ backgroundColor: resolved?.tag.color ?? "#666" }}
              />
              {categoryName && tagName ? `${categoryName} / ${tagName}` : `label ${annotation.label_id}`}
            </button>
            <MaskSmoothingControl
              annotationId={annotation.id}
              initialStrength={annotation.mask_postprocess_strength ?? null}
              frameId={frameId}
            />
            {annotation.job_id !== null && (
              <button
                type="button"
                aria-label={isPendingBulk ? "Confirm delete all" : "Delete all from this run"}
                title={isPendingBulk ? "Click again to confirm" : "Delete this mask on every tracked frame"}
                onClick={() => handleBulkDeleteClick(annotation.job_id as number)}
                className={`shrink-0 rounded px-1.5 py-0.5 text-xs ${
                  isPendingBulk ? "bg-red-700 text-white" : "text-gray-500 hover:text-red-400"
                }`}
              >
                {isPendingBulk ? "Confirm all" : "🗑️"}
              </button>
            )}
            <button
              type="button"
              aria-label={isPendingDelete ? "Confirm delete mask" : "Delete mask"}
              title={isPendingDelete ? "Click again to confirm" : "Delete this mask on this frame only"}
              onClick={() => handleDeleteClick(annotation.id)}
              className={`shrink-0 rounded px-1.5 py-0.5 text-xs ${
                isPendingDelete ? "bg-red-700 text-white" : "text-gray-500 hover:text-red-400"
              }`}
            >
              {isPendingDelete ? "Confirm" : "✕"}
            </button>
          </li>
        );
      })}
    </ul>
  );
}
