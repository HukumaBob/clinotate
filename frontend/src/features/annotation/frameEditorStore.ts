import { createStore } from "zustand/vanilla";

export type PromptType = "point" | "box" | "mask";
export type SegmentationModel = "sam2" | "sam3";
export type LabelClassification = number;

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
  // Masks the user has toggled off in the "Masks on this frame" list --
  // hidden from the canvas but not deleted. Per-frame, like selection: see
  // resetForNewFrame.
  hiddenAnnotationIds: Set<number>;
  // Bumped to a fresh timestamp each time the user clicks the canvas without
  // a tag selected -- the Label section in ToolsPanel watches this to fire a
  // brief highlight animation, nudging the user toward the control they
  // actually need without a blocking modal.
  labelPickerPulseAt: number | null;
  labelCategoryId: number | null;
  labelClassification: LabelClassification | null;
  labelTagId: number | null;
  color: string;
  backward: number;
  forward: number;
  maskSmoothingStrength: number;
  setActiveModel: (model: SegmentationModel) => void;
  setActiveTool: (tool: PromptType) => void;
  addPrompt: (prompt: PromptDraft) => void;
  removePromptAt: (index: number) => void;
  setMaskPrompt: (mask_png: string) => void;
  clearPrompts: () => void;
  setDraftAnnotationId: (id: number | null) => void;
  setSelectedAnnotation: (id: number | null) => void;
  setHoveredAnnotation: (id: number | null) => void;
  toggleAnnotationVisibility: (id: number) => void;
  triggerLabelPickerPulse: () => void;
  // Called when the user navigates to a different frame within the same
  // sequence (the store now lives for the whole FrameEditor session, not
  // per-frame) -- clears per-frame prompt/selection state, which belongs to
  // the frame just left, while keeping the label choice and tool/model,
  // which the user expects to carry over.
  resetForNewFrame: () => void;
  setLabelSelection: (partial: Partial<{
    labelCategoryId: number | null;
    labelClassification: LabelClassification | null;
    labelTagId: number | null;
  }>) => void;
  setColor: (color: string) => void;
  setBackward: (value: number) => void;
  setForward: (value: number) => void;
  setMaskSmoothingStrength: (value: number) => void;
  reset: () => void;
}

// Backward defaults to 0 (tracking is forward-only unless the user opts in);
// forward has no static default -- FrameEditor sets it to "rest of the
// sequence" via setForward once it knows the current frame's position, so 0
// here is just a safe placeholder before that first computation runs.
const DEFAULT_BACKWARD = 0;
const DEFAULT_FORWARD = 0;
const DEFAULT_COLOR = "#22d3ee";
// Overwritten as soon as GET /settings resolves (see ToolsPanel.tsx) --
// this is only the value shown before that first fetch completes.
const DEFAULT_MASK_SMOOTHING_STRENGTH = 0.3;

export function createFrameEditorStore() {
  return createStore<FrameEditorState>((set) => ({
    activeModel: "sam2",
    activeTool: "point",
    pendingPrompts: [],
    draftAnnotationId: null,
    selectedAnnotationId: null,
    hoveredAnnotationId: null,
    hiddenAnnotationIds: new Set(),
    labelPickerPulseAt: null,
    labelCategoryId: null,
    labelClassification: null,
    labelTagId: null,
    color: DEFAULT_COLOR,
    backward: DEFAULT_BACKWARD,
    forward: DEFAULT_FORWARD,
    maskSmoothingStrength: DEFAULT_MASK_SMOOTHING_STRENGTH,
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
    toggleAnnotationVisibility: (id) =>
      set((state) => {
        const next = new Set(state.hiddenAnnotationIds);
        if (next.has(id)) {
          next.delete(id);
        } else {
          next.add(id);
        }
        return { hiddenAnnotationIds: next };
      }),
    triggerLabelPickerPulse: () => set({ labelPickerPulseAt: Date.now() + Math.random() }),
    resetForNewFrame: () =>
      set({
        pendingPrompts: [],
        draftAnnotationId: null,
        selectedAnnotationId: null,
        hoveredAnnotationId: null,
        hiddenAnnotationIds: new Set(),
      }),
    setLabelSelection: (partial) => set(partial),
    setColor: (color) => set({ color }),
    setBackward: (value) => set({ backward: value }),
    setForward: (value) => set({ forward: value }),
    setMaskSmoothingStrength: (value) => set({ maskSmoothingStrength: value }),
    reset: () =>
      set({
        activeTool: "point",
        pendingPrompts: [],
        draftAnnotationId: null,
        selectedAnnotationId: null,
        hoveredAnnotationId: null,
        hiddenAnnotationIds: new Set(),
        labelCategoryId: null,
        labelClassification: null,
        labelTagId: null,
        color: DEFAULT_COLOR,
      }),
  }));
}

export type FrameEditorStore = ReturnType<typeof createFrameEditorStore>;
