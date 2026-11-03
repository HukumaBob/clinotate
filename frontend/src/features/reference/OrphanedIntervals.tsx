import { formatClock } from "../qc/analysis/strip";

export interface OrphanRow {
  id: number;
  labelName: string;
  startMs: number;
  endMs: number;
}

interface ReferenceLike {
  axes: { classes: { label_id: number; name: string }[] }[];
  intervals: { id: number; category_id: number; label_id: number; start_ms: number; end_ms: number; orphaned: boolean }[];
}

/** The server's orphaned intervals as list rows; `categories` limits them to
 * those axes. The label is named when any axis still holds it. */
export function orphanRows(reference: ReferenceLike, categories?: Set<number>): OrphanRow[] {
  const names = new Map<number, string>();
  for (const axis of reference.axes) for (const c of axis.classes) names.set(c.label_id, c.name);
  return reference.intervals
    .filter((i) => i.orphaned && (!categories || categories.has(i.category_id)))
    .map((i) => ({
      id: i.id,
      labelName: names.get(i.label_id) ?? `Label #${i.label_id}`,
      startMs: i.start_ms,
      endMs: i.end_ms,
    }));
}

interface OrphanedIntervalsProps {
  rows: OrphanRow[];
  onDelete: (id: number) => void;
}

/** Intervals whose class left their axis: not drawn on any lane, so they are
 * listed here to be found and deleted (they still block their stretch of the
 * lane on the server, and keep their label from being deleted). */
export function OrphanedIntervals({ rows, onDelete }: OrphanedIntervalsProps) {
  if (rows.length === 0) return null;
  return (
    <div className="flex flex-col gap-1 text-xs text-amber-400">
      <p>
        {`${rows.length} orphaned ${rows.length === 1 ? "interval" : "intervals"}: the class is no longer on its axis`}
      </p>
      <ul className="flex flex-col gap-1">
        {rows.map((row) => (
          <li key={row.id} className="flex items-center gap-2">
            <span>{`${row.labelName} ${formatClock(row.startMs)}–${formatClock(row.endMs)}`}</span>
            <button
              type="button"
              className="rounded border border-gray-700 px-2 py-0.5 text-gray-300 hover:text-gray-100"
              onClick={() => onDelete(row.id)}
            >
              Delete
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
