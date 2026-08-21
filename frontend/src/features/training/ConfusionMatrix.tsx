import { useMemo, useState } from "react";

interface ConfusionMatrixProps {
  confusion: { labels: string[]; matrix: number[][] } | null;
}

const MAX_VISIBLE_LABELS = 12;

/** Picks which label indices to show by default: the labels with the
 * highest row totals (the classes with the most instances), capped at
 * MAX_VISIBLE_LABELS. `background` is always kept when present, since
 * that's where detection misses go and hiding it would be misleading. */
function pickDefaultIndices(labels: string[], matrix: number[][]): number[] {
  if (labels.length <= MAX_VISIBLE_LABELS) {
    return labels.map((_, i) => i);
  }

  const rowTotals = matrix.map((row) => row.reduce((sum, v) => sum + v, 0));
  const backgroundIndex = labels.indexOf("background");

  const ranked = labels
    .map((_, i) => i)
    .filter((i) => i !== backgroundIndex)
    .sort((a, b) => rowTotals[b] - rowTotals[a]);

  const keepCount = backgroundIndex >= 0 ? MAX_VISIBLE_LABELS - 1 : MAX_VISIBLE_LABELS;
  const kept = ranked.slice(0, keepCount);
  if (backgroundIndex >= 0) {
    kept.push(backgroundIndex);
  }

  return kept.sort((a, b) => a - b);
}

export function ConfusionMatrix({ confusion }: ConfusionMatrixProps) {
  const [showAll, setShowAll] = useState(false);

  const labels = confusion?.labels ?? [];
  const matrix = confusion?.matrix ?? [];

  const defaultIndices = useMemo(
    () => pickDefaultIndices(labels, matrix),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [labels.join(","), matrix.length],
  );

  if (!confusion || matrix.length === 0) {
    return null;
  }

  const isTruncated = labels.length > MAX_VISIBLE_LABELS;
  const indices = showAll || !isTruncated ? labels.map((_, i) => i) : defaultIndices;

  const max = matrix.reduce(
    (acc, row) => row.reduce((rowAcc, v) => Math.max(rowAcc, v), acc),
    0,
  );

  return (
    <div className="text-gray-200">
      <div className="overflow-x-auto">
        <table className="border-collapse text-xs">
          <thead>
            <tr>
              <th className="border-b border-r border-gray-800 px-2 py-1 text-left align-bottom text-gray-500">
                actual \ predicted
              </th>
              {indices.map((col) => (
                <th
                  key={col}
                  className="border-b border-gray-800 px-2 py-1 text-center font-normal text-gray-400"
                  style={{ writingMode: "vertical-rl" }}
                >
                  {labels[col]}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {indices.map((row) => (
              <tr key={row}>
                <th className="border-r border-gray-800 px-2 py-1 text-right font-normal text-gray-400">
                  {labels[row]}
                </th>
                {indices.map((col) => {
                  const value = matrix[row]?.[col] ?? 0;
                  const intensity = max > 0 ? value / max : 0;
                  return (
                    <td
                      key={col}
                      data-cell
                      className="px-2 py-1 text-center text-gray-200"
                      style={{
                        backgroundColor: `rgba(96, 165, 250, ${intensity})`,
                      }}
                    >
                      {value}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {isTruncated && !showAll && (
        <button
          type="button"
          onClick={() => setShowAll(true)}
          className="mt-2 rounded border border-gray-700 px-2 py-1 text-xs text-gray-300 hover:text-gray-100"
        >
          Show all {labels.length} classes
        </button>
      )}
    </div>
  );
}
