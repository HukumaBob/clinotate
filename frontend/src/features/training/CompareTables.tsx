import { useState, type ReactNode } from "react";

import type { CompareRunInfo } from "./CompareCurves";
import {
  configDifferences,
  finalMetricRows,
  perClassColumns,
  perClassRowsFor,
  type MetricRow,
  type RunLike,
} from "./compareLogic";
import type { SettingsSchema } from "./settingsLogic";

interface CompareTablesProps {
  runs: CompareRunInfo[];
  runObjects: RunLike[];
  metrics: Array<{ metrics: Record<string, unknown>; per_class: Array<Record<string, unknown>> } | null>;
  schema: SettingsSchema | null;
}

function formatDelta(delta: number): string {
  return `${delta < 0 ? "−" : "+"}${Math.abs(delta).toFixed(3)}`;
}

function Section({ title, caption, children }: { title: string; caption: string; children: ReactNode }) {
  return (
    <section className="mb-6">
      <h3 className="text-sm font-semibold text-gray-200">{title}</h3>
      <p className="mb-2 text-xs text-gray-500">{caption}</p>
      {children}
    </section>
  );
}

function Empty({ children }: { children: string }) {
  return <p className="text-sm text-gray-500">{children}</p>;
}

function RunHeaders({ runs, first }: { runs: CompareRunInfo[]; first: string }) {
  return (
    <tr className="border-b border-gray-800 text-left text-xs text-gray-400">
      <th className="px-2 py-1 font-medium">{first}</th>
      {runs.map((run) => (
        <th key={run.id} className="px-2 py-1 font-medium" style={{ color: run.color }}>
          {run.label}
        </th>
      ))}
    </tr>
  );
}

function MetricCells({ row }: { row: MetricRow }) {
  return (
    <>
      {row.values.map((value, i) => (
        <td key={i} className="px-2 py-1 align-top tabular-nums">
          {value === null ? (
            <span className="text-gray-500">—</span>
          ) : (
            <span
              className={i === row.bestIndex ? "font-semibold text-green-300" : "text-gray-300"}
              title={i === row.bestIndex ? "Best among the compared runs" : undefined}
            >
              {value.toFixed(4)}
            </span>
          )}
          {i > 0 && row.deltas[i] !== null && (
            <div className="text-xs text-gray-500">{formatDelta(row.deltas[i] as number)}</div>
          )}
        </td>
      ))}
    </>
  );
}

export function CompareTables({ runs, runObjects, metrics, schema }: CompareTablesProps) {
  const [column, setColumn] = useState<string | null>(null);

  const configRows = configDifferences(runObjects, schema);
  const finalRows = finalMetricRows(metrics.map((m) => m?.metrics ?? null));
  const perClassSets = metrics.map((m) => m?.per_class ?? []);
  const columns = perClassColumns(perClassSets);
  const activeColumn = column && columns.includes(column) ? column : (columns[0] ?? null);
  const classRows = activeColumn ? perClassRowsFor(perClassSets, activeColumn) : [];

  return (
    <div className="text-gray-200">
      <Section
        title="Configuration differences"
        caption="Only settings whose values differ between the compared runs."
      >
        {configRows.length === 0 ? (
          <Empty>No setting differs between these runs.</Empty>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <RunHeaders runs={runs} first="Setting" />
              </thead>
              <tbody>
                {configRows.map((row) => (
                  <tr key={row.key} className="border-b border-gray-900">
                    <td className="px-2 py-1 text-gray-400">{row.label}</td>
                    {row.values.map((value, i) => (
                      <td key={i} className="px-2 py-1 text-gray-300">
                        {value}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Section>

      <Section
        title="Final metrics"
        caption="Last reported values; the best is highlighted, deltas are against the first run."
      >
        {finalRows.length === 0 ? (
          <Empty>No final metrics reported.</Empty>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <RunHeaders runs={runs} first="Metric" />
              </thead>
              <tbody>
                {finalRows.map((row) => (
                  <tr key={row.key} className="border-b border-gray-900">
                    <td className="px-2 py-1 text-gray-400">{row.key}</td>
                    <MetricCells row={row} />
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Section>

      <Section
        title="Per-class metrics"
        caption="One metric at a time, per class; deltas are against the first run."
      >
        {activeColumn === null || classRows.length === 0 ? (
          <Empty>No per-class metrics for these runs.</Empty>
        ) : (
          <>
            <select
              aria-label="Per-class metric"
              value={activeColumn}
              onChange={(e) => setColumn(e.target.value)}
              className="mb-2 rounded border border-gray-700 bg-gray-900 px-2 py-1 text-sm text-gray-200"
            >
              {columns.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <RunHeaders runs={runs} first="Class" />
                </thead>
                <tbody>
                  {classRows.map((row) => (
                    <tr key={row.cls} className="border-b border-gray-900">
                      <td className="px-2 py-1 text-gray-400">{row.cls}</td>
                      <MetricCells row={row} />
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </Section>
    </div>
  );
}
