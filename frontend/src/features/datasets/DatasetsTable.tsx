import { useState } from "react";

import type { components } from "../../shared/api/generated/schema";

type DatasetRead = components["schemas"]["DatasetRead"];

interface DatasetsTableProps {
  datasets: DatasetRead[];
  onDelete: (datasetId: number) => void;
  onShowMetrics: (dataset: DatasetRead) => void;
}

export function DatasetsTable({ datasets, onDelete, onShowMetrics }: DatasetsTableProps) {
  const [armed, setArmed] = useState<number | null>(null);

  if (datasets.length === 0) {
    return <p className="text-sm text-gray-500">No datasets yet.</p>;
  }

  return (
    <table className="w-full text-left text-sm text-gray-200">
      <thead>
        <tr className="border-b border-gray-800 text-gray-400">
          <th className="px-4 py-2 font-normal">Name</th>
          <th className="px-4 py-2 font-normal">Type</th>
          <th className="px-4 py-2 font-normal">Frames</th>
          <th className="px-4 py-2 font-normal">Severity</th>
          <th className="px-4 py-2 font-normal">Created</th>
          <th className="px-4 py-2 text-right font-normal">Actions</th>
        </tr>
      </thead>
      <tbody>
        {datasets.map((dataset) => (
          <tr key={dataset.id} className="border-b border-gray-900">
            <td className="px-4 py-2">{dataset.name}</td>
            <td className="px-4 py-2 text-gray-400">{dataset.task_type}</td>
            <td className="px-4 py-2">{dataset.item_count}</td>
            <td className="px-4 py-2 text-gray-400">
              {String((dataset.balance_metrics as Record<string, unknown>)?.severity ?? "-")}
            </td>
            <td className="px-4 py-2 text-gray-400">
              {new Date(dataset.created_at).toLocaleDateString()}
            </td>
            <td className="px-4 py-2 text-right">
              <button
                type="button"
                className="mr-2 rounded border border-gray-700 px-2 py-1 text-xs text-gray-300 hover:text-gray-100"
                onClick={() => onShowMetrics(dataset)}
              >
                Metrics
              </button>
              {armed === dataset.id ? (
                <button
                  type="button"
                  className="rounded bg-red-700 px-2 py-1 text-xs text-white"
                  onClick={() => {
                    onDelete(dataset.id);
                    setArmed(null);
                  }}
                >
                  Confirm
                </button>
              ) : (
                <button
                  type="button"
                  className="rounded border border-gray-700 px-2 py-1 text-xs text-gray-300"
                  onClick={() => setArmed(dataset.id)}
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
