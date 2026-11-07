import type { components } from "../../shared/api/generated/schema";

type SplitReportRead = components["schemas"]["SplitReportRead"];
type SplitCellRead = components["schemas"]["SplitCellRead"];

const PARTS = ["train", "val", "test"] as const;
type Part = (typeof PARTS)[number];

interface SplitReportTableProps {
  report: SplitReportRead;
}

function percent(value: number): string {
  return `${Math.round(value * 100)}%`;
}

/** How a dataset's classes are spread over train / val / test: frames and
 * independent source units per cell, with the cells that need attention
 * highlighted and the warnings spelled out below. The cell state is read from
 * the report (an empty cell, a thin_cell warning), never recomputed here. */
export function SplitReportTable({ report }: SplitReportTableProps) {
  if (report.classes.length === 0) {
    return null;
  }
  const thin = new Set(
    report.warnings
      .filter((warning) => warning.kind === "thin_cell")
      .map((warning) => `${warning.label_id}-${warning.split}`),
  );

  function problemOf(labelId: number, part: Part, value: SplitCellRead): string | undefined {
    if (value.frames === 0) return "missing";
    if (thin.has(`${labelId}-${part}`)) return "thin";
    return undefined;
  }

  return (
    <div className="flex flex-col gap-3 text-xs text-gray-300">
      <div data-testid="split-totals" className="flex flex-wrap gap-x-4 gap-y-1 text-gray-400">
        {PARTS.map((part) => (
          <span key={part}>
            {`${part} ${report[part].frames} frames · ${report[part].units} units · ${percent(report[part].share)} (target ${percent(report[part].target)})`}
          </span>
        ))}
      </div>

      <div data-testid="split-table-scroll" className="max-h-72 overflow-y-auto rounded border border-gray-800">
        <table className="w-full border-collapse text-left">
          <thead className="sticky top-0 bg-gray-900 text-gray-400">
            <tr>
              <th className="px-2 py-1 font-normal">Class</th>
              {PARTS.map((part) => (
                <th key={part} className="px-2 py-1 text-right font-normal">
                  {part}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {report.classes.map((entry) => (
              <tr key={entry.label_id} className="border-t border-gray-800">
                <td className="max-w-40 truncate px-2 py-1 text-gray-100">{entry.name}</td>
                {PARTS.map((part) => {
                  const value = entry[part];
                  const problem = problemOf(entry.label_id, part, value);
                  const tone =
                    problem === "missing" ? "text-red-400" : problem === "thin" ? "text-amber-400" : "text-gray-300";
                  return (
                    <td
                      key={part}
                      data-testid={`split-cell-${entry.label_id}-${part}`}
                      data-problem={problem}
                      className={`px-2 py-1 text-right tabular-nums ${tone}`}
                    >
                      {value.frames === 0 ? "—" : `${value.frames} / ${value.units}`}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {report.warnings.length > 0 && (
        <ul data-testid="split-warnings" className="flex flex-col gap-1">
          {report.warnings.map((warning) => (
            <li
              key={`${warning.kind}-${warning.label_id ?? "all"}-${warning.split ?? "all"}`}
              className="rounded border border-gray-800 bg-gray-950 px-3 py-2 text-amber-300"
            >
              {warning.message}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
