import { useMemo, useState } from "react";

interface MetricsChartProps {
  history: Array<Record<string, number>>;
}

const PALETTE = [
  "#60a5fa", // blue-400
  "#f87171", // red-400
  "#34d399", // emerald-400
  "#fbbf24", // amber-400
  "#a78bfa", // violet-400
  "#22d3ee", // cyan-400
  "#fb923c", // orange-400
  "#f472b6", // pink-400
  "#a3e635", // lime-400
  "#94a3b8", // slate-400
];

const WIDTH = 640;
const HEIGHT = 280;
const MARGIN = { top: 12, right: 48, bottom: 32, left: 48 };
const PLOT_WIDTH = WIDTH - MARGIN.left - MARGIN.right;
const PLOT_HEIGHT = HEIGHT - MARGIN.top - MARGIN.bottom;

function isLossKey(key: string): boolean {
  return key.toLowerCase().includes("loss");
}

/** Min/max of a series' present (non-missing) values. Falls back to a
 * degenerate [0, 1] range when a series has no numeric points at all,
 * so division by zero never occurs. */
function extent(values: number[]): [number, number] {
  if (values.length === 0) return [0, 1];
  let min = values[0];
  let max = values[0];
  for (const v of values) {
    if (v < min) min = v;
    if (v > max) max = v;
  }
  if (min === max) {
    // Flat series: pad so the line isn't drawn on the axis edge.
    return [min - 1, max + 1];
  }
  return [min, max];
}

export function MetricsChart({ history }: MetricsChartProps) {
  const [hidden, setHidden] = useState<Set<string>>(new Set());

  const seriesKeys = useMemo(() => {
    const seen: string[] = [];
    const known = new Set<string>();
    for (const point of history) {
      for (const key of Object.keys(point)) {
        if (key === "epoch") continue;
        if (!known.has(key)) {
          known.add(key);
          seen.push(key);
        }
      }
    }
    return seen;
  }, [history]);

  const epochs = useMemo(() => history.map((point) => point.epoch), [history]);
  const epochRange = useMemo(() => extent(epochs), [epochs]);

  const leftKeys = seriesKeys.filter((key) => !isLossKey(key));
  const rightKeys = seriesKeys.filter((key) => isLossKey(key));

  const leftRange = useMemo(
    () =>
      extent(
        history.flatMap((point) =>
          leftKeys
            .filter((key) => key in point)
            .map((key) => point[key]),
        ),
      ),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [history, leftKeys.join(",")],
  );
  const rightRange = useMemo(
    () =>
      extent(
        history.flatMap((point) =>
          rightKeys
            .filter((key) => key in point)
            .map((key) => point[key]),
        ),
      ),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [history, rightKeys.join(",")],
  );

  if (history.length === 0) {
    return null;
  }

  const xScale = (epoch: number) => {
    const [min, max] = epochRange;
    const t = max === min ? 0.5 : (epoch - min) / (max - min);
    return MARGIN.left + t * PLOT_WIDTH;
  };

  const yScale = (value: number, range: [number, number]) => {
    const [min, max] = range;
    const t = max === min ? 0.5 : (value - min) / (max - min);
    return MARGIN.top + (1 - t) * PLOT_HEIGHT;
  };

  function pathFor(key: string): string {
    const range = isLossKey(key) ? rightRange : leftRange;
    let d = "";
    let started = false;
    for (const point of history) {
      if (!(key in point)) {
        // Missing value: break the line rather than treating it as zero.
        started = false;
        continue;
      }
      const x = xScale(point.epoch);
      const y = yScale(point[key], range);
      d += started ? ` L ${x} ${y}` : `M ${x} ${y}`;
      started = true;
    }
    return d;
  }

  function toggle(key: string) {
    setHidden((prev) => {
      const next = new Set(prev);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });
  }

  return (
    <div className="text-gray-200">
      <svg
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        role="img"
        aria-label="Training metrics chart"
        className="w-full"
      >
        {/* Plot border */}
        <rect
          x={MARGIN.left}
          y={MARGIN.top}
          width={PLOT_WIDTH}
          height={PLOT_HEIGHT}
          fill="none"
          className="stroke-gray-800"
        />

        {/* X axis labels (epoch numbers) */}
        {epochs.map((epoch) => (
          <text
            key={`x-${epoch}`}
            x={xScale(epoch)}
            y={HEIGHT - MARGIN.bottom + 16}
            textAnchor="middle"
            className="fill-gray-500 text-[10px]"
          >
            {epoch}
          </text>
        ))}

        {/* Left Y axis range */}
        <text
          x={MARGIN.left - 4}
          y={MARGIN.top + 4}
          textAnchor="end"
          className="fill-gray-500 text-[10px]"
        >
          {leftRange[1].toFixed(2)}
        </text>
        <text
          x={MARGIN.left - 4}
          y={HEIGHT - MARGIN.bottom}
          textAnchor="end"
          className="fill-gray-500 text-[10px]"
        >
          {leftRange[0].toFixed(2)}
        </text>

        {/* Right Y axis range */}
        {rightKeys.length > 0 && (
          <>
            <text
              x={WIDTH - MARGIN.right + 4}
              y={MARGIN.top + 4}
              textAnchor="start"
              className="fill-gray-500 text-[10px]"
            >
              {rightRange[1].toFixed(2)}
            </text>
            <text
              x={WIDTH - MARGIN.right + 4}
              y={HEIGHT - MARGIN.bottom}
              textAnchor="start"
              className="fill-gray-500 text-[10px]"
            >
              {rightRange[0].toFixed(2)}
            </text>
          </>
        )}

        {seriesKeys.map((key, index) => {
          if (hidden.has(key)) return null;
          return (
            <path
              key={key}
              data-series={key}
              d={pathFor(key)}
              fill="none"
              stroke={PALETTE[index % PALETTE.length]}
              strokeWidth={1.5}
            />
          );
        })}
      </svg>

      <div className="mt-2 flex flex-wrap gap-2">
        {seriesKeys.map((key, index) => (
          <button
            key={key}
            type="button"
            onClick={() => toggle(key)}
            className={`flex items-center gap-1.5 rounded border px-2 py-1 text-xs ${
              hidden.has(key)
                ? "border-gray-800 text-gray-600"
                : "border-gray-700 text-gray-300"
            }`}
          >
            <span
              className="inline-block h-2 w-2 rounded-full"
              style={{
                backgroundColor: hidden.has(key) ? "transparent" : PALETTE[index % PALETTE.length],
                border: `1px solid ${PALETTE[index % PALETTE.length]}`,
              }}
            />
            {key}
          </button>
        ))}
      </div>
    </div>
  );
}
