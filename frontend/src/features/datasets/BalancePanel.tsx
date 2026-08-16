import type { components } from "../../shared/api/generated/schema";

type BalanceReportRead = components["schemas"]["BalanceReportRead"];

interface BalancePanelProps {
  report: BalanceReportRead;
  collapsed: Set<number>;
  excluded: Set<number>;
  onToggleCollapse: (labelId: number) => void;
  onToggleExclude: (labelId: number) => void;
  /** Label ids whose row may be collapsed (i.e. has children in the taxonomy
   * tree). Defaults to "every row is collapsible" so existing callers that
   * don't pass it keep the old behavior. The report itself (ClassCountRead)
   * carries no parent/child signal, so this must come from the caller. */
  collapsibleLabelIds?: Set<number>;
  /** Classes currently excluded from the dataset. Once a class is excluded,
   * the backend drops it from report.classes, so this is the only remaining
   * way to show the user it exists and let them restore it. */
  excludedLabels?: { id: number; name: string }[];
}

export function BalancePanel({
  report,
  collapsed,
  excluded,
  onToggleCollapse,
  onToggleExclude,
  collapsibleLabelIds,
  excludedLabels = [],
}: BalancePanelProps) {
  const maxInstances = Math.max(1, ...report.classes.map((c) => c.instances));

  return (
    <div className="flex flex-col gap-4 text-sm text-gray-200">
      {/* The headline: an absolute per-class floor. Severity is deliberately
          NOT the lead -- collapsing a group raises imbalance_ratio while being
          the right call, so optimizing severity would mislead. */}
      <div
        data-testid="below-threshold-summary"
        className="rounded border border-amber-700 bg-amber-950 px-3 py-2"
      >
        <strong>{report.below_threshold.length}</strong> classes below{" "}
        {report.threshold} instances
        {report.below_threshold.length > 0 && (
          <span className="text-gray-300">: {report.below_threshold.join(", ")}</span>
        )}
      </div>

      <div className="flex gap-4 text-xs text-gray-400">
        <span data-testid="total-frames">Frames: {report.total_frames}</span>
        <span data-testid="negative-frames">Negatives: {report.negative_frames}</span>
      </div>

      <ul className="flex flex-col gap-1">
        {report.classes.map((entry) => (
          <li
            key={entry.label_id}
            data-testid={`class-row-${entry.label_id}`}
            className="flex items-center gap-2"
          >
            <input
              type="checkbox"
              data-testid={`exclude-${entry.label_id}`}
              aria-label={`Include ${entry.name}`}
              checked={!excluded.has(entry.label_id)}
              onChange={() => onToggleExclude(entry.label_id)}
            />
            {collapsibleLabelIds === undefined || collapsibleLabelIds.has(entry.label_id) ? (
              <button
                type="button"
                data-testid={`collapse-${entry.label_id}`}
                aria-label={`Toggle grouping for ${entry.name}`}
                className="w-32 truncate text-left text-gray-100 hover:text-blue-400"
                onClick={() => onToggleCollapse(entry.label_id)}
              >
                {collapsed.has(entry.label_id) ? "▸" : "▾"} {entry.name}
              </button>
            ) : (
              <span className="w-32 truncate text-left text-gray-100">{entry.name}</span>
            )}
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

      {excludedLabels.length > 0 && (
        <div
          data-testid="excluded-classes"
          className="rounded border border-gray-800 bg-gray-900 p-2"
        >
          <div className="mb-1 text-xs font-semibold text-gray-400">Excluded classes</div>
          <ul className="flex flex-col gap-1">
            {excludedLabels.map((label) => (
              <li key={label.id} className="flex items-center justify-between gap-2">
                <span className="truncate text-gray-300">{label.name}</span>
                <button
                  type="button"
                  className="text-xs text-blue-400 hover:text-blue-300"
                  onClick={() => onToggleExclude(label.id)}
                >
                  Re-include {label.name}
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div data-testid="severity-reference" className="text-xs text-gray-500">
        Reference: {String(report.metrics.severity ?? "no_data")}
        {report.metrics.imbalance_ratio !== undefined &&
          ` · ratio ${Number(report.metrics.imbalance_ratio).toFixed(1)}`}
        {report.metrics.gini_index !== undefined &&
          ` · Gini ${Number(report.metrics.gini_index).toFixed(2)}`}
      </div>
    </div>
  );
}
