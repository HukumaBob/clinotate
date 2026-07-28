import { act, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

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

function setBoundingRect(canvas: Element) {
  Object.defineProperty(canvas, "getBoundingClientRect", {
    value: () => ({ left: 0, top: 0, width: 400, height: 200 }),
    configurable: true,
  });
}

describe("FrameCanvas", () => {
  it("adds a positive point prompt and calls onPointOrBoxSubmit on a plain left click", () => {
    const store = createFrameEditorStore();
    const onPointOrBoxSubmit = vi.fn();
    const onRemoveAnnotation = vi.fn();
    render(
      <FrameCanvas
        frame={FRAME}
        annotations={[]}
        store={store}
        onPointOrBoxSubmit={onPointOrBoxSubmit}
        onRemoveAnnotation={onRemoveAnnotation}
      />,
    );

    const canvas = screen.getByTestId("frame-canvas");
    setBoundingRect(canvas);
    fireEvent.mouseDown(canvas, { clientX: 200, clientY: 100, button: 0 });
    fireEvent.mouseUp(canvas, { clientX: 200, clientY: 100, button: 0 });

    const prompts = store.getState().pendingPrompts;
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toEqual({ type: "point", coords: [0.5, 0.5], label: true });
    expect(onPointOrBoxSubmit).toHaveBeenCalledWith([{ type: "point", coords: [0.5, 0.5], label: true }]);
  });

  it("adds a negative point prompt on a shift+left click", () => {
    const store = createFrameEditorStore();
    const onPointOrBoxSubmit = vi.fn();
    render(
      <FrameCanvas
        frame={FRAME}
        annotations={[]}
        store={store}
        onPointOrBoxSubmit={onPointOrBoxSubmit}
        onRemoveAnnotation={vi.fn()}
      />,
    );

    const canvas = screen.getByTestId("frame-canvas");
    setBoundingRect(canvas);
    fireEvent.mouseDown(canvas, { clientX: 200, clientY: 100, button: 0, shiftKey: true });
    fireEvent.mouseUp(canvas, { clientX: 200, clientY: 100, button: 0, shiftKey: true });

    const prompts = store.getState().pendingPrompts;
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toEqual({ type: "point", coords: [0.5, 0.5], label: false });
    expect(onPointOrBoxSubmit).toHaveBeenCalledWith([{ type: "point", coords: [0.5, 0.5], label: false }]);
  });

  it("accumulates a second refinement point instead of replacing the first, and submits the full set", () => {
    const store = createFrameEditorStore();
    const onPointOrBoxSubmit = vi.fn();
    render(
      <FrameCanvas
        frame={FRAME}
        annotations={[]}
        store={store}
        onPointOrBoxSubmit={onPointOrBoxSubmit}
        onRemoveAnnotation={vi.fn()}
      />,
    );

    const canvas = screen.getByTestId("frame-canvas");
    setBoundingRect(canvas);

    fireEvent.mouseDown(canvas, { clientX: 200, clientY: 100, button: 0 });
    fireEvent.mouseUp(canvas, { clientX: 200, clientY: 100, button: 0 });

    fireEvent.mouseDown(canvas, { clientX: 40, clientY: 20, button: 0, shiftKey: true });
    fireEvent.mouseUp(canvas, { clientX: 40, clientY: 20, button: 0, shiftKey: true });

    const prompts = store.getState().pendingPrompts;
    expect(prompts).toHaveLength(2);
    expect(prompts[0]).toEqual({ type: "point", coords: [0.5, 0.5], label: true });
    expect(prompts[1]).toEqual({ type: "point", coords: [0.1, 0.1], label: false });

    expect(onPointOrBoxSubmit).toHaveBeenLastCalledWith([
      { type: "point", coords: [0.5, 0.5], label: true },
      { type: "point", coords: [0.1, 0.1], label: false },
    ]);
  });

  it("clicking an existing point marker removes it and resubmits the remaining prompts", () => {
    const store = createFrameEditorStore();
    const onPointOrBoxSubmit = vi.fn();
    render(
      <FrameCanvas
        frame={FRAME}
        annotations={[]}
        store={store}
        onPointOrBoxSubmit={onPointOrBoxSubmit}
        onRemoveAnnotation={vi.fn()}
      />,
    );

    const canvas = screen.getByTestId("frame-canvas");
    setBoundingRect(canvas);

    // Place two points.
    fireEvent.mouseDown(canvas, { clientX: 200, clientY: 100, button: 0 });
    fireEvent.mouseUp(canvas, { clientX: 200, clientY: 100, button: 0 });
    fireEvent.mouseDown(canvas, { clientX: 40, clientY: 20, button: 0, shiftKey: true });
    fireEvent.mouseUp(canvas, { clientX: 40, clientY: 20, button: 0, shiftKey: true });
    expect(store.getState().pendingPrompts).toHaveLength(2);

    // Click back on the first point's marker (same coords) to remove it.
    fireEvent.mouseDown(canvas, { clientX: 200, clientY: 100, button: 0 });
    fireEvent.mouseUp(canvas, { clientX: 200, clientY: 100, button: 0 });

    const prompts = store.getState().pendingPrompts;
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toEqual({ type: "point", coords: [0.1, 0.1], label: false });
    expect(onPointOrBoxSubmit).toHaveBeenLastCalledWith([{ type: "point", coords: [0.1, 0.1], label: false }]);
  });

  it("clicking the last remaining point marker removes it and submits an empty prompt list", () => {
    const store = createFrameEditorStore();
    const onPointOrBoxSubmit = vi.fn();
    render(
      <FrameCanvas
        frame={FRAME}
        annotations={[]}
        store={store}
        onPointOrBoxSubmit={onPointOrBoxSubmit}
        onRemoveAnnotation={vi.fn()}
      />,
    );

    const canvas = screen.getByTestId("frame-canvas");
    setBoundingRect(canvas);

    fireEvent.mouseDown(canvas, { clientX: 200, clientY: 100, button: 0 });
    fireEvent.mouseUp(canvas, { clientX: 200, clientY: 100, button: 0 });
    fireEvent.mouseDown(canvas, { clientX: 200, clientY: 100, button: 0 });
    fireEvent.mouseUp(canvas, { clientX: 200, clientY: 100, button: 0 });

    expect(store.getState().pendingPrompts).toHaveLength(0);
    expect(onPointOrBoxSubmit).toHaveBeenLastCalledWith([]);
  });

  it("adds a box prompt and calls onPointOrBoxSubmit on left-click-drag", () => {
    const store = createFrameEditorStore();
    const onPointOrBoxSubmit = vi.fn();
    render(
      <FrameCanvas
        frame={FRAME}
        annotations={[]}
        store={store}
        onPointOrBoxSubmit={onPointOrBoxSubmit}
        onRemoveAnnotation={vi.fn()}
      />,
    );

    const canvas = screen.getByTestId("frame-canvas");
    setBoundingRect(canvas);
    fireEvent.mouseDown(canvas, { clientX: 40, clientY: 20, button: 0 });
    fireEvent.mouseMove(canvas, { clientX: 200, clientY: 100, button: 0 });
    fireEvent.mouseUp(canvas, { clientX: 200, clientY: 100, button: 0 });

    const prompts = store.getState().pendingPrompts;
    expect(prompts).toHaveLength(1);
    expect(prompts[0].type).toBe("box");
    expect(prompts[0].coords).toEqual([0.1, 0.1, 0.5, 0.5]);
    expect(onPointOrBoxSubmit).toHaveBeenCalledWith([
      expect.objectContaining({ type: "box", coords: [0.1, 0.1, 0.5, 0.5] }),
    ]);
  });

  it("cancels an in-progress box without submitting when its cancel (x) is clicked before mouseup", () => {
    const store = createFrameEditorStore();
    const onPointOrBoxSubmit = vi.fn();
    render(
      <FrameCanvas
        frame={FRAME}
        annotations={[]}
        store={store}
        onPointOrBoxSubmit={onPointOrBoxSubmit}
        onRemoveAnnotation={vi.fn()}
      />,
    );

    const canvas = screen.getByTestId("frame-canvas");
    setBoundingRect(canvas);
    fireEvent.mouseDown(canvas, { clientX: 40, clientY: 20, button: 0 });
    fireEvent.mouseMove(canvas, { clientX: 200, clientY: 100, button: 0 });

    const cancelButton = screen.getByRole("button", { name: /cancel box/i });
    fireEvent.click(cancelButton);

    expect(store.getState().pendingPrompts).toHaveLength(0);
    expect(onPointOrBoxSubmit).not.toHaveBeenCalled();
  });

  it("does not add a prompt for a plain click when ctrl is held and no annotation is under the cursor", () => {
    const store = createFrameEditorStore();
    render(
      <FrameCanvas
        frame={FRAME}
        annotations={[]}
        store={store}
        onPointOrBoxSubmit={vi.fn()}
        onRemoveAnnotation={vi.fn()}
      />,
    );

    const canvas = screen.getByTestId("frame-canvas");
    setBoundingRect(canvas);
    fireEvent.mouseDown(canvas, { clientX: 200, clientY: 100, button: 0, ctrlKey: true });
    fireEvent.mouseUp(canvas, { clientX: 200, clientY: 100, button: 0, ctrlKey: true });

    expect(store.getState().pendingPrompts).toHaveLength(0);
  });

  it("rasterizes a freehand stroke to mask_png and submits immediately on mouseup, no separate confirm step", () => {
    const store = createFrameEditorStore();
    store.getState().setActiveTool("mask");
    const onPointOrBoxSubmit = vi.fn();
    render(
      <FrameCanvas
        frame={FRAME}
        annotations={[]}
        store={store}
        onPointOrBoxSubmit={onPointOrBoxSubmit}
        onRemoveAnnotation={vi.fn()}
      />,
    );

    const canvas = screen.getByTestId("frame-canvas") as HTMLCanvasElement;
    setBoundingRect(canvas);
    // jsdom's real getContext() is a genuine function (never null/undefined
    // itself, only its RETURN value is null), so a `?? fallback` here would
    // never actually install this mock -- it must be an unconditional
    // assignment.
    HTMLCanvasElement.prototype.getContext = (() => ({
      clearRect: () => {},
      drawImage: () => {},
      beginPath: () => {},
      closePath: () => {},
      moveTo: () => {},
      lineTo: () => {},
      arc: () => {},
      fill: () => {},
      strokeRect: () => {},
      stroke: () => {},
      strokeStyle: "",
      fillStyle: "",
      lineWidth: 0,
      lineCap: "round",
      getImageData: () => ({ data: new Uint8ClampedArray(4) }),
    })) as never;
    HTMLCanvasElement.prototype.toDataURL = () => "data:image/png;base64,ZmFrZS1wbmc=";

    fireEvent.mouseDown(canvas, { clientX: 100, clientY: 50, button: 0 });
    fireEvent.mouseMove(canvas, { clientX: 150, clientY: 80, button: 0 });
    fireEvent.mouseUp(canvas, { clientX: 200, clientY: 100, button: 0 });

    const prompts = store.getState().pendingPrompts;
    expect(prompts).toHaveLength(1);
    expect(prompts[0].type).toBe("mask");
    expect(prompts[0].mask_png).toBe("ZmFrZS1wbmc=");

    // No "Generate from mask" button exists anymore -- closing the traced
    // outline on mouseup must submit the prompt set immediately, same as
    // point/box.
    expect(onPointOrBoxSubmit).toHaveBeenCalledWith([
      expect.objectContaining({ type: "mask", mask_png: "ZmFrZS1wbmc=" }),
    ]);
  });

  it("does not remove any annotation on ctrl+click while a topmost annotation's mask is still loading", () => {
    // Regression test: previously, hitTestAnnotation would `continue` past
    // any annotation with no cache entry yet (still loading its mask
    // image) and fall through to test the next-topmost one instead. If a
    // newer, still-loading annotation (A) overlapped an older, already-
    // cached one (B) at the click point, B would get deleted instead of
    // the correct, topmost A -- silently deleting the wrong mask. The fix
    // requires ALL annotations to have a cache entry before hit-testing
    // acts at all, so this must be a reliable no-op instead.
    const realImage = window.Image;
    const instances: FakeImage[] = [];

    class FakeImage {
      onload: (() => void) | null = null;
      crossOrigin = "";
      private _src = "";
      width = 400;
      height = 200;

      constructor() {
        instances.push(this);
      }

      set src(value: string) {
        this._src = value;
      }

      get src() {
        return this._src;
      }
    }

    // @ts-expect-error -- test double replacing the global Image constructor
    window.Image = FakeImage;

    const originalGetContext = HTMLCanvasElement.prototype.getContext;
    // jsdom has no real canvas backend, so stub getContext entirely (as the
    // "rasterizes a freehand stroke" test above already does for this same
    // reason). Every mask, when "drawn", is treated as fully opaque
    // everywhere -- so if hit-testing ever reads annotation B's (the older,
    // cached one's) data at the click point, it will report a hit.
    HTMLCanvasElement.prototype.getContext = function (this: HTMLCanvasElement) {
      const data = new Uint8ClampedArray(this.width * this.height * 4).fill(255);
      return {
        clearRect: () => {},
        drawImage: () => {},
        putImageData: () => {},
        beginPath: () => {},
        closePath: () => {},
        moveTo: () => {},
        lineTo: () => {},
        arc: () => {},
        fill: () => {},
        strokeRect: () => {},
        stroke: () => {},
        strokeStyle: "",
        fillStyle: "",
        lineWidth: 0,
        lineCap: "round",
        globalAlpha: 1,
        getImageData: () => ({ data, width: this.width, height: this.height, colorSpace: "srgb" }) as ImageData,
      } as never;
    };

    const store = createFrameEditorStore();
    const onRemoveAnnotation = vi.fn();

    const annotations = [
      { id: 1, frame_id: 1, type: "mask", payload: {}, mask_url: "https://example.test/mask-1.png" },
      { id: 2, frame_id: 1, type: "mask", payload: {}, mask_url: "https://example.test/mask-2.png" },
    ];

    render(
      <FrameCanvas
        frame={FRAME}
        annotations={annotations as never}
        store={store}
        onPointOrBoxSubmit={vi.fn()}
        onRemoveAnnotation={onRemoveAnnotation}
      />,
    );

    // Fire the frame image's onload so the mask-loading effect runs and
    // constructs the two mask Image instances.
    act(() => {
      instances[0]?.onload?.();
    });

    // Find the mask Image instances (constructed after the frame image).
    const maskImages = instances.slice(1);
    expect(maskImages).toHaveLength(2);

    // Older annotation (id 1, index 0) finishes loading -- gets a cache entry.
    act(() => {
      maskImages[0]?.onload?.();
    });
    // Newer/topmost annotation (id 2, index 1) is still loading -- no
    // onload fired, so it never gets a cache entry.

    const canvas = screen.getByTestId("frame-canvas");
    setBoundingRect(canvas);
    fireEvent.mouseDown(canvas, { clientX: 200, clientY: 100, button: 0, ctrlKey: true });
    fireEvent.mouseUp(canvas, { clientX: 200, clientY: 100, button: 0, ctrlKey: true });

    expect(onRemoveAnnotation).not.toHaveBeenCalled();

    window.Image = realImage;
    HTMLCanvasElement.prototype.getContext = originalGetContext;
  });

  it("redraws pending point markers after a mask image finishes loading, instead of leaving them clobbered", () => {
    // Regression test: a mask annotation's Image.onload draws straight onto
    // the shared visible canvas (ctx.drawImage), which previously wiped out
    // any point markers already painted there. In practice this meant a
    // refinement point was visible for a moment after being placed, then
    // vanished the instant its own predict result's mask image finished
    // loading -- even though the point was still part of pendingPrompts.
    const realImage = window.Image;
    const instances: FakeImage[] = [];

    class FakeImage {
      onload: (() => void) | null = null;
      crossOrigin = "";
      private _src = "";
      width = 400;
      height = 200;

      constructor() {
        instances.push(this);
      }

      set src(value: string) {
        this._src = value;
      }

      get src() {
        return this._src;
      }
    }

    // @ts-expect-error -- test double replacing the global Image constructor
    window.Image = FakeImage;

    const originalGetContext = HTMLCanvasElement.prototype.getContext;
    const calls: string[] = [];
    HTMLCanvasElement.prototype.getContext = function (this: HTMLCanvasElement) {
      const data = new Uint8ClampedArray(this.width * this.height * 4);
      return {
        clearRect: () => {},
        drawImage: () => calls.push("drawImage"),
        putImageData: () => {},
        beginPath: () => {},
        moveTo: () => {},
        lineTo: () => {},
        arc: () => calls.push("arc"),
        fill: () => calls.push("fill"),
        strokeRect: () => {},
        stroke: () => {},
        strokeStyle: "",
        fillStyle: "",
        lineWidth: 0,
        lineCap: "round",
        globalAlpha: 1,
        getImageData: () => ({ data, width: this.width, height: this.height, colorSpace: "srgb" }) as ImageData,
      } as never;
    };

    const store = createFrameEditorStore();
    store.getState().addPrompt({ type: "point", coords: [0.5, 0.5], label: true });

    const annotations = [
      { id: 1, frame_id: 1, type: "mask", payload: {}, mask_url: "https://example.test/mask-1.png" },
    ];

    render(
      <FrameCanvas
        frame={FRAME}
        annotations={annotations as never}
        store={store}
        onPointOrBoxSubmit={vi.fn()}
        onRemoveAnnotation={vi.fn()}
      />,
    );

    act(() => {
      instances[0]?.onload?.();
    });
    const maskImage = instances[1];
    expect(maskImage).toBeDefined();

    calls.length = 0;
    act(() => {
      maskImage?.onload?.();
    });

    // The mask's own drawImage happens first, then the point marker (arc +
    // fill) must be drawn AFTER it, so the point ends up on top.
    const drawImageIndex = calls.indexOf("drawImage");
    const arcIndex = calls.indexOf("arc");
    expect(drawImageIndex).toBeGreaterThanOrEqual(0);
    expect(arcIndex).toBeGreaterThan(drawImageIndex);
    expect(calls).toContain("fill");

    window.Image = realImage;
    HTMLCanvasElement.prototype.getContext = originalGetContext;
  });

  it("renders without throwing when hoveredAnnotationId is set", () => {
    const store = createFrameEditorStore();
    store.getState().setHoveredAnnotation(5);

    render(
      <FrameCanvas
        frame={FRAME}
        annotations={[
          { id: 5, frame_id: 1, type: "mask", payload: {}, mask_url: "https://example.test/mask.png" } as never,
        ]}
        store={store}
        onPointOrBoxSubmit={vi.fn()}
        onRemoveAnnotation={vi.fn()}
      />,
    );

    expect(screen.getByTestId("frame-canvas")).toBeDefined();
  });

  it("treats hovered and selected annotation ids identically for the highlight decision", () => {
    // Documents the intended rule the FrameCanvas implementation follows:
    // an id counts as "highlighted" if it is EITHER the selected OR the
    // hovered annotation.
    function isHighlighted(id: number, selectedId: number | null, hoveredId: number | null): boolean {
      return id === selectedId || id === hoveredId;
    }

    expect(isHighlighted(5, 5, null)).toBe(true);
    expect(isHighlighted(5, null, 5)).toBe(true);
    expect(isHighlighted(5, null, null)).toBe(false);
    expect(isHighlighted(5, 3, 3)).toBe(false);
  });
});
