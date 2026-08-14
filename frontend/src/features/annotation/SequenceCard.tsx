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
  const progress =
    sequence.frame_count > 0 ? Math.round((sequence.labeled_frame_count / sequence.frame_count) * 100) : 0;

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
      </div>
    </div>
  );
}
