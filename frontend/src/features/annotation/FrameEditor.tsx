import { useMemo, useState } from "react";

import { useAnnotations } from "../../entities/useAnnotations";
import { useFrame } from "../../entities/useFrames";
import { useJob } from "../../entities/useJobs";
import { useSam2Predict, useSam2Track } from "../../entities/useSegmentation";
import { createFrameEditorStore } from "./frameEditorStore";
import { FrameCanvas } from "./FrameCanvas";
import { ToolsPanel } from "./ToolsPanel";

interface FrameEditorProps {
  frameId: number;
  onClose: () => void;
}

export function FrameEditor({ frameId, onClose }: FrameEditorProps) {
  const store = useMemo(() => createFrameEditorStore(), [frameId]);
  const [activeJobId, setActiveJobId] = useState<number | null>(null);

  const frameQuery = useFrame(frameId);
  const annotationsQuery = useAnnotations(frameId);
  const jobQuery = useJob(activeJobId);
  const predictMutation = useSam2Predict();
  const trackMutation = useSam2Track();

  function handleAddMask() {
    const state = store.getState();
    if (state.labelTagId === null || state.pendingPrompts.length === 0) return;
    predictMutation.mutate(
      { frame_id: frameId, label_id: state.labelTagId, prompts: state.pendingPrompts },
      {
        onSuccess: (data) => {
          if (data) setActiveJobId(data.id);
          store.getState().clearPrompts();
        },
      },
    );
  }

  function handleTrack() {
    const state = store.getState();
    if (state.labelTagId === null) return;
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
        },
      },
    );
  }

  if (!frameQuery.data) {
    return <p className="p-8 text-sm text-gray-500">Loading frame...</p>;
  }

  return (
    <div className="flex min-h-screen bg-gray-950 text-gray-100">
      <div className="flex flex-1 flex-col">
        <div className="border-b border-gray-800 p-3">
          <button
            type="button"
            onClick={onClose}
            className="rounded border border-gray-700 px-3 py-1 text-sm text-gray-200 hover:bg-gray-800"
          >
            ✕ Back to grid
          </button>
          {jobQuery.data && (
            <span className="ml-3 text-sm text-gray-400">
              Job #{jobQuery.data.id}: {jobQuery.data.status} ({jobQuery.data.progress}%)
            </span>
          )}
        </div>
        <div className="flex-1 p-4">
          <FrameCanvas frame={frameQuery.data} annotations={annotationsQuery.data ?? []} store={store} />
        </div>
      </div>
      <ToolsPanel
        store={store}
        annotations={annotationsQuery.data ?? []}
        onAddMask={handleAddMask}
        onTrack={handleTrack}
      />
    </div>
  );
}
