import { useAnnotations } from "../../entities/useAnnotations";
import { resolveLabelFromTree } from "./resolveLabel";
import type { components } from "../../shared/api/generated/schema";

type TaxonomyTreeNode = components["schemas"]["TaxonomyTreeNode"];

interface FrameThumbnailProps {
  frameId: number;
  imageUrl: string;
  taxonomyTree: TaxonomyTreeNode[];
  onClick: () => void;
}

export function FrameThumbnail({ frameId, imageUrl, taxonomyTree, onClick }: FrameThumbnailProps) {
  const annotationsQuery = useAnnotations(frameId);
  const annotations = annotationsQuery.data ?? [];

  return (
    <button
      type="button"
      onClick={onClick}
      className="group relative aspect-square overflow-hidden rounded border border-gray-800 bg-gray-900"
    >
      <img src={imageUrl} alt={`Frame ${frameId}`} className="h-full w-full object-contain" />
      {annotations.length > 0 && (
        <div className="absolute inset-x-0 bottom-0 flex flex-wrap gap-1 truncate bg-gray-950/80 px-1 py-0.5 text-xs text-gray-200">
          {annotations.map((annotation) => {
            const resolved = resolveLabelFromTree(taxonomyTree, annotation.label_id);
            const label = resolved ? `${resolved.categoryName} / ${resolved.tag.name}` : `label ${annotation.label_id}`;
            const color = resolved?.tag.color ?? "#666";
            return (
              <span key={annotation.id} className="flex items-center gap-1">
                <span className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: color }} />
                {label}
              </span>
            );
          })}
        </div>
      )}
    </button>
  );
}
