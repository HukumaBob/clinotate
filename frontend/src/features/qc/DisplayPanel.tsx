import { PARAM_LIMITS } from "./analysis/params";
import { NMS_OFF, type ViewParams } from "./analysis/view";

interface DisplayPanelProps {
  params: ViewParams;
  onChange: (next: ViewParams) => void;
  onReset: () => void;
  blinkCount: number;
  dropoutCount: number;
  isCoarse: boolean;
}

const SLIDER = "w-full accent-blue-500";

export function DisplayPanel({
  params,
  onChange,
  onReset,
  blinkCount,
  dropoutCount,
  isCoarse,
}: DisplayPanelProps) {
  const set = (patch: Partial<ViewParams>) => onChange({ ...params, ...patch });
  const total = blinkCount + dropoutCount;
  const nmsText = params.nmsIou >= NMS_OFF ? "off" : params.nmsIou.toFixed(2);

  return (
    <section aria-label="Display" className="flex flex-col gap-3 text-sm text-gray-300">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold text-gray-200">Display</h2>
        <button
          type="button"
          onClick={onReset}
          className="rounded border border-gray-700 px-2 py-0.5 text-xs text-gray-300 hover:text-gray-100"
        >
          Reset
        </button>
      </div>

      <div className="flex flex-col gap-1">
        <div className="flex items-center justify-between">
          <label htmlFor="qc-threshold">Confidence</label>
          <span className="text-gray-400">{params.threshold.toFixed(2)}</span>
        </div>
        <input
          id="qc-threshold"
          type="range"
          className={SLIDER}
          min={PARAM_LIMITS.threshold.min}
          max={PARAM_LIMITS.threshold.max}
          step={PARAM_LIMITS.threshold.step}
          value={params.threshold}
          aria-valuetext={params.threshold.toFixed(2)}
          onChange={(e) => set({ threshold: Number(e.target.value) })}
        />
      </div>

      <div className="flex flex-col gap-1">
        <div className="flex items-center justify-between">
          <label htmlFor="qc-nms">NMS IoU</label>
          <span className="text-gray-400">{nmsText}</span>
        </div>
        <input
          id="qc-nms"
          type="range"
          className={SLIDER}
          min={PARAM_LIMITS.nmsIou.min}
          max={PARAM_LIMITS.nmsIou.max}
          step={PARAM_LIMITS.nmsIou.step}
          value={params.nmsIou}
          aria-valuetext={nmsText}
          onChange={(e) => set({ nmsIou: Number(e.target.value) })}
        />
      </div>

      <div className="flex items-center justify-between gap-2">
        <label htmlFor="qc-flicker-n">Flicker window</label>
        <input
          id="qc-flicker-n"
          type="number"
          className="w-16 rounded border border-gray-700 bg-gray-900 px-2 py-1 text-right text-sm text-gray-100"
          min={PARAM_LIMITS.flickerN.min}
          max={PARAM_LIMITS.flickerN.max}
          step={PARAM_LIMITS.flickerN.step}
          value={params.flickerN}
          onChange={(e) => set({ flickerN: Number(e.target.value) })}
        />
      </div>

      <p className="text-xs text-gray-400">
        {total === 0
          ? "No flicker events"
          : `${total} flicker ${total === 1 ? "event" : "events"} (${blinkCount} blink, ${dropoutCount} dropout)`}
      </p>

      {isCoarse && (
        <p role="note" className="rounded border border-yellow-700 bg-yellow-950 px-2 py-1 text-xs text-yellow-200">
          Stride is too coarse for flicker detection: one step is long, so these events span seconds.
        </p>
      )}
    </section>
  );
}
