import { useEffect, useState } from "react";

import type { components } from "../../shared/api/generated/schema";
import { MAX_COMPARE } from "./compareLogic";
import { bestRunId, formatDuration, headlineScore, settingsLine } from "./runLogic";

type TrainingRunRead = components["schemas"]["TrainingRunRead"];

export const STATUS_STYLES: Record<string, string> = {
  pending: "bg-gray-700 text-gray-200",
  running: "bg-blue-600 text-white",
  succeeded: "bg-green-700 text-white",
  failed: "bg-red-700 text-white",
  stopped: "bg-yellow-700 text-white",
};

interface RunsTableProps {
  runs: TrainingRunRead[];
  selectedRunId: number | null;
  loading: boolean;
  error: string | null;
  onOpen: (runId: number) => void;
  onRepeat: (run: TrainingRunRead) => void;
  onDelete: (run: TrainingRunRead) => void;
  deleteError: string | null;
  selectedForCompare?: number[];
  onToggleCompare?: (runId: number) => void;
  onCompare?: () => void;
}

const BUTTON = "rounded border border-gray-700 px-2 py-1 text-xs text-gray-300 hover:text-gray-100";
const DISABLED = "disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:text-gray-300";

export function RunsTable({
  runs,
  selectedRunId,
  loading,
  error,
  onOpen,
  onRepeat,
  onDelete,
  deleteError,
  selectedForCompare = [],
  onToggleCompare = () => {},
  onCompare = () => {},
}: RunsTableProps) {
  const [armed, setArmed] = useState<number | null>(null);

  useEffect(() => {
    setArmed(null);
  }, [runs]);

  if (error) return <p className="text-sm text-red-400">{error}</p>;
  if (loading) return <p className="text-sm text-gray-500">Loading runs…</p>;
  if (runs.length === 0) {
    return (
      <p className="text-sm text-gray-500">
        No runs on this dataset yet. Start one from the New run tab.
      </p>
    );
  }

  const best = bestRunId(runs);
  const now = new Date();

  return (
    <div>
      {deleteError && (
        <p role="alert" className="mb-2 text-sm text-red-400">
          {deleteError}
        </p>
      )}
      <div className="mb-2 flex items-center gap-3">
        <button
          type="button"
          className={`${BUTTON} ${DISABLED}`}
          disabled={selectedForCompare.length < 2}
          onClick={onCompare}
        >
          {`Compare (${selectedForCompare.length})`}
        </button>
        <span className="text-xs text-gray-500">Select 2–3 runs of this dataset.</span>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-left text-sm text-gray-200">
          <thead>
            <tr className="border-b border-gray-800 text-gray-400">
              <th className="px-3 py-2 font-normal">
                <span className="sr-only">Compare</span>
              </th>
              <th className="px-3 py-2 font-normal">Run</th>
              <th className="px-3 py-2 font-normal">Name</th>
              <th className="px-3 py-2 font-normal">Base</th>
              <th className="px-3 py-2 font-normal">Settings</th>
              <th className="px-3 py-2 font-normal">Status</th>
              <th className="px-3 py-2 font-normal">Score</th>
              <th className="px-3 py-2 font-normal">Duration</th>
              <th className="px-3 py-2 font-normal">Created</th>
              <th className="px-3 py-2 text-right font-normal">Actions</th>
            </tr>
          </thead>
          <tbody>
            {runs.map((run) => {
              const score = headlineScore(run.task_type, run.metrics as Record<string, unknown>);
              const active = run.status === "pending" || run.status === "running";
              const ownsModel = run.model_version_id !== null && run.model_version_id !== undefined;
              const blockReason = ownsModel
                ? "Delete the model first"
                : active
                  ? "Stop the run first"
                  : undefined;
              const selected = run.id === selectedRunId;
              const finished = run.status === "succeeded" || run.status === "stopped";
              const checked = selectedForCompare.includes(run.id);
              const full = selectedForCompare.length >= MAX_COMPARE && !checked;
              const compareReason = !finished && !checked
                ? "Only finished runs can be compared"
                : full
                  ? `You can compare up to ${MAX_COMPARE} runs`
                  : undefined;
              return (
                <tr
                  key={run.id}
                  aria-current={selected ? "true" : undefined}
                  className={`h-14 cursor-pointer border-b border-gray-900 ${
                    selected ? "bg-gray-800" : "hover:bg-gray-900"
                  }`}
                  onClick={(event) => {
                    if ((event.target as HTMLElement).closest("button, input")) return;
                    onOpen(run.id);
                  }}
                >
                  <td className="px-3 py-2" onClick={(e) => e.stopPropagation()}>
                    <input
                      type="checkbox"
                      aria-label={`Select run ${run.id} for comparison`}
                      checked={checked}
                      disabled={compareReason !== undefined}
                      title={compareReason}
                      onChange={() => onToggleCompare(run.id)}
                    />
                  </td>
                  <td className="px-3 py-2 text-gray-400">{`#${run.id}`}</td>
                  <td className="max-w-[16rem] px-3 py-2">
                    {run.name && <div className="truncate">{run.name}</div>}
                    {run.note && (
                      <div className="truncate text-xs text-gray-500" title={run.note}>
                        {run.note}
                      </div>
                    )}
                  </td>
                  <td className="whitespace-nowrap px-3 py-2 text-gray-400">
                    {run.base_model_version_id !== null && run.base_model_version_id !== undefined
                      ? `↳ ${run.base_model}`
                      : run.base_model}
                  </td>
                  <td className="whitespace-nowrap px-3 py-2 text-gray-400">
                    {settingsLine(run.config as Record<string, unknown>)}
                  </td>
                  <td className="px-3 py-2">
                    <span
                      className={`rounded px-2 py-0.5 text-xs ${
                        STATUS_STYLES[run.status] ?? "bg-gray-700 text-gray-200"
                      }`}
                    >
                      {run.status}
                    </span>
                  </td>
                  <td className="whitespace-nowrap px-3 py-2 text-gray-400">
                    {run.id === best ? (
                      <span className="font-semibold text-green-300" title="Best on this dataset">
                        {score.value}
                      </span>
                    ) : (
                      <span>{score.value}</span>
                    )}{" "}
                    <span className="text-xs text-gray-400">{score.label}</span>
                  </td>
                  <td className="whitespace-nowrap px-3 py-2 text-gray-400">
                    {formatDuration(run.started_at ?? null, run.finished_at ?? null, now)}
                  </td>
                  <td className="whitespace-nowrap px-3 py-2 text-gray-400">
                    {new Date(run.created_at).toLocaleDateString()}
                  </td>
                  <td className="whitespace-nowrap px-3 py-2 text-right">
                    <button
                      type="button"
                      className={`mr-2 ${BUTTON}`}
                      aria-label={`Open run ${run.id}`}
                      onClick={() => onOpen(run.id)}
                    >
                      Open
                    </button>
                    <button
                      type="button"
                      className={`mr-2 ${BUTTON}`}
                      aria-label={`Repeat run ${run.id} with changes`}
                      onClick={() => onRepeat(run)}
                    >
                      Repeat with changes
                    </button>
                    {armed === run.id && !blockReason ? (
                      <button
                        type="button"
                        className="rounded bg-red-700 px-2 py-1 text-xs text-white"
                        aria-label={`Confirm delete run ${run.id}`}
                        onClick={() => {
                          onDelete(run);
                          setArmed(null);
                        }}
                      >
                        Confirm
                      </button>
                    ) : (
                      <button
                        type="button"
                        className={`${BUTTON} ${DISABLED}`}
                        disabled={blockReason !== undefined}
                        title={blockReason}
                        aria-label={`Delete run ${run.id}`}
                        onClick={() => setArmed(run.id)}
                      >
                        Delete
                      </button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
