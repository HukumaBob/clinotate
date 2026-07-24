import { useState } from "react";
import { useParams } from "react-router-dom";

import { useFrames } from "../../entities/useFrames";
import { FrameThumbnail } from "./FrameThumbnail";

export function SequenceGridPage() {
  const { sequenceId } = useParams<{ sequenceId: string }>();
  const sequenceIdNumber = Number(sequenceId);
  const [selectedFrameId, setSelectedFrameId] = useState<number | null>(null);

  const framesQuery = useFrames(sequenceIdNumber);

  if (selectedFrameId !== null) {
    return (
      <div className="min-h-screen bg-gray-950 text-gray-100">
        <div className="border-b border-gray-800 p-3">
          <button
            type="button"
            onClick={() => setSelectedFrameId(null)}
            className="rounded border border-gray-700 px-3 py-1 text-sm text-gray-200 hover:bg-gray-800"
          >
            ✕ Back to grid
          </button>
        </div>
        {/* Replaced with <FrameEditor frameId={selectedFrameId} /> once it exists (Task 14). */}
        <div data-testid="frame-editor-slot" />
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-950 p-8 text-gray-100">
      <h1 className="mb-4 text-xl font-semibold">Sequence #{sequenceId}</h1>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5">
        {(framesQuery.data ?? []).map((frame) => (
          <FrameThumbnail
            key={frame.id}
            frameId={frame.id}
            imageUrl={frame.image_url}
            onClick={() => setSelectedFrameId(frame.id)}
          />
        ))}
      </div>
    </div>
  );
}
