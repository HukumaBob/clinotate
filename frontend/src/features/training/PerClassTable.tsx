import { useMemo, useState } from "react";

type SortState = { column: string; direction: "asc" | "desc" } | null;

/** Column order for the per-class table: `class` always leads, then every
 * other key in first-seen order across rows. Never a hardcoded list --
 * different trainers report different columns (mAP50/Box-P for YOLO,
 * ap_50 for RT-DETR, ...). */
function deriveColumns(rows: Array<Record<string, unknown>>): string[] {
  const seen: string[] = [];
  const known = new Set<string>();
  for (const row of rows) {
    for (const key of Object.keys(row)) {
      if (key === "class") continue;
      if (!known.has(key)) {
        known.add(key);
        seen.push(key);
      }
    }
  }
  return ["class", ...seen];
}

function formatCell(value: unknown): string {
  if (typeof value === "number") {
    return value.toFixed(4);
  }
  if (value === null || value === undefined) {
    return "";
  }
  return String(value);
}

interface PerClassTableProps {
  rows: Array<Record<string, unknown>>;
}

export function PerClassTable({ rows }: PerClassTableProps) {
  const [sort, setSort] = useState<SortState>(null);
  const columns = useMemo(() => deriveColumns(rows), [rows]);

  const sortedRows = useMemo(() => {
    if (!sort) return rows;
    const { column, direction } = sort;
    const copy = [...rows];
    copy.sort((a, b) => {
      const av = a[column];
      const bv = b[column];
      const an = typeof av === "number" ? av : Number.NEGATIVE_INFINITY;
      const bn = typeof bv === "number" ? bv : Number.NEGATIVE_INFINITY;
      return direction === "asc" ? an - bn : bn - an;
    });
    return copy;
  }, [rows, sort]);

  function toggleSort(column: string) {
    setSort((prev) => {
      if (!prev || prev.column !== column) {
        return { column, direction: "desc" };
      }
      return { column, direction: prev.direction === "desc" ? "asc" : "desc" };
    });
  }

  if (rows.length === 0) return null;

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left text-xs text-gray-200">
        <thead>
          <tr className="border-b border-gray-800 text-gray-400">
            {columns.map((column) => {
              const isClass = column === "class";
              return (
                <th key={column} className="px-2 py-1 font-normal">
                  {isClass ? (
                    column
                  ) : (
                    <button
                      type="button"
                      onClick={() => toggleSort(column)}
                      className="hover:text-gray-100"
                    >
                      {column}
                      {sort?.column === column ? (sort.direction === "desc" ? " ↓" : " ↑") : ""}
                    </button>
                  )}
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {sortedRows.map((row, rowIndex) => (
            <tr key={rowIndex} className="border-b border-gray-900">
              {columns.map((column) => (
                <td key={column} className="px-2 py-1">
                  {formatCell(row[column])}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
