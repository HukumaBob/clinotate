import { useAnnotations } from "../../entities/useAnnotations";
import { resolveLabelFromTree } from "./resolveLabel";
import type { components } from "../../shared/api/generated/schema";

type TaxonomyTreeNode = components["schemas"]["TaxonomyTreeNode"];

const DEFAULT_MASK_COLOR = "#22d3ee";

interface FrameThumbnailProps {
  frameId: number;
  imageUrl: string;
  taxonomyTree: TaxonomyTreeNode[];
  onClick: () => void;
  selectable: boolean;
  selected: boolean;
  onToggleSelect: () => void;
}

export function FrameThumbnail({
  frameId,
  imageUrl,
  taxonomyTree,
  onClick,
  selectable,
  selected,
  onToggleSelect,
}: FrameThumbnailProps) {
  const annotationsQuery = useAnnotations(frameId);
  const annotations = annotationsQuery.data ?? [];
  const maskAnnotations = annotations.filter((annotation) => annotation.mask_url);

  return (
    <button
      type="button"
      onClick={selectable ? onToggleSelect : onClick}
      className="group relative aspect-square overflow-hidden rounded border border-gray-800 bg-gray-900"
    >
      <img src={imageUrl} alt={`Frame ${frameId}`} className="h-full w-full object-contain" />
      {selectable && (
        <input
          type="checkbox"
          checked={selected}
          onChange={onToggleSelect}
          onClick={(event) => event.stopPropagation()}
          className="absolute left-2 top-2 h-5 w-5 accent-blue-500"
        />
      )}
      {maskAnnotations.map((annotation) => {
        const resolved = resolveLabelFromTree(taxonomyTree, annotation.label_id);
        const color = resolved?.tag.color ?? DEFAULT_MASK_COLOR;
        return (
          <div
            key={annotation.id}
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
