import { useParams } from "react-router-dom";

import { useAnnotations, useCreateAnnotation } from "../../entities/useAnnotations";
import { useLabels } from "../../entities/useLabels";
import { LabelPicker } from "./LabelPicker";

export function FrameAnnotationPage() {
  const { frameId } = useParams<{ frameId: string }>();
  const frameIdNumber = Number(frameId);

  const labelsQuery = useLabels();
  const annotationsQuery = useAnnotations(frameIdNumber);
  const createAnnotation = useCreateAnnotation(frameIdNumber);

  return (
    <div className="grid min-h-screen grid-cols-[1fr_300px] bg-gray-950 text-gray-100">
      <div className="flex items-center justify-center p-8">
        <p className="text-gray-400">Frame #{frameId}</p>
      </div>
      <aside className="border-l border-gray-800 p-4">
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-gray-400">
          Labels
        </h2>
        <LabelPicker
          labels={labelsQuery.data ?? []}
          onSelect={(labelId) => createAnnotation.mutate(labelId)}
        />
        <h2 className="mb-3 mt-6 text-sm font-semibold uppercase tracking-wide text-gray-400">
          Existing annotations
        </h2>
        <ul className="space-y-1 text-sm text-gray-300">
          {(annotationsQuery.data ?? []).map((annotation) => (
            <li key={annotation.id}>
              Label #{annotation.label_id} — {annotation.status}
            </li>
          ))}
        </ul>
      </aside>
    </div>
  );
}
