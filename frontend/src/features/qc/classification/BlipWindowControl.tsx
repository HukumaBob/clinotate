import { useEffect, useState } from "react";

import { PARAM_LIMITS } from "../analysis/params";

interface BlipWindowControlProps {
  /** The flicker window of the detection view, shared and remembered per browser. */
  value: number;
  onChange: (next: number) => void;
  blipCount: number;
  isCoarse: boolean;
}

export function BlipWindowControl({ value, onChange, blipCount, isCoarse }: BlipWindowControlProps) {
  // The field keeps its own text so an empty or half-typed edit is not
  // snapped back (and not emitted) on every keystroke.
  const [draft, setDraft] = useState(String(value));
  useEffect(() => {
    setDraft(String(value));
  }, [value]);

  return (
    <section aria-label="Blips" className="flex flex-col gap-3 text-sm text-gray-300">
      <h2 className="text-sm font-semibold text-gray-200">Blips</h2>
      <div className="flex items-center justify-between gap-2">
        <label htmlFor="qc-blip-n">Blip window</label>
        <input
          id="qc-blip-n"
          type="number"
          className="w-16 rounded border border-gray-700 bg-gray-900 px-2 py-1 text-right text-sm text-gray-100"
          min={PARAM_LIMITS.flickerN.min}
          max={PARAM_LIMITS.flickerN.max}
          step={PARAM_LIMITS.flickerN.step}
          value={draft}
          onChange={(e) => {
            const next = e.target.value;
            setDraft(next);
            if (next !== "" && Number.isInteger(Number(next))) onChange(Number(next));
          }}
          onBlur={() => setDraft(String(value))}
        />
      </div>
      <p className="text-xs text-gray-400">
        A blip is a stretch of at most this many processed frames whose neighbours carry the same other label.
      </p>
      <p className="text-xs text-gray-400">
        {blipCount === 0 ? "No blips" : `${blipCount} ${blipCount === 1 ? "blip" : "blips"}`}
      </p>
      {isCoarse && (
        <p role="note" className="rounded border border-yellow-700 bg-yellow-950 px-2 py-1 text-xs text-yellow-200">
          Stride is too coarse for blip detection: one step is long, so these blips span seconds.
        </p>
      )}
    </section>
  );
}
