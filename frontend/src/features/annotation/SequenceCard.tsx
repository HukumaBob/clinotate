import { useState } from "react";

import { useDeleteSequence } from "../../entities/useMediaLibrary";
import { useTaxonomyTree } from "../../entities/useTaxonomyTree";
import { resolveLabelFromTree } from "./resolveLabel";
import type { components } from "../../shared/api/generated/schema";

type SequenceListItem = components["schemas"]["SequenceListItem"];

const DEFAULT_MASK_COLOR = "#22d3ee";

interface SequenceCardProps {
  sequence: SequenceListItem;
  onAnnotate: (sequenceId: number) => void;
}

export function SequenceCard({ sequence, onAnnotate }: SequenceCardProps) {
  const taxonomyTreeQuery = useTaxonomyTree(sequence.procedure_id ?? null);
  const taxonomyTree = taxonomyTreeQuery.data ?? [];
  const deleteSequence = useDeleteSequence();
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const progress =
    sequence.frame_count > 0 ? Math.round((sequence.labeled_frame_count / sequence.frame_count) * 100) : 0;

  function handleDeleteConfirm() {
    setDeleteError(null);
    deleteSequence.mutate(sequence.id, {
      onError: (error: unknown) => {
        const detail = (error as { detail?: string } | undefined)?.detail ?? "Delete failed";
        setDeleteError(detail);
        setConfirmingDelete(false);
      },
    });
  }

  return (
    <div className="flex flex-col overflow-hidden rounded border border-gray-800 bg-gray-900">
      <div className="grid grid-cols-2 gap-0.5 bg-gray-950 p-0.5">
        {sequence.preview_frames.map((frame) => (
          <div key={frame.frame_id} className="relative aspect-square overflow-hidden bg-gray-900">
            <img
              src={frame.image_url}
              alt={`Preview frame ${frame.frame_id}`}
              className="h-full w-full object-contain"
            />
            {frame.annotations
              .filter((annotation) => annotation.mask_url)
              .map((annotation, index) => {
                const resolved = resolveLabelFromTree(taxonomyTree, annotation.label_id);
                const color = resolved?.tag.color ?? DEFAULT_MASK_COLOR;
                return (
                  <div
                    key={index}
                    data-testid="mask-overlay"
                    className="pointer-events-none absolute inset-0"
                    style={{
                      backgroundColor: color,
                      maskImage: `url(${annotation.mask_url})`,
                      WebkitMaskImage: `url(${annotation.mask_url})`,
                      maskMode: "luminance",
                      WebkitMaskMode: "luminance" as never,
                      maskSize: "contain",
                      WebkitMaskSize: "contain",
                      maskRepeat: "no-repeat",
                      WebkitMaskRepeat: "no-repeat",
                      maskPosition: "center",
                      WebkitMaskPosition: "center",
                      opacity: 0.45,
                    }}
                  />
                );
              })}
          </div>
        ))}
      </div>

      <div className="flex flex-1 flex-col gap-2 p-3 text-sm">
        <h3 className="truncate font-medium text-gray-100">{sequence.name}</h3>

        <div className="flex justify-between text-gray-400">
          <span>Frames</span>
          <span className="text-gray-100">{sequence.frame_count}</span>
        </div>
        <div className="flex justify-between text-gray-400">
          <span>Labeled</span>
          <span className="text-gray-100">{sequence.labeled_frame_count}</span>
        </div>

        <div>
          <div className="mb-1 flex justify-between text-xs text-gray-400">
            <span>Labeling progress</span>
            <span>{progress}%</span>
          </div>
          <div className="h-1.5 overflow-hidden rounded bg-gray-800">
            <div className="h-full bg-emerald-500" style={{ width: `${progress}%` }} />
          </div>
        </div>

        <button
          type="button"
          onClick={() => onAnnotate(sequence.id)}
          className="mt-1 rounded bg-blue-600 px-3 py-1.5 text-sm text-white hover:bg-blue-500"
        >
          Annotate
        </button>

        {confirmingDelete ? (
          <div className="flex gap-2">
            <button
              type="button"
              onClick={handleDeleteConfirm}
              disabled={deleteSequence.isPending}
              className="flex-1 rounded bg-red-700 px-3 py-1.5 text-sm text-white hover:bg-red-600 disabled:opacity-50"
            >
              Confirm
            </button>
            <button
              type="button"
              onClick={() => setConfirmingDelete(false)}
              className="rounded border border-gray-700 px-3 py-1.5 text-sm text-gray-100 hover:bg-gray-800"
            >
              Cancel
            </button>
          </div>
        ) : (
          <button
            type="button"
            onClick={() => setConfirmingDelete(true)}
            className="rounded border border-gray-700 px-3 py-1.5 text-sm text-gray-100 hover:bg-gray-800"
          >
            Delete
          </button>
        )}
        {deleteError && <p className="text-xs text-red-400">{deleteError}</p>}
      </div>
    </div>
  );
}
