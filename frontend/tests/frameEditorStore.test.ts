import { describe, expect, it } from "vitest";

import { createFrameEditorStore } from "../src/features/annotation/frameEditorStore";

describe("frameEditorStore", () => {
  it("defaults to the sam2 model and point tool", () => {
    const store = createFrameEditorStore();
    const state = store.getState();
    expect(state.activeModel).toBe("sam2");
    expect(state.activeTool).toBe("point");
    expect(state.backward).toBeGreaterThan(0);
    expect(state.forward).toBeGreaterThan(0);
  });

  it("accumulates prompts and clears them", () => {
    const store = createFrameEditorStore();
    store.getState().addPrompt({ type: "point", coords: [0.5, 0.5], label: true });
    expect(store.getState().pendingPrompts).toHaveLength(1);

    store.getState().clearPrompts();
    expect(store.getState().pendingPrompts).toHaveLength(0);
  });

  it("selecting an annotation fills the label selection from setLabelSelection", () => {
    const store = createFrameEditorStore();
    store.getState().setSelectedAnnotation(7);
    store.getState().setLabelSelection({ labelCategoryId: 1, labelClassification: "geometric", labelTagId: 3 });

    const state = store.getState();
    expect(state.selectedAnnotationId).toBe(7);
    expect(state.labelCategoryId).toBe(1);
    expect(state.labelClassification).toBe("geometric");
    expect(state.labelTagId).toBe(3);
  });

  it("reset clears prompts, selection, and tool back to defaults", () => {
    const store = createFrameEditorStore();
    store.getState().addPrompt({ type: "box", coords: [0, 0, 1, 1], label: true });
    store.getState().setSelectedAnnotation(3);
    store.getState().setActiveTool("mask");

    store.getState().reset();

    const state = store.getState();
    expect(state.pendingPrompts).toHaveLength(0);
    expect(state.selectedAnnotationId).toBeNull();
    expect(state.activeTool).toBe("point");
  });
});
