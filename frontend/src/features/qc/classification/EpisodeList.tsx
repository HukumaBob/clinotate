import { useState } from "react";

import { formatClock } from "../analysis/strip";
import type { Episode } from "./evaluationLogic";
import { episodeKey, filterSelection, toRequestEpisodes } from "./episodeSelection";

const EPISODE_CAP = 200;

export interface EpisodeListProps {
  axisName: string;
  /** Every episode of the shown axis, already sorted for display. */
  episodes: Episode[];
  selection: Set<string>;
  /** Receives the whole new selection (all axes). */
  onSelectionChange: (next: Set<string>) => void;
  onSeek: (ms: number) => void;
  /** Episodes and evaluated frames of the whole selection, for the footer. */
  summary: { episodes: number; frames: number };
  onSend?: (keys: string[]) => void;
  /** The display order; "Show more" starts over when it changes. */
  sortMode?: string;
  /** Several axes exist: checkbox names then say the axis too. */
  multipleAxes?: boolean;
}

/** The axis a key belongs to, compared exactly (an axis name may contain "|"). */
function axisOf(key: string): string | undefined {
  return toRequestEpisodes([key])[0]?.axis;
}

/** Number input text to a number, or null when empty or not a finite number. */
function parseNumber(text: string): number | null {
  if (text.trim() === "") return null;
  const n = Number(text);
  return Number.isFinite(n) ? n : null;
}

const chip = "rounded border px-2 py-0.5 text-xs";
const numberInput =
  "w-12 rounded border border-gray-700 bg-gray-900 px-1 py-0.5 text-right text-xs text-gray-100";

export function EpisodeList({
  axisName,
  episodes,
  selection,
  onSelectionChange,
  onSeek,
  summary,
  onSend,
  sortMode,
  multipleAxes = false,
}: EpisodeListProps) {
  const [shown, setShown] = useState(EPISODE_CAP);
  const [interiorOnly, setInteriorOnly] = useState(false);
  const [minFrames, setMinFrames] = useState("");
  const [minConfidence, setMinConfidence] = useState("");

  const [lastAxis, setLastAxis] = useState(axisName);
  const [lastSort, setLastSort] = useState(sortMode);
  if (lastAxis !== axisName || lastSort !== sortMode) {
    setLastAxis(axisName);
    setLastSort(sortMode);
    setShown(EPISODE_CAP);
  }

  /** The selection with this axis's keys replaced by `keys`. */
  const replaceAxis = (keys: string[]) => {
    const next = new Set([...selection].filter((k) => axisOf(k) !== axisName));
    for (const k of keys) next.add(k);
    onSelectionChange(next);
  };
  const toggle = (key: string) => {
    const next = new Set(selection);
    if (!next.delete(key)) next.add(key);
    onSelectionChange(next);
  };
  const apply = () => {
    const pct = parseNumber(minConfidence);
    replaceAxis(
      filterSelection(axisName, episodes, {
        interiorOnly,
        minFrames: parseNumber(minFrames),
        minConfidence: pct === null ? null : pct / 100,
      }),
    );
  };

  return (
    <div className="flex flex-col gap-2">
      {episodes.length === 0 ? (
        <p className="text-xs text-gray-400">No error episodes</p>
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-1" role="group" aria-label="Select episodes">
            <button
              type="button"
              onClick={() => replaceAxis(episodes.map((e) => episodeKey(axisName, e)))}
              className={`${chip} border-gray-700 text-gray-300`}
            >
              Select all
            </button>
            <button
              type="button"
              onClick={() => replaceAxis([])}
              className={`${chip} border-gray-700 text-gray-300`}
            >
              Select none
            </button>
          </div>
          <div className="flex flex-wrap items-center gap-1 text-xs text-gray-300" role="group" aria-label="Quick filters">
            <button
              type="button"
              aria-pressed={interiorOnly}
              onClick={() => setInteriorOnly((v) => !v)}
              className={`${chip} ${
                interiorOnly ? "border-blue-500 bg-blue-950 text-blue-200" : "border-gray-700 text-gray-300"
              }`}
            >
              Interior only
            </button>
            <label className="flex items-center gap-1">
              At least
              <input
                type="number"
                min={0}
                aria-label="At least N frames"
                className={numberInput}
                value={minFrames}
                onChange={(e) => setMinFrames(e.target.value)}
              />
              frames
            </label>
            <label className="flex items-center gap-1">
              Mean confidence at least
              <input
                type="number"
                min={0}
                max={100}
                aria-label="Mean confidence at least X%"
                className={numberInput}
                value={minConfidence}
                onChange={(e) => setMinConfidence(e.target.value)}
              />
              %
            </label>
            <button type="button" onClick={apply} className={`${chip} border-gray-700 text-gray-300`}>
              Apply
            </button>
          </div>
          <ul className="flex flex-col gap-0.5">
            {episodes.slice(0, shown).map((e, index) => {
              const key = episodeKey(axisName, e);
              return (
                <li
                  key={`${e.start_ms}-${e.truth}-${e.predicted}-${index}`}
                  className="flex items-start gap-1"
                >
                  <input
                    type="checkbox"
                    aria-label={`Select episode at ${formatClock(e.start_ms)}: ${e.truth} to ${e.predicted}${
                      multipleAxes ? ` (${axisName})` : ""
                    }`}
                    className="mt-1 shrink-0"
                    checked={selection.has(key)}
                    onChange={() => toggle(key)}
                  />
                  <button
                    type="button"
                    onClick={() => onSeek(e.start_ms)}
                    className="w-full rounded px-1 py-0.5 text-left text-xs hover:bg-gray-800"
                  >
                    {formatClock(e.start_ms)} {e.truth} → {e.predicted}, {e.frames}{" "}
                    {e.frames === 1 ? "frame" : "frames"}, {Math.round(e.mean_confidence * 100)}%, {e.kind}
                  </button>
                </li>
              );
            })}
          </ul>
        </>
      )}
      {episodes.length > shown && (
        <button
          type="button"
          onClick={() => setShown((n) => n + EPISODE_CAP)}
          className="rounded border border-gray-700 px-2 py-0.5 text-xs text-gray-300"
        >
          Show more
        </button>
      )}
      <div className="flex flex-wrap items-center justify-between gap-2 border-t border-gray-800 pt-2 text-xs">
        <span className="text-gray-400">
          {summary.episodes} {summary.episodes === 1 ? "episode" : "episodes"} selected (all axes)
          {summary.episodes > 0 && `, ${summary.frames} ${summary.frames === 1 ? "frame" : "frames"}`}
        </span>
        <button
          type="button"
          disabled={summary.episodes === 0}
          onClick={() => onSend?.([...selection])}
          className="rounded border border-blue-600 bg-blue-950 px-2 py-0.5 text-blue-200 disabled:cursor-not-allowed disabled:opacity-40"
        >
          Send to training…
        </button>
      </div>
    </div>
  );
}
