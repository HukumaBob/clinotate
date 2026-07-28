import { createStore } from "zustand/vanilla";

export type PromptType = "point" | "box" | "mask";
export type SegmentationModel = "sam2" | "sam3";
export type LabelClassification = "geometric" | "morphological" | "quality";

export interface PromptDraft {
  type: PromptType;
  coords: number[];
  label: boolean;
  mask_png?: string;
}

export interface FrameEditorState {
  activeModel: SegmentationModel;
  activeTool: PromptType;
  pendingPrompts: PromptDraft[];
  // The DRAFT mask Annotation currently being refined by pendingPrompts, if
  // any -- each new refinement gesture re-predicts from the full prompt set
  // and replaces this draft (deletes the old one, keeps the new one), so
  // refining one object never leaves behind a trail of stale draft masks.
  // Cleared (along with pendingPrompts) once the object is finished via
  // Track or Generate from mask.
  draftAnnotationId: number | null;
  selectedAnnotationId: number | null;
  hoveredAnnotationId: number | null;
  labelCategoryId: number | null;
  labelClassification: LabelClassification | null;
  labelTagId: number | null;
  color: string;
  backward: number;
  forward: number;
  setActiveModel: (model: SegmentationModel) => void;
  setActiveTool: (tool: PromptType) => void;
  addPrompt: (prompt: PromptDraft) => void;
  removePromptAt: (index: number) => void;
  setMaskPrompt: (mask_png: string) => void;
  clearPrompts: () => void;
  setDraftAnnotationId: (id: number | null) => void;
  setSelectedAnnotation: (id: number | null) => void;
  setHoveredAnnotation: (id: number | null) => void;
  setLabelSelection: (partial: Partial<{
    labelCategoryId: number | null;
    labelClassification: LabelClassification | null;
    labelTagId: number | null;
  }>) => void;
  setColor: (color: string) => void;
  setBackward: (value: number) => void;
  setForward: (value: number) => void;
  reset: () => void;
}

const DEFAULT_BACKWARD = 5;
const DEFAULT_FORWARD = 5;
const DEFAULT_COLOR = "#22d3ee";

export function createFrameEditorStore() {
  return createStore<FrameEditorState>((set) => ({
    activeModel: "sam2",
    activeTool: "point",
    pendingPrompts: [],
    draftAnnotationId: null,
    selectedAnnotationId: null,
    hoveredAnnotationId: null,
    labelCategoryId: null,
    labelClassification: null,
    labelTagId: null,
    color: DEFAULT_COLOR,
    backward: DEFAULT_BACKWARD,
    forward: DEFAULT_FORWARD,
    setActiveModel: (model) => set({ activeModel: model }),
    setActiveTool: (tool) => set({ activeTool: tool }),
    addPrompt: (prompt) => set((state) => ({ pendingPrompts: [...state.pendingPrompts, prompt] })),
    removePromptAt: (index) =>
      set((state) => ({ pendingPrompts: state.pendingPrompts.filter((_, i) => i !== index) })),
    // Replaces the single mask-type prompt (a brush accumulates one rough
    // mask, unlike points/boxes which can have several) rather than
    // appending, so pendingPrompts never carries more than one stale mask
    // entry from an earlier stroke -- each stroke re-submits the FULL
    // accumulated brush canvas, not just what changed in that stroke.
    setMaskPrompt: (mask_png) =>
      set((state) => ({
        pendingPrompts: [
          ...state.pendingPrompts.filter((p) => p.type !== "mask"),
          { type: "mask", coords: [], label: true, mask_png },
        ],
      })),
    clearPrompts: () => set({ pendingPrompts: [], draftAnnotationId: null }),
    setDraftAnnotationId: (id) => set({ draftAnnotationId: id }),
    setSelectedAnnotation: (id) => set({ selectedAnnotationId: id }),
    setHoveredAnnotation: (id) => set({ hoveredAnnotationId: id }),
    setLabelSelection: (partial) => set(partial),
    setColor: (color) => set({ color }),
    setBackward: (value) => set({ backward: value }),
    setForward: (value) => set({ forward: value }),
    reset: () =>
      set({
        activeTool: "point",
        pendingPrompts: [],
        draftAnnotationId: null,
        selectedAnnotationId: null,
        hoveredAnnotationId: null,
        labelCategoryId: null,
        labelClassification: null,
        labelTagId: null,
        color: DEFAULT_COLOR,
      }),
  }));
}

export type FrameEditorStore = ReturnType<typeof createFrameEditorStore>;
