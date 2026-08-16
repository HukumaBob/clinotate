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
  /** Maps a child label id to its parent's label id, built from the full
   * taxonomy tree. Once a group is expanded, the report returns its leaf
   * children instead of the parent row -- none of which are parents
   * themselves, so without this map there is no surviving control to
   * re-collapse the group. A leaf row whose parent appears here (i.e. the
   * parent is currently expanded) renders a toggle that re-collapses it. */
  parentLabelIdByChildId?: Map<number, number>;
  /** Label name lookup, used to show the parent's name in the re-collapse
   * control's accessible name ("Collapse into {parentName}"). */
  labelNamesById?: Map<number, string>;
  /** Current per-class cap, keyed by label id. A class absent from this map
   * has no cap. */
  classLimits?: Record<number, number>;
  /** Called with the new cap for a class, or null to clear it. A limit of 0
   * is never sent -- that is what the exclude checkbox is for. */
  onChangeLimit?: (labelId: number, limit: number | null) => void;
}

export function BalancePanel({
  report,
  collapsed,
  excluded,
  onToggleCollapse,
  onToggleExclude,
  collapsibleLabelIds,
  excludedLabels = [],
  parentLabelIdByChildId,
  labelNamesById,
  classLimits = {},
  onChangeLimit,
}: BalancePanelProps) {
  const maxInstances = Math.max(1, ...report.classes.map((c) => c.instances));
  const totalInstances = report.classes.reduce((sum, entry) => sum + entry.instances, 0);

  function formatNumber(value: unknown, digits: number): string {
    return typeof value === "number" ? value.toFixed(digits) : "-";
  }

  return (
    <div className="flex flex-col gap-4 text-sm text-gray-200">
      {/* The headline: an absolute per-class floor. Severity is deliberately
          NOT the lead -- collapsing a group raises imbalance_ratio while being
          the right call, so optimizing severity would mislead. */}
      <div
        data-testid="below-threshold-summary"
        className="rounded border border-amber-700 bg-amber-950 px-3 py-2"
      >
        <strong>{report.below_threshold.length}</strong>{" "}
        {report.below_threshold.length === 1 ? "class" : "classes"} below{" "}
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
        {report.classes.map((entry) => {
          const isParent = collapsibleLabelIds === undefined || collapsibleLabelIds.has(entry.label_id);
          const parentId = parentLabelIdByChildId?.get(entry.label_id);
          const isExpandedChild = !isParent && parentId !== undefined;

          return (
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
            {isParent ? (
              <button
                type="button"
                data-testid={`collapse-${entry.label_id}`}
                aria-label={collapsed.has(entry.label_id) ? `Expand ${entry.name}` : `Collapse ${entry.name}`}
                className="w-32 truncate text-left text-gray-100 hover:text-blue-400"
                onClick={() => onToggleCollapse(entry.label_id)}
              >
                {collapsed.has(entry.label_id) ? "▸" : "▾"} {entry.name}
              </button>
            ) : isExpandedChild ? (
              <button
                type="button"
                data-testid={`collapse-${entry.label_id}`}
                aria-label={`Collapse into ${labelNamesById?.get(parentId) ?? `label ${parentId}`}`}
                className="w-32 truncate text-left text-gray-100 hover:text-blue-400"
                onClick={() => onToggleCollapse(parentId)}
              >
                {entry.name}
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
            {onChangeLimit && (
              <input
                type="number"
                min={1}
                data-testid={`limit-${entry.label_id}`}
                aria-label={`Limit ${entry.name}`}
                className="w-16 rounded border border-gray-700 bg-gray-950 px-1 py-0.5 text-right text-xs text-gray-100"
                value={classLimits[entry.label_id] ?? ""}
                onChange={(e) => {
                  const raw = e.target.value;
                  onChangeLimit(entry.label_id, raw === "" ? null : Number(raw));
                }}
              />
            )}
          </li>
          );
        })}
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

      <div data-testid="key-metrics" className="rounded border border-gray-800 bg-gray-900 p-3">
        <h3 className="mb-2 text-xs uppercase tracking-wide text-gray-400">Key metrics</h3>
        <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs text-gray-300">
          <dt>Total instances</dt>
          <dd className="text-right">{totalInstances}</dd>
          <dt>Total frames</dt>
          <dd className="text-right">{report.total_frames}</dd>
          <dt>Classes</dt>
          <dd className="text-right">{report.classes.length}</dd>
          <dt>Imbalance ratio</dt>
          <dd className="text-right">{formatNumber(report.metrics.imbalance_ratio, 2)}</dd>
          <dt>Gini index</dt>
          <dd className="text-right">{formatNumber(report.metrics.gini_index, 2)}</dd>
          <dt>Normalized entropy</dt>
          <dd className="text-right">{formatNumber(report.metrics.normalized_entropy, 2)}</dd>
          <dt>Min / max per class</dt>
          <dd className="text-right">
            {formatNumber(report.metrics.min_count, 0)} / {formatNumber(report.metrics.max_count, 0)}
          </dd>
          <dt>Severity</dt>
          <dd className="text-right">{String(report.metrics.severity ?? "no_data")}</dd>
        </dl>
      </div>

      {(report.recommendations ?? []).length > 0 && (
        <ul data-testid="recommendations" className="flex flex-col gap-1">
          {(report.recommendations ?? []).map((recommendation) => (
            <li
              key={`${recommendation.kind}-${recommendation.message}`}
              className="rounded border border-gray-800 bg-gray-900 px-3 py-2 text-xs text-gray-300"
            >
              {recommendation.message}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
