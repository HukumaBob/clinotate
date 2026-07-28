import { useStore } from "zustand/react";

import type { components } from "../../shared/api/generated/schema";
import { CascadingLabelPicker } from "./CascadingLabelPicker";
import type { FrameEditorStore, PromptType } from "./frameEditorStore";
import { MasksList } from "./MasksList";
import { TrackControls } from "./TrackControls";

type Annotation = components["schemas"]["AnnotationRead"];

interface ToolsPanelProps {
  store: FrameEditorStore;
  annotations: Annotation[];
  frameId: number;
  onTrack: () => void;
  procedureId: number | null;
}

const PRESET_COLORS = ["#22d3ee", "#f87171", "#4ade80", "#facc15", "#a78bfa", "#fb923c"];
const TOOLS: PromptType[] = ["point", "box", "mask"];
const TOOL_LABELS: Record<PromptType, string> = { point: "Point", box: "Box", mask: "Mask" };

export function ToolsPanel({ store, annotations, frameId, onTrack, procedureId }: ToolsPanelProps) {
  const activeModel = useStore(store, (state) => state.activeModel);
  const activeTool = useStore(store, (state) => state.activeTool);
  const setActiveModel = useStore(store, (state) => state.setActiveModel);
  const setActiveTool = useStore(store, (state) => state.setActiveTool);
  const color = useStore(store, (state) => state.color);
  const setColor = useStore(store, (state) => state.setColor);

  return (
    <aside className="flex w-[280px] shrink-0 flex-col gap-5 overflow-y-auto border-l border-gray-800 bg-gray-950 p-4">
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
        <h2 className="text-[11px] font-medium text-gray-500">Tool</h2>
        <div className="flex gap-1 rounded-md border border-gray-800 bg-gray-900 p-1">
          {TOOLS.map((tool) => (
            <button
              key={tool}
              type="button"
              onClick={() => setActiveTool(tool)}
              className={`flex-1 rounded px-2 py-1.5 text-sm font-medium transition-colors ${
                activeTool === tool ? "bg-blue-600 text-white" : "text-gray-400 hover:text-gray-200"
              }`}
            >
              {TOOL_LABELS[tool]}
            </button>
          ))}
        </div>
        {activeTool === "point" && (
          <p className="pt-1 text-[11px] leading-snug text-gray-500">
            Click = include · Shift+click = exclude · Drag = box · Ctrl+click a mask = remove
          </p>
        )}
        {activeTool === "mask" && (
          <p className="pt-1 text-[11px] leading-snug text-gray-500">
            Trace an outline and release to predict · trace another to refine
          </p>
        )}
      </section>

      <div className="border-t border-gray-800" />

      <section className="space-y-1">
        <h2 className="text-[11px] font-medium text-gray-500">Label</h2>
        <CascadingLabelPicker store={store} procedureId={procedureId} />
      </section>

      <section className="space-y-2">
        <h2 className="text-[11px] font-medium text-gray-500">Color</h2>
        <div className="flex items-center gap-2">
          <input
            type="color"
            value={color}
            onChange={(event) => setColor(event.target.value)}
            className="h-7 w-7 cursor-pointer rounded border border-gray-700 bg-transparent p-0.5"
            aria-label="Color"
          />
          {PRESET_COLORS.map((preset) => (
            <button
              key={preset}
              type="button"
              onClick={() => setColor(preset)}
              style={{ backgroundColor: preset }}
              className={`h-5 w-5 rounded-full border transition-transform ${
                color === preset ? "scale-110 border-gray-200" : "border-gray-700"
              }`}
              aria-label={`Preset color ${preset}`}
            />
          ))}
        </div>
      </section>

      <div className="border-t border-gray-800" />

      <section className="space-y-1">
        <h2 className="text-[11px] font-medium text-gray-500">Track</h2>
        <TrackControls store={store} onTrack={onTrack} />
      </section>

      <div className="border-t border-gray-800" />

      <section className="space-y-1">
        <h2 className="text-[11px] font-medium text-gray-500">Masks on this frame</h2>
        <MasksList annotations={annotations} store={store} frameId={frameId} procedureId={procedureId} />
      </section>
    </aside>
  );
}
