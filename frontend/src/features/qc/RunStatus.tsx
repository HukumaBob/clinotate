import type { InferenceRun } from "../../entities/useInferenceRuns";

const BADGE: Record<string, string> = {
  pending: "bg-gray-700 text-gray-200",
  running: "bg-blue-700 text-white",
  succeeded: "bg-green-700 text-white",
  failed: "bg-red-700 text-white",
};

export function RunStatus({ run }: { run: InferenceRun | null }) {
  if (run === null) {
    return (
      <div className="rounded border border-gray-800 bg-gray-900 p-4 text-sm text-gray-500">
        No run selected.
      </div>
    );
  }

  const percent =
    run.frames_total > 0 ? Math.round((run.frames_processed / run.frames_total) * 100) : 0;

  return (
    <div className="flex flex-col gap-3 rounded border border-gray-800 bg-gray-900 p-4">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold text-gray-200">Run #{run.id}</h2>
        <span className={`rounded px-2 py-0.5 text-xs ${BADGE[run.status] ?? BADGE.pending}`}>
          {run.status}
        </span>
      </div>
      <div
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent}
        className="h-2 overflow-hidden rounded bg-gray-800"
      >
        <div className="h-full bg-blue-500" style={{ width: `${percent}%` }} />
      </div>
      <p className="text-sm text-gray-400">
        {run.frames_processed} / {run.frames_total} frames
      </p>
      {run.error && <p className="text-sm text-red-400">{run.error}</p>}
    </div>
  );
}
