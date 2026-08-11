import { useStore } from "zustand/react";

import { useSettings } from "../../entities/useSettings";
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

  const settingsQuery = useSettings();
  // See docs/superpowers/specs/2026-08-11-settings-page-design.md: while
  // the setting is still loading, no combined cap is applied yet (budget
  // clamp skipped) rather than blocking the whole control on a spinner --
  // Track range inputs render immediately using only the per-sequence
  // bounds, and re-clamp once the value arrives.
  const combinedCap = settingsQuery.data?.max_track_range_frames ?? Infinity;

  const backwardBudget = Math.max(0, combinedCap - forward);
  const forwardBudget = Math.max(0, combinedCap - backward);

  return (
    <div className="space-y-2">
      <div className="flex gap-2">
        <label className="flex-1 text-xs text-gray-400">
          Backward
          <div className="mt-1 flex gap-1">
            <input
              type="number"
              min={0}
              max={backwardBudget}
              value={backward}
              onChange={(event) => setBackward(Math.min(Number(event.target.value), backwardBudget))}
              className="w-full rounded border border-gray-700 bg-gray-800 px-2 py-1 text-sm text-gray-100"
            />
            <button
              type="button"
              aria-label="Max backward"
              onClick={() => setBackward(Math.min(maxBackward, backwardBudget))}
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
              max={forwardBudget}
              value={forward}
              onChange={(event) => setForward(Math.min(Number(event.target.value), forwardBudget))}
              className="w-full rounded border border-gray-700 bg-gray-800 px-2 py-1 text-sm text-gray-100"
            />
            <button
              type="button"
              aria-label="Max forward"
              onClick={() => setForward(Math.min(maxForward, forwardBudget))}
              className="shrink-0 rounded border border-gray-700 px-2 py-1 text-xs text-gray-400 hover:bg-gray-800 hover:text-gray-200"
            >
              Max
            </button>
          </div>
        </label>
      </div>
      {settingsQuery.data && (
        <p className="text-xs text-gray-500">
          Combined backward + forward is capped at {combinedCap} frames to protect GPU memory.
        </p>
      )}
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
