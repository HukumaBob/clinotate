import type { components } from "../../shared/api/generated/schema";
import { isActiveRun } from "./runLogic";

type TrainingRunRead = components["schemas"]["TrainingRunRead"];

interface ActiveRunStripProps {
  run: TrainingRunRead;
  headline: { label: string; value: string };
  onStop: () => void;
  stopPending: boolean;
  onOpen: () => void;
}

export function ActiveRunStrip({ run, headline, onStop, stopPending, onOpen }: ActiveRunStripProps) {
  if (!isActiveRun(run)) return null;
  const percent =
    run.total_epochs > 0 ? Math.round((run.current_epoch / run.total_epochs) * 100) : 0;
  const stopDisabled = stopPending || run.stop_requested;
  return (
    <div className="flex flex-col gap-2 rounded border border-blue-900 bg-gray-900 px-4 py-2 text-sm text-gray-200">
      <div className="flex items-center justify-between gap-4">
        <button
          type="button"
          onClick={onOpen}
          aria-label={`Open run ${run.id}`}
          className="flex min-w-0 flex-1 items-center gap-2 text-left hover:text-white"
        >
          <span aria-hidden="true">▶</span>
          <span className="text-gray-400">{`#${run.id}`}</span>
          <span className="truncate">{run.name || run.base_model}</span>
          <span className="whitespace-nowrap text-gray-400">{`epoch ${run.current_epoch} / ${run.total_epochs}`}</span>
          <span className="whitespace-nowrap text-gray-300">
            {headline.label ? `${headline.label} ${headline.value}` : headline.value}
          </span>
        </button>
        <div className="flex items-center gap-3">
          <p className="text-xs text-gray-500">Stops after the current epoch finishes.</p>
          <button
            type="button"
            onClick={onStop}
            disabled={stopDisabled}
            className="rounded border border-gray-700 bg-red-700 px-3 py-1 text-sm font-medium text-white hover:bg-red-600 disabled:cursor-not-allowed disabled:bg-gray-700 disabled:text-gray-400"
          >
            {stopDisabled ? "Stopping…" : "Stop"}
          </button>
        </div>
      </div>
      <div
        role="progressbar"
        aria-valuenow={percent}
        aria-valuemin={0}
        aria-valuemax={100}
        className="h-1 w-full overflow-hidden rounded bg-gray-800"
      >
        <div className="h-full rounded bg-blue-500 transition-all" style={{ width: `${percent}%` }} />
      </div>
    </div>
  );
}
