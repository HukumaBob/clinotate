import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";

import { useDeleteFrames, useFrames, useRankQuality } from "../../entities/useFrames";
import { useJob } from "../../entities/useJobs";
import { useSequence } from "../../entities/useSequence";
import { useTaxonomyTree } from "../../entities/useTaxonomyTree";
import { FrameEditor } from "./FrameEditor";
import { FrameThumbnail } from "./FrameThumbnail";
import { SequenceGridToolbar } from "./SequenceGridToolbar";

type MarkReason = { kind: "quality" | "similarity"; label: string };

export function SequenceGridPage() {
  const { sequenceId } = useParams<{ sequenceId: string }>();
  const sequenceIdNumber = Number(sequenceId);
  const [selectedFrameId, setSelectedFrameId] = useState<number | null>(null);
  const [isSelectMode, setIsSelectMode] = useState(false);
  const [selectedFrameIds, setSelectedFrameIds] = useState<Set<number>>(new Set());
  const [autoCheckedFrameIds, setAutoCheckedFrameIds] = useState<Set<number>>(new Set());
  const [frameMarkReasons, setFrameMarkReasons] = useState<Map<number, MarkReason>>(new Map());
  const [qualityPercent, setQualityPercent] = useState(20);
  const [activeJobId, setActiveJobId] = useState<number | null>(null);
  const [activeJobKind, setActiveJobKind] = useState<"quality" | "similarity" | null>(null);

  const framesQuery = useFrames(sequenceIdNumber);
  const sequenceQuery = useSequence(sequenceIdNumber);
  const taxonomyTreeQuery = useTaxonomyTree(sequenceQuery.data?.procedure_id ?? null);
  const taxonomyTree = taxonomyTreeQuery.data ?? [];
  const deleteFrames = useDeleteFrames(sequenceIdNumber);
  const rankQuality = useRankQuality(sequenceIdNumber);
  const jobQuery = useJob(activeJobId);

  useEffect(() => {
    if (jobQuery.data?.status === "succeeded" && activeJobKind === "quality") {
      const result = jobQuery.data.payload?.result as
        | { scores: { frame_id: number; score: number }[]; worst_ids: number[] }
        | undefined;
      if (result) {
        setIsSelectMode(true);
        setSelectedFrameIds((current) => new Set([...current, ...result.worst_ids]));
        setAutoCheckedFrameIds((current) => new Set([...current, ...result.worst_ids]));
        setFrameMarkReasons((current) => {
          const next = new Map(current);
          for (const id of result.worst_ids) {
            next.set(id, { kind: "quality", label: "low quality" });
          }
          return next;
        });
      }
      setActiveJobId(null);
      setActiveJobKind(null);
    } else if (jobQuery.data?.status === "failed") {
      setActiveJobId(null);
      setActiveJobKind(null);
    }
  }, [jobQuery.data, activeJobKind]);

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
    setAutoCheckedFrameIds((current) => {
      if (!current.has(frameId)) return current;
      const next = new Set(current);
      next.delete(frameId);
      return next;
    });
    setFrameMarkReasons((current) => {
      if (!current.has(frameId)) return current;
      const next = new Map(current);
      next.delete(frameId);
      return next;
    });
  }

  function handleDeleteSelected() {
    deleteFrames.mutate(Array.from(selectedFrameIds), {
      onSuccess: () => {
        setSelectedFrameIds(new Set());
        setAutoCheckedFrameIds(new Set());
        setFrameMarkReasons(new Map());
      },
    });
  }

  function handleCancelSelectMode() {
    setIsSelectMode(false);
    setSelectedFrameIds(new Set());
    setAutoCheckedFrameIds(new Set());
    setFrameMarkReasons(new Map());
  }

  function handleRankQuality() {
    rankQuality.mutate(qualityPercent, {
      onSuccess: (data) => {
        if (data) {
          setActiveJobId(data.id);
          setActiveJobKind("quality");
        }
      },
    });
  }

  function handleClearMarks() {
    setSelectedFrameIds((current) => {
      const next = new Set(current);
      for (const id of autoCheckedFrameIds) next.delete(id);
      return next;
    });
    setAutoCheckedFrameIds(new Set());
    setFrameMarkReasons(new Map());
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
          qualityPercent={qualityPercent}
          onQualityPercentChange={setQualityPercent}
          onRankQuality={handleRankQuality}
          isRankQualityRunning={activeJobKind === "quality"}
          hasAutoMarks={autoCheckedFrameIds.size > 0}
          onClearMarks={handleClearMarks}
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
            markReason={frameMarkReasons.get(frame.id)}
          />
        ))}
      </div>
    </div>
  );
}
