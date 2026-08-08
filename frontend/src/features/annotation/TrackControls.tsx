import { useStore } from "zustand/react";

import type { FrameEditorStore } from "./frameEditorStore";

interface TrackControlsProps {
  store: FrameEditorStore;
  onTrack: () => void;
  // Number of frames available in each direction from the current frame
  // within its sequence -- backing the "Max" shortcut buttons below.
  maxBackward: number;
  maxForward: number;
}

export function TrackControls({ store, onTrack, maxBackward, maxForward }: TrackControlsProps) {
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
          <div className="mt-1 flex gap-1">
            <input
              type="number"
              min={0}
              value={backward}
              onChange={(event) => setBackward(Number(event.target.value))}
              className="w-full rounded border border-gray-700 bg-gray-800 px-2 py-1 text-sm text-gray-100"
            />
            <button
              type="button"
              aria-label="Max backward"
              onClick={() => setBackward(maxBackward)}
              className="shrink-0 rounded border border-gray-700 px-2 py-1 text-xs text-gray-400 hover:bg-gray-800 hover:text-gray-200"
            >
              Max
            </button>
          </div>
        </label>
        <label className="flex-1 text-xs text-gray-400">
          Forward
          <div className="mt-1 flex gap-1">
            <input
              type="number"
              min={0}
              value={forward}
              onChange={(event) => setForward(Number(event.target.value))}
              className="w-full rounded border border-gray-700 bg-gray-800 px-2 py-1 text-sm text-gray-100"
            />
            <button
              type="button"
              aria-label="Max forward"
              onClick={() => setForward(maxForward)}
              className="shrink-0 rounded border border-gray-700 px-2 py-1 text-xs text-gray-400 hover:bg-gray-800 hover:text-gray-200"
            >
              Max
            </button>
          </div>
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
