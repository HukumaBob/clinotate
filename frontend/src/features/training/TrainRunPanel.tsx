import { useEffect, useRef } from "react";

import type { components } from "../../shared/api/generated/schema";

type TrainingRunRead = components["schemas"]["TrainingRunRead"];

interface TrainRunPanelProps {
  run: TrainingRunRead | null;
  logText: string;
  onStop: () => void;
  stopPending: boolean;
}

const STATUS_STYLES: Record<string, string> = {
  pending: "bg-gray-700 text-gray-200",
  running: "bg-blue-600 text-white",
  succeeded: "bg-green-700 text-white",
  failed: "bg-red-700 text-white",
  stopped: "bg-yellow-700 text-white",
};

/** Pixels of slack allowed between the visible bottom edge and the true
 * bottom of the scrollable content before we stop treating the user as
 * "at the bottom". Needed because sub-pixel rounding and browser zoom
 * mean scrollTop + clientHeight rarely equals scrollHeight exactly. */
export const STICK_TO_BOTTOM_TOLERANCE_PX = 24;

/** Pure decision logic for the "stick to bottom" auto-scroll pattern,
 * factored out so it can be unit tested without relying on jsdom layout
 * (jsdom always reports 0 for scrollHeight/clientHeight, which is why the
 * component itself isn't a useful thing to assert scroll behavior on). */
export function shouldStickToBottom(
  scrollTop: number,
  clientHeight: number,
  scrollHeight: number,
  tolerance: number = STICK_TO_BOTTOM_TOLERANCE_PX,
): boolean {
  const distanceFromBottom = scrollHeight - (scrollTop + clientHeight);
  return distanceFromBottom <= tolerance;
}

export function TrainRunPanel({ run, logText, onStop, stopPending }: TrainRunPanelProps) {
  const logRef = useRef<HTMLPreElement>(null);
  // Tracks whether the user was scrolled to (or near) the bottom just
  // before this update, so new content only yanks the view down when
  // that was already true. Starts true so the initial render (and the
  // common case of a freshly opened panel) follows the tail.
  const wasAtBottomRef = useRef(true);

  useEffect(() => {
    const el = logRef.current;
    if (el && wasAtBottomRef.current) {
      el.scrollTop = el.scrollHeight;
    }
  }, [logText]);

  function handleLogScroll(event: React.UIEvent<HTMLPreElement>) {
    const el = event.currentTarget;
    wasAtBottomRef.current = shouldStickToBottom(el.scrollTop, el.clientHeight, el.scrollHeight);
  }

  if (!run) {
    return (
      <div className="flex h-full items-center justify-center rounded border border-gray-800 bg-gray-900 p-6 text-sm text-gray-400">
        No training run yet — start one from the config panel.
      </div>
    );
  }

  const percent =
    run.total_epochs > 0 ? Math.round((run.current_epoch / run.total_epochs) * 100) : 0;
  const canStop = run.status === "pending" || run.status === "running";
  const stopDisabled = stopPending || run.stop_requested;

  return (
    <div className="flex h-full flex-col gap-4 rounded border border-gray-800 bg-gray-900 p-4 text-sm text-gray-200">
      <div className="flex items-center justify-between">
        <span
          className={`rounded px-2 py-0.5 text-xs font-medium uppercase tracking-wide ${
            STATUS_STYLES[run.status] ?? "bg-gray-700 text-gray-200"
          }`}
        >
          {run.status}
        </span>
        <span className="text-xs text-gray-400">{`Epoch ${run.current_epoch} / ${run.total_epochs}`}</span>
      </div>

      <div
        role="progressbar"
        aria-valuenow={percent}
        aria-valuemin={0}
        aria-valuemax={100}
        className="h-2 w-full overflow-hidden rounded bg-gray-800"
      >
        <div
          className="h-full rounded bg-blue-500 transition-all"
          style={{ width: `${percent}%` }}
        />
      </div>

      {run.error && (
        <div className="rounded border border-red-800 bg-red-950 px-3 py-2 text-xs text-red-300">
          {run.error}
        </div>
      )}

      <pre
        ref={logRef}
        onScroll={handleLogScroll}
        className="min-h-0 flex-1 overflow-auto whitespace-pre-wrap rounded border border-gray-800 bg-gray-950 p-3 font-mono text-xs text-gray-300"
      >
        {logText}
      </pre>

      {canStop && (
        <div className="flex flex-col gap-1">
          <button
            type="button"
            onClick={onStop}
            disabled={stopDisabled}
            className="self-start rounded border border-gray-700 bg-red-700 px-3 py-1.5 text-sm font-medium text-white hover:bg-red-600 disabled:cursor-not-allowed disabled:bg-gray-700 disabled:text-gray-400"
          >
            {stopDisabled ? "Stopping…" : "Stop"}
          </button>
          <p className="text-xs text-gray-500">Stops after the current epoch finishes.</p>
        </div>
      )}
    </div>
  );
}
