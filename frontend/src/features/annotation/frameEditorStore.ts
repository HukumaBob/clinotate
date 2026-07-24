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
  selectedAnnotationId: number | null;
  labelCategoryId: number | null;
  labelClassification: LabelClassification | null;
  labelTagId: number | null;
  color: string;
  backward: number;
  forward: number;
  setActiveModel: (model: SegmentationModel) => void;
  setActiveTool: (tool: PromptType) => void;
  addPrompt: (prompt: PromptDraft) => void;
  clearPrompts: () => void;
  setSelectedAnnotation: (id: number | null) => void;
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
    selectedAnnotationId: null,
    labelCategoryId: null,
    labelClassification: null,
    labelTagId: null,
    color: DEFAULT_COLOR,
    backward: DEFAULT_BACKWARD,
    forward: DEFAULT_FORWARD,
    setActiveModel: (model) => set({ activeModel: model }),
    setActiveTool: (tool) => set({ activeTool: tool }),
    addPrompt: (prompt) => set((state) => ({ pendingPrompts: [...state.pendingPrompts, prompt] })),
    clearPrompts: () => set({ pendingPrompts: [] }),
    setSelectedAnnotation: (id) => set({ selectedAnnotationId: id }),
    setLabelSelection: (partial) => set(partial),
    setColor: (color) => set({ color }),
    setBackward: (value) => set({ backward: value }),
    setForward: (value) => set({ forward: value }),
    reset: () =>
      set({
        activeTool: "point",
        pendingPrompts: [],
        selectedAnnotationId: null,
        labelCategoryId: null,
        labelClassification: null,
        labelTagId: null,
        color: DEFAULT_COLOR,
      }),
  }));
}

export type FrameEditorStore = ReturnType<typeof createFrameEditorStore>;
