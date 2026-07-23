import { useState } from "react";
import { useParams } from "react-router-dom";

import { useAnnotations, useCreateAnnotation } from "../../entities/useAnnotations";
import { useFrame } from "../../entities/useFrames";
import { useJob } from "../../entities/useJobs";
import { useLabels } from "../../entities/useLabels";
import { LabelPicker } from "./LabelPicker";
import { SegmentButton } from "./SegmentButton";

export function FrameAnnotationPage() {
  const { frameId } = useParams<{ frameId: string }>();
  const frameIdNumber = Number(frameId);
  const [activeJobId, setActiveJobId] = useState<number | null>(null);

  const labelsQuery = useLabels();
  const frameQuery = useFrame(frameIdNumber);
  const annotationsQuery = useAnnotations(frameIdNumber);
  const createAnnotation = useCreateAnnotation(frameIdNumber);
  const jobQuery = useJob(activeJobId);

  return (
    <div className="grid min-h-screen grid-cols-[1fr_300px] bg-gray-950 text-gray-100">
      <div className="flex flex-col items-center justify-center gap-4 p-8">
        <p className="text-gray-400">Frame #{frameId}</p>
        {frameQuery.isLoading && <p className="text-sm text-gray-500">Loading frame...</p>}
        {frameQuery.isError && (
          <p className="text-sm text-red-400">Failed to load frame image.</p>
        )}
        {frameQuery.data && (
          <SegmentButton
            frameId={frameIdNumber}
            imageUrl={frameQuery.data.image_url}
            labels={labelsQuery.data ?? []}
            onJobCreated={setActiveJobId}
          />
        )}
        {jobQuery.data && (
          <p className="text-sm text-gray-400">
            SAM-3 job #{jobQuery.data.id}: {jobQuery.data.status} ({jobQuery.data.progress}%)
          </p>
        )}
        {jobQuery.data?.status === "succeeded" && jobQuery.data.result_ref && (
          <p className="text-sm text-green-400">Mask ready: {jobQuery.data.result_ref}</p>
        )}
        {jobQuery.data?.status === "failed" && (
          <p className="text-sm text-red-400">Segmentation failed: {jobQuery.data.error}</p>
        )}
        {jobQuery.isError && (
          <p className="text-sm text-red-400">
            Lost connection while checking job status. Retrying...
          </p>
        )}
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
