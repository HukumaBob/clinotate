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
  onAddMask: () => void;
  onTrack: () => void;
}

const PRESET_COLORS = ["#22d3ee", "#f87171", "#4ade80", "#facc15", "#a78bfa", "#fb923c"];
const TOOLS: PromptType[] = ["point", "box", "mask"];
const TOOL_LABELS: Record<PromptType, string> = { point: "Point", box: "Box", mask: "Mask" };

export function ToolsPanel({ store, annotations, onAddMask, onTrack }: ToolsPanelProps) {
  const activeModel = useStore(store, (state) => state.activeModel);
  const activeTool = useStore(store, (state) => state.activeTool);
  const setActiveModel = useStore(store, (state) => state.setActiveModel);
  const setActiveTool = useStore(store, (state) => state.setActiveTool);
  const color = useStore(store, (state) => state.color);
  const setColor = useStore(store, (state) => state.setColor);

  return (
    <aside className="flex w-[270px] shrink-0 flex-col gap-4 overflow-y-auto border-l border-gray-800 p-4">
      <div role="tablist" className="flex gap-1 rounded border border-gray-800 p-1">
        <button
          type="button"
          role="tab"
          aria-selected={activeModel === "sam2"}
          onClick={() => setActiveModel("sam2")}
          className={`flex-1 rounded px-2 py-1 text-sm ${activeModel === "sam2" ? "bg-blue-600 text-white" : "text-gray-300"}`}
        >
          SAM 2.1
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={false}
          disabled
          title="Needs more VRAM than this GPU has — available after hardware upgrade"
          className="flex-1 cursor-not-allowed rounded px-2 py-1 text-sm text-gray-600"
        >
          SAM-3
        </button>
      </div>

      <div className="flex gap-1 rounded border border-gray-800 p-1">
        {TOOLS.map((tool) => (
          <button
            key={tool}
            type="button"
            onClick={() => setActiveTool(tool)}
            className={`flex-1 rounded px-2 py-1 text-sm ${activeTool === tool ? "bg-blue-600 text-white" : "text-gray-300"}`}
          >
            {TOOL_LABELS[tool]}
          </button>
        ))}
      </div>

      <CascadingLabelPicker store={store} />

      <div className="flex items-center gap-2">
        <input
          type="color"
          value={color}
          onChange={(event) => setColor(event.target.value)}
          className="h-8 w-8 rounded border border-gray-700 bg-transparent"
          aria-label="Color"
        />
        {PRESET_COLORS.map((preset) => (
          <button
            key={preset}
            type="button"
            onClick={() => setColor(preset)}
            style={{ backgroundColor: preset }}
            className="h-5 w-5 rounded-full border border-gray-700"
            aria-label={`Preset color ${preset}`}
          />
        ))}
        <button
          type="button"
          onClick={onAddMask}
          className="ml-auto rounded bg-blue-600 px-2 py-1 text-xs font-medium text-white hover:bg-blue-500"
        >
          Add mask
        </button>
      </div>

      <TrackControls store={store} onTrack={onTrack} />

      <div>
        <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-gray-400">Masks</h3>
        <MasksList annotations={annotations} store={store} />
      </div>
    </aside>
  );
}
