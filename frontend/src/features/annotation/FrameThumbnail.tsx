import { useAnnotations } from "../../entities/useAnnotations";

interface FrameThumbnailProps {
  frameId: number;
  imageUrl: string;
  onClick: () => void;
}

export function FrameThumbnail({ frameId, imageUrl, onClick }: FrameThumbnailProps) {
  const annotationsQuery = useAnnotations(frameId);
  const annotations = annotationsQuery.data ?? [];

  return (
    <button
      type="button"
      onClick={onClick}
      className="group relative aspect-square overflow-hidden rounded border border-gray-800 bg-gray-900"
    >
      <img src={imageUrl} alt={`Frame ${frameId}`} className="h-full w-full object-cover" />
      {annotations.length > 0 && (
        <div className="absolute inset-x-0 bottom-0 flex gap-1 truncate bg-gray-950/80 px-1 py-0.5 text-xs text-gray-200">
          {annotations.map((annotation) => (
            <span key={annotation.id}>{`● label ${annotation.label_id}`}</span>
          ))}
        </div>
      )}
    </button>
  );
}
