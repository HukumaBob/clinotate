import { useEffect, useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";

import { useAnnotations, useDeleteAnnotation } from "../../entities/useAnnotations";
import { useFrame } from "../../entities/useFrames";
import { useJob } from "../../entities/useJobs";
import { useSam2Predict, useSam2Track } from "../../entities/useSegmentation";
import { createFrameEditorStore, type PromptDraft } from "./frameEditorStore";
import { FrameCanvas } from "./FrameCanvas";
import { ToolsPanel } from "./ToolsPanel";
import type { components } from "../../shared/api/generated/schema";

type FrameRead = components["schemas"]["FrameRead"];

interface FrameEditorProps {
  frameId: number;
  frames: FrameRead[];
  onClose: () => void;
  onFrameChange: (frameId: number) => void;
}

export function FrameEditor({ frameId, frames, onClose, onFrameChange }: FrameEditorProps) {
  const store = useMemo(() => createFrameEditorStore(), [frameId]);
  const [activeJobId, setActiveJobId] = useState<number | null>(null);
  const queryClient = useQueryClient();

  const frameQuery = useFrame(frameId);
  const annotationsQuery = useAnnotations(frameId);
  const jobQuery = useJob(activeJobId);
  const predictMutation = useSam2Predict();
  const trackMutation = useSam2Track();
  const deleteAnnotation = useDeleteAnnotation(frameId);

  const orderedFrames = [...frames].sort((a, b) => a.frame_index - b.frame_index);
  const currentIndex = orderedFrames.findIndex((f) => f.id === frameId);
  const prevFrame = currentIndex > 0 ? orderedFrames[currentIndex - 1] : null;
  const nextFrame = currentIndex >= 0 && currentIndex < orderedFrames.length - 1 ? orderedFrames[currentIndex + 1] : null;

  useEffect(() => {
    if (jobQuery.data?.status === "succeeded") {
      queryClient.invalidateQueries({ queryKey: ["annotations", frameId] });
    }
  }, [jobQuery.data?.status, jobQuery.data?.id, frameId, queryClient]);

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      const target = event.target as HTMLElement | null;
      if (target && (target.tagName === "SELECT" || target.tagName === "INPUT" || target.tagName === "TEXTAREA")) {
        return;
      }
      if (event.key === "ArrowLeft" && prevFrame) onFrameChange(prevFrame.id);
      if (event.key === "ArrowRight" && nextFrame) onFrameChange(nextFrame.id);
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [prevFrame, nextFrame, onFrameChange]);

  // Re-predicts using the FULL accumulated prompt set for the in-progress
  // object and replaces the previous draft mask (if any) with the new one,
  // so refining one object via several point/box gestures never leaves a
  // trail of stale draft Annotation rows behind -- only the latest guess
  // for the object being worked on exists at any time. Does NOT clear
  // pendingPrompts: the object stays in progress until Track/Generate from
  // mask explicitly finishes it.
  function refinePredict(prompts: PromptDraft[]) {
    const state = store.getState();
    if (state.labelTagId === null) return;
    const previousDraftId = state.draftAnnotationId;

    // The last remaining refinement point was just removed -- nothing left
    // to predict from, so just drop the now-orphaned draft mask instead of
    // firing a predict call with an empty prompt list.
    if (prompts.length === 0) {
      if (previousDraftId !== null) {
        deleteAnnotation.mutate(previousDraftId);
        store.getState().setDraftAnnotationId(null);
      }
      return;
    }

    predictMutation.mutate(
      { frame_id: frameId, label_id: state.labelTagId, prompts },
      {
        onSuccess: (data) => {
          if (!data) return;
          setActiveJobId(data.id);
          if (previousDraftId !== null) {
            deleteAnnotation.mutate(previousDraftId);
          }
        },
      },
    );
  }

  // A predict job's new Annotation becomes the current draft once the job
  // succeeds -- recorded here (not at submit time) since the Annotation id
  // isn't known until the job result is read back and annotations refetch.
  useEffect(() => {
    if (jobQuery.data?.status === "succeeded" && jobQuery.data.job_type === "sam2_predict") {
      const created = annotationsQuery.data?.find((a) => a.job_id === jobQuery.data?.id);
      if (created) store.getState().setDraftAnnotationId(created.id);
    }
  }, [jobQuery.data?.status, jobQuery.data?.id, jobQuery.data?.job_type, annotationsQuery.data, store]);

  function handlePointOrBoxSubmit(prompts: PromptDraft[]) {
    refinePredict(prompts);
  }

  function handleGenerateFromMask() {
    refinePredict(store.getState().pendingPrompts);
    store.getState().clearPrompts();
  }

  // Deleting the mask that's currently being refined (the draft) must also
  // drop its accumulated point/box markers -- otherwise the points stay on
  // screen pointing at a mask that no longer exists.
  function handleRemoveAnnotation(annotationId: number) {
    deleteAnnotation.mutate(annotationId);
    if (store.getState().draftAnnotationId === annotationId) {
      store.getState().clearPrompts();
    }
  }

  function handleTrack() {
    const state = store.getState();
    if (state.labelTagId === null || state.pendingPrompts.length === 0) return;
    trackMutation.mutate(
      {
        sequence_id: frameQuery.data?.sequence_id ?? 0,
        label_id: state.labelTagId,
        prompts: state.pendingPrompts,
        anchor_frame_id: frameId,
        backward: state.backward,
        forward: state.forward,
      },
      {
        onSuccess: (data) => {
          if (data) setActiveJobId(data.id);
          const draftId = store.getState().draftAnnotationId;
          if (draftId !== null) deleteAnnotation.mutate(draftId);
          store.getState().clearPrompts();
        },
      },
    );
  }

  if (!frameQuery.data) {
    return <p className="p-8 text-sm text-gray-500">Loading frame...</p>;
  }

  return (
    <div className="flex h-screen flex-col bg-gray-950 text-gray-100">
      <div className="flex items-center gap-3 border-b border-gray-800 p-3">
        <button
          type="button"
          onClick={onClose}
          className="rounded border border-gray-700 px-3 py-1 text-sm text-gray-200 hover:bg-gray-800"
        >
          ✕ Back to grid
        </button>
        <div className="flex items-center gap-2">
          <button
            type="button"
            aria-label="Prev frame"
            disabled={!prevFrame}
            onClick={() => prevFrame && onFrameChange(prevFrame.id)}
            className="rounded border border-gray-700 px-2 py-1 text-sm text-gray-200 hover:bg-gray-800 disabled:cursor-not-allowed disabled:opacity-40"
          >
            ‹ Prev
          </button>
          <span className="text-sm text-gray-400">
            Frame {currentIndex + 1} of {orderedFrames.length}
          </span>
          <button
            type="button"
            aria-label="Next frame"
            disabled={!nextFrame}
            onClick={() => nextFrame && onFrameChange(nextFrame.id)}
            className="rounded border border-gray-700 px-2 py-1 text-sm text-gray-200 hover:bg-gray-800 disabled:cursor-not-allowed disabled:opacity-40"
          >
            Next ›
          </button>
        </div>
        {jobQuery.data && (
          <span className="ml-3 text-sm text-gray-400">
            Job #{jobQuery.data.id}: {jobQuery.data.status} ({jobQuery.data.progress}%)
          </span>
        )}
      </div>
      <div className="flex flex-1 overflow-hidden">
        <div className="flex flex-1 items-center justify-center overflow-hidden p-4">
          <div
            className="relative"
            style={{
              aspectRatio: `${frameQuery.data.width} / ${frameQuery.data.height}`,
              maxWidth: "100%",
              maxHeight: "100%",
              width: "100%",
              height: "100%",
            }}
          >
            <FrameCanvas
              frame={frameQuery.data}
              annotations={annotationsQuery.data ?? []}
              store={store}
              onPointOrBoxSubmit={handlePointOrBoxSubmit}
              onRemoveAnnotation={handleRemoveAnnotation}
            />
          </div>
        </div>
        <ToolsPanel
          store={store}
          annotations={annotationsQuery.data ?? []}
          frameId={frameId}
          onGenerateFromMask={handleGenerateFromMask}
          onTrack={handleTrack}
        />
      </div>
    </div>
  );
}
