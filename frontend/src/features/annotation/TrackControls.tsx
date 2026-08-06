import { useStore } from "zustand/react";

import type { FrameEditorStore } from "./frameEditorStore";

interface TrackControlsProps {
  store: FrameEditorStore;
  onTrack: () => void;
}

export function TrackControls({ store, onTrack }: TrackControlsProps) {
  const backward = useStore(store, (state) => state.backward);
  const forward = useStore(store, (state) => state.forward);
  const setBackward = useStore(store, (state) => state.setBackward);
  const setForward = useStore(store, (state) => state.setForward);
  const labelTagId = useStore(store, (state) => state.labelTagId);
  const pendingPrompts = useStore(store, (state) => state.pendingPrompts);
  const trackDisabled = labelTagId === null || pendingPrompts.length === 0;

  return (
    <div className="space-y-2">
      <div className="flex gap-2">
        <label className="flex-1 text-xs text-gray-400">
          Backward
          <input
            type="number"
            min={0}
            value={backward}
            onChange={(event) => setBackward(Number(event.target.value))}
            className="mt-1 w-full rounded border border-gray-700 bg-gray-800 px-2 py-1 text-sm text-gray-100"
          />
        </label>
        <label className="flex-1 text-xs text-gray-400">
          Forward
          <input
            type="number"
            min={0}
            value={forward}
            onChange={(event) => setForward(Number(event.target.value))}
            className="mt-1 w-full rounded border border-gray-700 bg-gray-800 px-2 py-1 text-sm text-gray-100"
          />
        </label>
      </div>
      <button
        type="button"
        disabled={trackDisabled}
        onClick={onTrack}
        className="w-full rounded bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-500 disabled:cursor-not-allowed disabled:opacity-40"
      >
        Track
      </button>
    </div>
  );
}
