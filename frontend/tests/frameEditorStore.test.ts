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

  it("clearPrompts also clears the draft annotation id", () => {
    const store = createFrameEditorStore();
    store.getState().setDraftAnnotationId(9);
    store.getState().clearPrompts();
    expect(store.getState().draftAnnotationId).toBeNull();
  });

  it("removePromptAt removes only the prompt at that index", () => {
    const store = createFrameEditorStore();
    store.getState().addPrompt({ type: "point", coords: [0.1, 0.1], label: true });
    store.getState().addPrompt({ type: "point", coords: [0.2, 0.2], label: false });
    store.getState().addPrompt({ type: "point", coords: [0.3, 0.3], label: true });

    store.getState().removePromptAt(1);

    const prompts = store.getState().pendingPrompts;
    expect(prompts).toHaveLength(2);
    expect(prompts[0].coords).toEqual([0.1, 0.1]);
    expect(prompts[1].coords).toEqual([0.3, 0.3]);
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

  it("defaults to null and can be set and cleared", () => {
    const store = createFrameEditorStore();

    expect(store.getState().hoveredAnnotationId).toBeNull();

    store.getState().setHoveredAnnotation(42);
    expect(store.getState().hoveredAnnotationId).toBe(42);

    store.getState().setHoveredAnnotation(null);
    expect(store.getState().hoveredAnnotationId).toBeNull();
  });

  it("is independent of selectedAnnotationId", () => {
    const store = createFrameEditorStore();

    store.getState().setSelectedAnnotation(7);
    store.getState().setHoveredAnnotation(9);

    expect(store.getState().selectedAnnotationId).toBe(7);
    expect(store.getState().hoveredAnnotationId).toBe(9);
  });
});
