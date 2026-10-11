import { useState } from "react";

import { curveKeys, curveSeries, defaultCurveKey, type HistoryPoint } from "./compareLogic";

export const COMPARE_COLORS = ["#60a5fa", "#fbbf24", "#34d399"]; // blue-400, amber-400, emerald-400

export interface CompareRunInfo {
  id: number;
  label: string;
  color: string;
}

interface CompareCurvesProps {
  runs: CompareRunInfo[];
  histories: HistoryPoint[][];
}

const WIDTH = 640;
const HEIGHT = 280;
const MARGIN = { top: 12, right: 16, bottom: 32, left: 52 };
const PLOT_WIDTH = WIDTH - MARGIN.left - MARGIN.right;
const PLOT_HEIGHT = HEIGHT - MARGIN.top - MARGIN.bottom;
const TICKS = 4;

/** Shared value range. A loss spike would otherwise flatten every run, so
 * for loss metrics the top is clipped to the ~95th percentile when the
 * maximum dwarfs it; the spike still draws, clipped by the plot area. */
function valueRange(values: number[], clip: boolean): [number, number] {
  let min = Math.min(...values);
  let max = Math.max(...values);
  if (clip && values.length > 2) {
    const sorted = [...values].sort((a, b) => a - b);
    const cap = sorted[Math.max(0, Math.min(sorted.length - 2, Math.floor((sorted.length - 1) * 0.95)))];
    if (cap > min && max > cap * 4) max = cap;
  }
  if (min === max) {
    min -= 1;
    max += 1;
  }
  return [min, max];
}

export function CompareCurves({ runs, histories }: CompareCurvesProps) {
  const keys = curveKeys(histories);
  const [chosen, setChosen] = useState<string | null>(null);
  const key = chosen && keys.includes(chosen) ? chosen : defaultCurveKey(keys);

  if (key === null) {
    return <p className="text-sm text-gray-500">No training history to compare.</p>;
  }

  const series = runs.map((_, i) => curveSeries(histories[i] ?? [], key));
  const all = series.flat();
  const epochs = all.map((p) => p.epoch);
  const [xMin, xMax] =
    epochs.length > 0 ? [Math.min(...epochs), Math.max(...epochs)] : [0, 1];
  const [yMin, yMax] = valueRange(
    all.map((p) => p.value),
    key.toLowerCase().includes("loss"),
  );

  const x = (epoch: number) =>
    MARGIN.left + (xMax === xMin ? 0.5 : (epoch - xMin) / (xMax - xMin)) * PLOT_WIDTH;
  const y = (value: number) => MARGIN.top + (1 - (value - yMin) / (yMax - yMin)) * PLOT_HEIGHT;

  const xTicks = [...new Set([xMin, xMax])];
  const yTicks = Array.from({ length: TICKS + 1 }, (_, i) => yMin + ((yMax - yMin) * i) / TICKS);

  return (
    <div className="text-gray-200">
      <label className="mb-2 flex items-center gap-2 text-xs text-gray-400">
        Metric
        <select
          aria-label="Curve metric"
          value={key}
          onChange={(e) => setChosen(e.target.value)}
          className="rounded border border-gray-700 bg-gray-900 px-2 py-1 text-sm text-gray-200"
        >
          {keys.map((k) => (
            <option key={k} value={k}>
              {k}
            </option>
          ))}
        </select>
      </label>
      <svg
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        role="img"
        aria-label="Run comparison chart"
        preserveAspectRatio="none"
        className="min-h-[280px] w-full"
        style={{ height: HEIGHT }}
      >
        <defs>
          <clipPath id="compare-curves-plot">
            <rect x={MARGIN.left} y={MARGIN.top} width={PLOT_WIDTH} height={PLOT_HEIGHT} />
          </clipPath>
        </defs>
        <rect
          x={MARGIN.left}
          y={MARGIN.top}
          width={PLOT_WIDTH}
          height={PLOT_HEIGHT}
          fill="none"
          className="stroke-gray-800"
        />
        {yTicks.map((tick, i) => (
          <text
            key={`y-${i}`}
            x={MARGIN.left - 4}
            y={y(tick) + 3}
            textAnchor="end"
            className="fill-gray-500 text-[10px]"
          >
            {tick.toFixed(2)}
          </text>
        ))}
        {xTicks.map((tick) => (
          <text
            key={`x-${tick}`}
            x={x(tick)}
            y={HEIGHT - MARGIN.bottom + 16}
            textAnchor="middle"
            className="fill-gray-500 text-[10px]"
          >
            {tick}
          </text>
        ))}
        <g clipPath="url(#compare-curves-plot)">
          {runs.map((run, i) =>
            series[i].length === 0 ? null : (
              <polyline
                key={run.id}
                data-run={run.id}
                points={series[i].map((p) => `${x(p.epoch)},${y(p.value)}`).join(" ")}
                fill="none"
                stroke={run.color}
                strokeWidth={1.5}
              />
            ),
          )}
        </g>
      </svg>
      <ul className="mt-2 flex flex-wrap gap-3 text-xs">
        {runs.map((run, i) => (
          <li key={run.id} className="flex items-center gap-1.5 text-gray-300">
            <span
              className="inline-block h-2 w-2 rounded-full"
              style={{ backgroundColor: run.color }}
            />
            <span>{run.label}</span>
            {series[i].length === 0 && <span className="text-gray-500">(no data)</span>}
          </li>
        ))}
      </ul>
      <p className="mt-2 text-xs text-gray-500">One line per run for the chosen metric.</p>
    </div>
  );
}
