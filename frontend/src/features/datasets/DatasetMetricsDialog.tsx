import { useEffect } from "react";

import type { components } from "../../shared/api/generated/schema";

type DatasetRead = components["schemas"]["DatasetRead"];

interface DatasetMetricsDialogProps {
  dataset: DatasetRead;
  onClose: () => void;
}

interface StoredClassCount {
  label_id: number;
  name: string;
  instances: number;
  frames: number;
}

/** The dialog renders the STORED balance snapshot only -- a dataset's
 * composition is frozen at save time, so its balance is too. It must never
 * call /datasets/balance to recompute anything. */
export function DatasetMetricsDialog({ dataset, onClose }: DatasetMetricsDialogProps) {
  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        onClose();
      }
    }
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  const snapshot = (dataset.balance_metrics ?? {}) as {
    severity?: unknown;
    threshold?: unknown;
    negative_frames?: unknown;
    below_threshold?: unknown[];
    metrics?: Record<string, unknown>;
    classes?: StoredClassCount[];
    recommendations?: { kind: string; message: string }[];
  };

  const classes = snapshot.classes ?? [];
  const hasSnapshot = Object.keys(snapshot).length > 0 && classes.length > 0;
  const splitCounts = (dataset.split_counts ?? {}) as Record<string, unknown>;
  const maxInstances = Math.max(1, ...classes.map((c) => c.instances));

  function formatNumber(value: unknown, digits: number): string {
    return typeof value === "number" ? value.toFixed(digits) : "-";
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
      <div
        role="dialog"
        aria-modal="true"
        aria-label={`${dataset.name} metrics`}
        className="max-h-[80vh] w-full max-w-lg overflow-y-auto rounded border border-gray-800 bg-gray-900 p-4 text-sm text-gray-200"
      >
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-base font-semibold text-gray-100">{dataset.name}</h2>
          <button
            type="button"
            className="rounded border border-gray-700 px-2 py-1 text-xs text-gray-300 hover:text-gray-100"
            onClick={onClose}
          >
            Close
          </button>
        </div>

        {!hasSnapshot ? (
          <p data-testid="dialog-empty" className="text-sm text-gray-500">
            No balance snapshot was saved with this dataset.
          </p>
        ) : (
          <div className="flex flex-col gap-4">
            <div className="flex gap-4 text-xs text-gray-400">
              <span data-testid="dialog-severity">
                Severity: {String(snapshot.severity ?? snapshot.metrics?.severity ?? "no_data")}
              </span>
              <span data-testid="dialog-negatives">Negatives: {String(snapshot.negative_frames ?? "-")}</span>
            </div>

            <div data-testid="dialog-splits" className="rounded border border-gray-800 bg-gray-950 p-2 text-xs text-gray-300">
              <span className="mr-3">Train: {String(splitCounts.train ?? "-")}</span>
              <span className="mr-3">Val: {String(splitCounts.val ?? "-")}</span>
              <span>Test: {String(splitCounts.test ?? "-")}</span>
            </div>

            <ul className="flex flex-col gap-1">
              {classes.map((entry) => (
                <li key={entry.label_id} className="flex items-center gap-2">
                  <span className="w-32 truncate text-left text-gray-100">{entry.name}</span>
                  <div className="h-3 flex-1 rounded bg-gray-800">
                    <div
                      className="h-3 rounded bg-blue-600"
                      style={{ width: `${(entry.instances / maxInstances) * 100}%` }}
                    />
                  </div>
                  <span className="w-24 text-right text-xs text-gray-400">
                    {entry.instances} / {entry.frames}
                  </span>
                </li>
              ))}
            </ul>

            <div className="rounded border border-gray-800 bg-gray-950 p-3">
              <h3 className="mb-2 text-xs uppercase tracking-wide text-gray-400">Key metrics</h3>
              <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs text-gray-300">
                <dt>Imbalance ratio</dt>
                <dd className="text-right">{formatNumber(snapshot.metrics?.imbalance_ratio, 2)}</dd>
                <dt>Gini index</dt>
                <dd className="text-right">{formatNumber(snapshot.metrics?.gini_index, 2)}</dd>
                <dt>Threshold</dt>
                <dd className="text-right">{String(snapshot.threshold ?? "-")}</dd>
                <dt>Below threshold</dt>
                <dd className="text-right">
                  {(snapshot.below_threshold ?? []).length > 0
                    ? `${(snapshot.below_threshold ?? []).length}: ${(snapshot.below_threshold ?? []).join(", ")}`
                    : "-"}
                </dd>
              </dl>
            </div>

            {(snapshot.recommendations ?? []).length > 0 && (
              <ul data-testid="dialog-recommendations" className="flex flex-col gap-1">
                {(snapshot.recommendations ?? []).map((recommendation) => (
                  <li
                    key={`${recommendation.kind}-${recommendation.message}`}
                    className="rounded border border-gray-800 bg-gray-950 px-3 py-2 text-xs text-gray-300"
                  >
                    {recommendation.message}
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
