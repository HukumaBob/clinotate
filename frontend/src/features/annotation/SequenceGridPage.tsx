import { useState } from "react";
import { useParams } from "react-router-dom";

import { useDeleteFrames, useFrames } from "../../entities/useFrames";
import { useSequence } from "../../entities/useSequence";
import { useTaxonomyTree } from "../../entities/useTaxonomyTree";
import { FrameEditor } from "./FrameEditor";
import { FrameThumbnail } from "./FrameThumbnail";
import { SequenceGridToolbar } from "./SequenceGridToolbar";

export function SequenceGridPage() {
  const { sequenceId } = useParams<{ sequenceId: string }>();
  const sequenceIdNumber = Number(sequenceId);
  const [selectedFrameId, setSelectedFrameId] = useState<number | null>(null);
  const [isSelectMode, setIsSelectMode] = useState(false);
  const [selectedFrameIds, setSelectedFrameIds] = useState<Set<number>>(new Set());

  const framesQuery = useFrames(sequenceIdNumber);
  const sequenceQuery = useSequence(sequenceIdNumber);
  const taxonomyTreeQuery = useTaxonomyTree(sequenceQuery.data?.procedure_id ?? null);
  const taxonomyTree = taxonomyTreeQuery.data ?? [];
  const deleteFrames = useDeleteFrames(sequenceIdNumber);

  if (selectedFrameId !== null) {
    return (
      <FrameEditor
        frameId={selectedFrameId}
        frames={framesQuery.data ?? []}
        onClose={() => setSelectedFrameId(null)}
        onFrameChange={setSelectedFrameId}
      />
    );
  }

  function toggleFrameSelected(frameId: number) {
    setSelectedFrameIds((current) => {
      const next = new Set(current);
      if (next.has(frameId)) {
        next.delete(frameId);
      } else {
        next.add(frameId);
      }
      return next;
    });
  }

  function handleDeleteSelected() {
    deleteFrames.mutate(Array.from(selectedFrameIds), {
      onSuccess: () => setSelectedFrameIds(new Set()),
    });
  }

  function handleCancelSelectMode() {
    setIsSelectMode(false);
    setSelectedFrameIds(new Set());
  }

  const sequenceName = sequenceQuery.data?.name ?? `Sequence #${sequenceId}`;

  return (
    <div className="min-h-full bg-gray-950 text-gray-100">
      <div className="sticky top-0 z-10 bg-gray-950">
        <SequenceGridToolbar
          sequenceName={sequenceName}
          isSelectMode={isSelectMode}
          onToggleSelectMode={() => setIsSelectMode((current) => !current)}
          selectedCount={selectedFrameIds.size}
          onDeleteSelected={handleDeleteSelected}
          onCancel={handleCancelSelectMode}
        />
      </div>
      <div className="grid grid-cols-2 gap-3 p-8 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5">
        {(framesQuery.data ?? []).map((frame) => (
          <FrameThumbnail
            key={frame.id}
            frameId={frame.id}
            imageUrl={frame.image_url}
            taxonomyTree={taxonomyTree}
            onClick={() => setSelectedFrameId(frame.id)}
            selectable={isSelectMode}
            selected={selectedFrameIds.has(frame.id)}
            onToggleSelect={() => toggleFrameSelected(frame.id)}
          />
        ))}
      </div>
    </div>
  );
}
