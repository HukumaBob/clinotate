import { useState } from "react";

import type { CompareRunInfo } from "./CompareCurves";
import { ConfusionMatrix } from "./ConfusionMatrix";
import { confusionDifference, type Confusion } from "./compareLogic";

interface ConfusionCompareProps {
  runs: CompareRunInfo[];
  confusions: Array<Confusion | null>;
}

function formatDelta(n: number): { text: string; className: string } {
  if (n > 0) return { text: `+${n}`, className: "text-green-400" };
  if (n < 0) return { text: `−${Math.abs(n)}`, className: "text-red-400" };
  return { text: "0", className: "text-gray-500" };
}

export function ConfusionCompare({ runs, confusions }: ConfusionCompareProps) {
  const [showDiff, setShowDiff] = useState(false);

  const canToggle = runs.length === 2;
  const usable = (c: Confusion | null) => (c && c.matrix.length > 0 ? c : null);
  const difference = canToggle
    ? confusionDifference(usable(confusions[0] ?? null), usable(confusions[1] ?? null))
    : null;
  const diffVisible = canToggle && showDiff && difference !== null;

  return (
    <section className="space-y-3">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold text-gray-200">Confusion matrices</h3>
          <p className="text-xs text-gray-500">
            Rows are the true class, columns the predicted one.
          </p>
        </div>
        {canToggle && (
          <button
            type="button"
            aria-pressed={diffVisible}
            disabled={difference === null}
            title={difference === null ? "No common labels or a matrix is missing" : undefined}
            onClick={() => setShowDiff((v) => !v)}
            className={`rounded border px-2 py-1 text-xs disabled:cursor-not-allowed disabled:opacity-50 ${
              diffVisible
                ? "border-blue-500 bg-blue-500/10 text-blue-300"
                : "border-gray-700 text-gray-300 hover:text-gray-100"
            }`}
          >
            Show difference (B − A)
          </button>
        )}
      </div>

      {diffVisible && difference ? (
        <div className="space-y-2">
          <p className="text-xs text-gray-400">
            {`A = ${runs[0].label}, B = ${runs[1].label}. Cells show B minus A over the labels both runs have.`}
          </p>
          <div className="overflow-x-auto">
            <table className="border-collapse text-xs">
              <thead>
                <tr>
                  <th className="border-b border-r border-gray-800 px-2 py-1 text-left align-bottom text-gray-500">
                    actual \ predicted
                  </th>
                  {difference.labels.map((label) => (
                    <th
                      key={label}
                      className="border-b border-gray-800 px-2 py-1 text-center font-normal text-gray-400"
                      style={{ writingMode: "vertical-rl" }}
                    >
                      {label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {difference.labels.map((rowLabel, i) => (
                  <tr key={rowLabel}>
                    <th className="border-r border-gray-800 px-2 py-1 text-right font-normal text-gray-400">
                      {rowLabel}
                    </th>
                    {difference.labels.map((colLabel, j) => {
                      const { text, className } = formatDelta(difference.diff[i][j]);
                      return (
                        <td
                          key={colLabel}
                          data-diff-cell
                          className={`px-2 py-1 text-center ${className}`}
                        >
                          {text}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ) : (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {runs.map((run, index) => {
            const confusion = confusions[index] ?? null;
            return (
              <div key={run.id} className="min-w-0 space-y-1">
                <div className="flex items-center gap-2 text-xs text-gray-300">
                  <span
                    className="inline-block h-2 w-2 rounded-full"
                    style={{ backgroundColor: run.color }}
                  />
                  <span>{run.label}</span>
                </div>
                {confusion && confusion.matrix.length > 0 ? (
                  <ConfusionMatrix confusion={confusion} />
                ) : (
                  <p className="text-xs text-gray-500">No confusion matrix for this run.</p>
                )}
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}
