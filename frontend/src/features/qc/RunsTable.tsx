import { useState } from "react";
import { Link } from "react-router-dom";

import type { InferenceRun } from "../../entities/useInferenceRuns";

interface RunsTableProps {
  runs: InferenceRun[];
  videoTitles: Record<number, string>;
  onDelete: (id: number, force: boolean) => void;
}

const BUTTON = "rounded border border-gray-700 px-2 py-1 text-xs text-gray-300";

export function RunsTable({ runs, videoTitles, onDelete }: RunsTableProps) {
  const [armed, setArmed] = useState<number | null>(null);

  if (runs.length === 0) {
    return <p className="text-sm text-gray-500">No runs yet.</p>;
  }

  return (
    <table className="w-full text-left text-sm text-gray-200">
      <thead>
        <tr className="border-b border-gray-800 text-gray-400">
          <th className="px-4 py-2 font-normal">Video</th>
          <th className="px-4 py-2 font-normal">Model</th>
          <th className="px-4 py-2 font-normal">Stride</th>
          <th className="px-4 py-2 font-normal">Status</th>
          <th className="px-4 py-2 font-normal">Date</th>
          <th className="px-4 py-2 text-right font-normal">Actions</th>
        </tr>
      </thead>
      <tbody>
        {runs.map((run) => {
          const active = run.status === "pending" || run.status === "running";
          return (
            <tr key={run.id} className="border-b border-gray-900">
              <td className="px-4 py-2">{videoTitles[run.video_id] ?? `Video ${run.video_id}`}</td>
              <td className="px-4 py-2 text-gray-400">{run.model_name}</td>
              <td className="px-4 py-2 text-gray-400">{run.frame_stride}</td>
              <td className="px-4 py-2 text-gray-400">
                <div>{run.status}</div>
                {run.status === "failed" && run.error && (
                  <div className="max-w-xs truncate text-xs text-red-400" title={run.error}>
                    {run.error}
                  </div>
                )}
              </td>
              <td className="px-4 py-2 text-gray-400">
                {new Date(run.created_at).toLocaleDateString()}
              </td>
              <td className="px-4 py-2 text-right">
                {run.status === "succeeded" ? (
                  <Link to={`/qc/${run.id}`} className={`${BUTTON} mr-2 inline-block hover:text-gray-100`}>
                    View
                  </Link>
                ) : (
                  <button type="button" disabled className={`${BUTTON} mr-2 opacity-50`}>
                    View
                  </button>
                )}
                {armed === run.id ? (
                  <button
                    type="button"
                    className="rounded bg-red-700 px-2 py-1 text-xs text-white"
                    onClick={() => {
                      onDelete(run.id, active);
                      setArmed(null);
                    }}
                  >
                    Confirm
                  </button>
                ) : (
                  <button
                    type="button"
                    className={BUTTON}
                    onClick={() => setArmed(run.id)}
                  >
                    {active ? "Force delete" : "Delete"}
                  </button>
                )}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
