import { useState } from "react";

import type { components } from "../../shared/api/generated/schema";

type ModelVersionRead = components["schemas"]["ModelVersionRead"];

interface ModelVersionsTableProps {
  versions: ModelVersionRead[];
  onDownload: (id: number) => void;
  onDelete: (id: number) => void;
  onInfo: (id: number) => void;
}

/** The headline score, which differs by task: mAP50 measures how well
 * predicted boxes overlap real ones and does not exist for a classifier,
 * whose score is top-1 accuracy instead. Showing a dash for a classifier
 * would hide the only number it produces. Keys are Ultralytics' own. */
export function headlineScore(
  taskType: string,
  metrics: Record<string, unknown>,
): { label: string; value: string } {
  const isClassification = taskType === "classification";
  const raw = isClassification
    ? metrics["metrics/accuracy_top1"] ?? metrics["accuracy_top1"]
    : metrics["metrics/mAP50(B)"] ?? metrics["mAP50"];
  return {
    label: isClassification ? "top-1" : "mAP50",
    value: typeof raw === "number" ? raw.toFixed(3) : "—",
  };
}

export function ModelVersionsTable({
  versions,
  onDownload,
  onDelete,
  onInfo,
}: ModelVersionsTableProps) {
  const [armed, setArmed] = useState<number | null>(null);

  if (versions.length === 0) {
    return <p className="text-sm text-gray-500">No trained models yet.</p>;
  }

  return (
    <table className="w-full text-left text-sm text-gray-200">
      <thead>
        <tr className="border-b border-gray-800 text-gray-400">
          <th className="px-4 py-2 font-normal">Name</th>
          <th className="px-4 py-2 font-normal">Type</th>
          <th className="px-4 py-2 font-normal">Score</th>
          <th className="px-4 py-2 font-normal">Created</th>
          <th className="px-4 py-2 text-right font-normal">Actions</th>
        </tr>
      </thead>
      <tbody>
        {versions.map((version) => (
          <tr key={version.id} className="border-b border-gray-900">
            <td className="px-4 py-2">{version.name}</td>
            <td className="px-4 py-2 text-gray-400">{version.task_type}</td>
            <td className="px-4 py-2 text-gray-400">
              {(() => {
                const score = headlineScore(
                  version.task_type,
                  version.metrics as Record<string, unknown>,
                );
                return (
                  <>
                    {score.value}{" "}
                    <span className="text-xs text-gray-600">{score.label}</span>
                  </>
                );
              })()}
            </td>
            <td className="px-4 py-2 text-gray-400">
              {new Date(version.created_at).toLocaleDateString()}
            </td>
            <td className="px-4 py-2 text-right">
              <button
                type="button"
                className="mr-2 rounded border border-gray-700 px-2 py-1 text-xs text-gray-300 hover:text-gray-100"
                onClick={() => onInfo(version.id)}
              >
                Info
              </button>
              <button
                type="button"
                className="mr-2 rounded border border-gray-700 px-2 py-1 text-xs text-gray-300 hover:text-gray-100"
                onClick={() => onDownload(version.id)}
              >
                Download
              </button>
              {armed === version.id ? (
                <button
                  type="button"
                  className="rounded bg-red-700 px-2 py-1 text-xs text-white"
                  onClick={() => {
                    onDelete(version.id);
                    setArmed(null);
                  }}
                >
                  Confirm
                </button>
              ) : (
                <button
                  type="button"
                  className="rounded border border-gray-700 px-2 py-1 text-xs text-gray-300"
                  onClick={() => setArmed(version.id)}
                >
                  Delete
                </button>
              )}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
