import { formatClock } from "./analysis/strip";
import { isReviewed, type GreyBand, type Reel } from "./reels";

interface ReelsPanelProps {
  reels: Reel[];
  flags: { frame_index: number }[];
  activeIndex: number | null;
  band: GreyBand;
  onBandChange: (band: GreyBand) => void;
  onSelect: (index: number | null) => void;
  isCoarse: boolean;
}

const BUTTON =
  "rounded border border-gray-700 px-2 py-1 text-xs text-gray-300 hover:text-gray-100 disabled:opacity-50";
const FIELD = "w-16 rounded border border-gray-700 bg-gray-950 px-1 py-0.5 text-right text-xs text-gray-100";

export function ReelsPanel({ reels, flags, activeIndex, band, onBandChange, onSelect, isCoarse }: ReelsPanelProps) {
  const empty = reels.length === 0;
  const prev = activeIndex === null ? null : activeIndex - 1;
  const next = activeIndex === null ? 0 : activeIndex + 1;

  function changeBand(side: "low" | "high", raw: string) {
    if (raw.trim() === "") return;
    const value = Number(raw);
    if (!Number.isFinite(value)) return;
    const clamped = Math.min(Math.max(value, 0), 1);
    onBandChange(
      side === "low"
        ? { low: clamped, high: Math.max(band.high, clamped) }
        : { low: Math.min(band.low, clamped), high: clamped },
    );
  }

  return (
    <section aria-label="Review reels" className="flex flex-col gap-2">
      <h2 className="text-sm font-semibold text-gray-200">Review reels</h2>
      <div className="flex items-center gap-2 text-xs text-gray-400">
        <label className="flex items-center gap-1">
          Grey zone from
          <input
            type="number" min={0} max={1} step={0.05} className={FIELD}
            value={band.low}
            onChange={(e) => changeBand("low", e.target.value)}
          />
        </label>
        <label className="flex items-center gap-1">
          Grey zone to
          <input
            type="number" min={0} max={1} step={0.05} className={FIELD}
            value={band.high}
            onChange={(e) => changeBand("high", e.target.value)}
          />
        </label>
      </div>
      {isCoarse && (
        <p className="text-xs text-amber-300">
          The flicker window is coarse at this stride, so flicker clips may be misleading.
        </p>
      )}
      <div className="flex items-center gap-2">
        <button
          type="button" className={BUTTON}
          disabled={empty || prev === null || prev < 0}
          onClick={() => prev !== null && onSelect(prev)}
        >
          Previous reel
        </button>
        <button
          type="button" className={BUTTON}
          disabled={empty || next >= reels.length}
          onClick={() => onSelect(next)}
        >
          Next reel
        </button>
      </div>
      {empty ? (
        <p className="text-xs text-gray-500">No doubtful moments at these settings</p>
      ) : (
        <ul className="flex max-h-64 flex-col gap-1 overflow-y-auto">
          {reels.map((reel, index) => (
            <li key={`${reel.startMs}-${reel.endMs}`}>
              <button
                type="button"
                aria-pressed={index === activeIndex}
                onClick={() => onSelect(index === activeIndex ? null : index)}
                className={`flex w-full flex-col gap-1 rounded border px-2 py-1 text-left text-xs ${
                  index === activeIndex ? "border-blue-500 bg-gray-800" : "border-gray-800 hover:border-gray-600"
                }`}
              >
                <span className="text-gray-200">
                  {formatClock(reel.startMs)}–{formatClock(reel.endMs)}
                </span>
                <span className="flex flex-wrap items-center gap-1 text-gray-400">
                  {reel.reasons.map((reason) => (
                    <span key={reason} className="rounded bg-gray-800 px-1.5 py-0.5">{reason}</span>
                  ))}
                  <span>{reel.frameIndices.length === 1 ? "1 frame" : `${reel.frameIndices.length} frames`}</span>
                  {isReviewed(reel, flags) && <span className="text-green-400">Reviewed</span>}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
