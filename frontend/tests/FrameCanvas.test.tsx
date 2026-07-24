import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { createFrameEditorStore } from "../src/features/annotation/frameEditorStore";
import { FrameCanvas } from "../src/features/annotation/FrameCanvas";

const FRAME = {
  id: 1,
  sequence_id: 1,
  storage_key: "frames/1/0.png",
  frame_index: 0,
  width: 400,
  height: 200,
  image_url: "https://example.test/frame.png",
};

describe("FrameCanvas", () => {
  it("adds a point prompt to the store on left click", () => {
    const store = createFrameEditorStore();
    render(<FrameCanvas frame={FRAME} annotations={[]} store={store} />);

    const canvas = screen.getByTestId("frame-canvas");
    Object.defineProperty(canvas, "getBoundingClientRect", {
      value: () => ({ left: 0, top: 0, width: 400, height: 200 }),
    });
    fireEvent.mouseDown(canvas, { clientX: 200, clientY: 100, button: 0 });
    fireEvent.mouseUp(canvas, { clientX: 200, clientY: 100, button: 0 });

    const prompts = store.getState().pendingPrompts;
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toEqual({ type: "point", coords: [0.5, 0.5], label: true });
  });

  it("adds a box prompt to the store on left-click-drag", () => {
    const store = createFrameEditorStore();
    render(<FrameCanvas frame={FRAME} annotations={[]} store={store} />);

    const canvas = screen.getByTestId("frame-canvas");
    Object.defineProperty(canvas, "getBoundingClientRect", {
      value: () => ({ left: 0, top: 0, width: 400, height: 200 }),
    });
    fireEvent.mouseDown(canvas, { clientX: 40, clientY: 20, button: 0 });
    fireEvent.mouseMove(canvas, { clientX: 200, clientY: 100, button: 0 });
    fireEvent.mouseUp(canvas, { clientX: 200, clientY: 100, button: 0 });

    const prompts = store.getState().pendingPrompts;
    expect(prompts).toHaveLength(1);
    expect(prompts[0].type).toBe("box");
    expect(prompts[0].coords).toEqual([0.1, 0.1, 0.5, 0.5]);
  });

  it("does not add a prompt for a plain click when ctrl is held (remove gesture, no shape under cursor)", () => {
    const store = createFrameEditorStore();
    render(<FrameCanvas frame={FRAME} annotations={[]} store={store} />);

    const canvas = screen.getByTestId("frame-canvas");
    Object.defineProperty(canvas, "getBoundingClientRect", {
      value: () => ({ left: 0, top: 0, width: 400, height: 200 }),
    });
    fireEvent.mouseDown(canvas, { clientX: 200, clientY: 100, button: 0, ctrlKey: true });
    fireEvent.mouseUp(canvas, { clientX: 200, clientY: 100, button: 0, ctrlKey: true });

    expect(store.getState().pendingPrompts).toHaveLength(0);
  });

  it("rasterizes a freehand stroke to mask_png when activeTool is mask", () => {
    const store = createFrameEditorStore();
    store.getState().setActiveTool("mask");
    render(<FrameCanvas frame={FRAME} annotations={[]} store={store} />);

    const canvas = screen.getByTestId("frame-canvas") as HTMLCanvasElement;
    Object.defineProperty(canvas, "getBoundingClientRect", {
      value: () => ({ left: 0, top: 0, width: 400, height: 200 }),
    });
    canvas.getContext =
      canvas.getContext ??
      (() => ({
        clearRect: () => {},
        drawImage: () => {},
        beginPath: () => {},
        moveTo: () => {},
        lineTo: () => {},
        stroke: () => {},
        strokeStyle: "",
        lineWidth: 0,
        lineCap: "round",
      }) as never);
    canvas.toDataURL = () => "data:image/png;base64,ZmFrZS1wbmc=";

    fireEvent.mouseDown(canvas, { clientX: 100, clientY: 50, button: 0 });
    fireEvent.mouseMove(canvas, { clientX: 150, clientY: 80, button: 0 });
    fireEvent.mouseUp(canvas, { clientX: 200, clientY: 100, button: 0 });

    const prompts = store.getState().pendingPrompts;
    expect(prompts).toHaveLength(1);
    expect(prompts[0].type).toBe("mask");
    expect(prompts[0].mask_png).toBe("ZmFrZS1wbmc=");
  });
});
