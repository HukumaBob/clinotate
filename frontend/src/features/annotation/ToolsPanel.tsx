import { useEffect, useRef, useState } from "react";
import { useStore } from "zustand/react";

import { useSettings } from "../../entities/useSettings";
import type { components } from "../../shared/api/generated/schema";
import { CascadingLabelPicker } from "./CascadingLabelPicker";
import type { FrameEditorStore, PromptType } from "./frameEditorStore";
import { MasksList } from "./MasksList";
import { TrackControls } from "./TrackControls";
import { VramGauge } from "./VramGauge";

type Annotation = components["schemas"]["AnnotationRead"];

interface ToolsPanelProps {
  store: FrameEditorStore;
  annotations: Annotation[];
  frameId: number;
  onTrack: () => void;
  procedureId: number | null;
  vramUsedBytes: number | null;
  vramTotalBytes: number | null;
  vramIsLive: boolean;
  maxBackward: number;
  maxForward: number;
}

const TOOLS: PromptType[] = ["point", "mask"];
const TOOL_LABELS: Record<PromptType, string> = { point: "Point / Box", box: "Point / Box", mask: "Mask" };

export function ToolsPanel({
  store,
  annotations,
  frameId,
  onTrack,
  procedureId,
  vramUsedBytes,
  vramTotalBytes,
  vramIsLive,
  maxBackward,
  maxForward,
}: ToolsPanelProps) {
  const activeModel = useStore(store, (state) => state.activeModel);
  const activeTool = useStore(store, (state) => state.activeTool);
  const setActiveModel = useStore(store, (state) => state.setActiveModel);
  const setActiveTool = useStore(store, (state) => state.setActiveTool);
  const labelTagId = useStore(store, (state) => state.labelTagId);
  const toolDisabled = labelTagId === null;

  const maskSmoothingStrength = useStore(store, (state) => state.maskSmoothingStrength);
  const setMaskSmoothingStrength = useStore(store, (state) => state.setMaskSmoothingStrength);
  const settingsQuery = useSettings();
  const hasSeededSmoothing = useRef(false);
  useEffect(() => {
    if (settingsQuery.data && !hasSeededSmoothing.current) {
      hasSeededSmoothing.current = true;
      store.getState().setMaskSmoothingStrength(settingsQuery.data.mask_postprocess_strength);
    }
  }, [settingsQuery.data, store]);

  const labelPickerPulseAt = useStore(store, (state) => state.labelPickerPulseAt);
  // Flashes briefly (CSS animation, see index.css) whenever the user clicks
  // the canvas without a tag selected -- a lightweight nudge toward this
  // section instead of a blocking modal. Re-derived from the timestamp on
  // every pulse rather than toggled once, so back-to-back clicks each
  // restart the animation instead of silently no-op'ing while a previous
  // flash is still fading out.
  const [isPulsing, setIsPulsing] = useState(false);
  useEffect(() => {
    if (labelPickerPulseAt === null) return;
    setIsPulsing(true);
    const timer = window.setTimeout(() => setIsPulsing(false), 700);
    return () => window.clearTimeout(timer);
  }, [labelPickerPulseAt]);

  return (
    <aside className="flex w-[630px] shrink-0 flex-col gap-5 overflow-y-auto border-l border-gray-800 bg-gray-950 p-4">
      <section className="space-y-1">
        <h2 className="text-[11px] font-medium text-gray-500">Model</h2>
        <div role="tablist" className="flex gap-1 rounded-md border border-gray-800 bg-gray-900 p-1">
          <button
            type="button"
            role="tab"
            aria-selected={activeModel === "sam2"}
            onClick={() => setActiveModel("sam2")}
            className={`flex-1 rounded px-2 py-1.5 text-sm font-medium transition-colors ${
              activeModel === "sam2" ? "bg-blue-600 text-white" : "text-gray-400 hover:text-gray-200"
            }`}
          >
            SAM 2.1
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={false}
            disabled
            title="Needs more VRAM than this GPU has — available after hardware upgrade"
            className="flex-1 cursor-not-allowed rounded px-2 py-1.5 text-sm font-medium text-gray-700"
          >
            SAM-3
          </button>
        </div>
      </section>

      <section className="space-y-1">
        <h2 className="text-[11px] font-medium text-gray-500">Mask smoothing</h2>
        <label className="flex items-center gap-2 text-xs text-gray-400">
          <input
            type="range"
            min={0}
            max={1}
            step={0.01}
            value={maskSmoothingStrength}
            aria-label="Mask smoothing"
            onChange={(event) => setMaskSmoothingStrength(Number(event.target.value))}
            className="flex-1"
          />
          <span className="w-10 shrink-0 text-right tabular-nums">{maskSmoothingStrength.toFixed(2)}</span>
        </label>
      </section>

      <section className="space-y-1">
        <VramGauge vramUsedBytes={vramUsedBytes} vramTotalBytes={vramTotalBytes} isLive={vramIsLive} />
      </section>

      <section
        data-testid="label-picker-section"
        className={`space-y-1 rounded-md transition-shadow ${isPulsing ? "animate-label-pulse" : ""}`}
      >
        <h2 className="text-[11px] font-medium text-gray-500">Label</h2>
        <CascadingLabelPicker store={store} procedureId={procedureId} />
      </section>

      <div className="border-t border-gray-800" />

      <section className="space-y-1">
        <h2 className="text-[11px] font-medium text-gray-500">Tool</h2>
        <div className="flex gap-1 rounded-md border border-gray-800 bg-gray-900 p-1">
          {TOOLS.map((tool) => (
            <button
              key={tool}
              type="button"
              disabled={toolDisabled}
              onClick={() => setActiveTool(tool)}
              className={`flex-1 rounded px-2 py-1.5 text-sm font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
                activeTool === tool ? "bg-blue-600 text-white" : "text-gray-400 hover:text-gray-200"
              }`}
            >
              {TOOL_LABELS[tool]}
            </button>
          ))}
        </div>
        {toolDisabled && (
          <p className="pt-1 text-[11px] leading-snug text-gray-500">Select a tag above to start annotating.</p>
        )}
        {!toolDisabled && activeTool === "point" && (
          <p className="pt-1 text-[11px] leading-snug text-gray-500">
            Click = include · Shift+click = exclude · Drag = box · Ctrl+click a mask = remove
          </p>
        )}
        {!toolDisabled && activeTool === "mask" && (
          <p className="pt-1 text-[11px] leading-snug text-gray-500">
            Trace an outline and release to predict · trace another to refine
          </p>
        )}
      </section>

      <div className="border-t border-gray-800" />

      <section className="space-y-1">
        <h2 className="text-[11px] font-medium text-gray-500">Track</h2>
        <TrackControls store={store} onTrack={onTrack} maxBackward={maxBackward} maxForward={maxForward} />
      </section>

      <div className="border-t border-gray-800" />

      <section className="space-y-1">
        <h2 className="text-[11px] font-medium text-gray-500">Masks on this frame</h2>
        <MasksList annotations={annotations} store={store} frameId={frameId} procedureId={procedureId} />
      </section>
    </aside>
  );
}
