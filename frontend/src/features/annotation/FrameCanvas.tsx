import { useEffect, useRef, useState } from "react";
import { useStore } from "zustand/react";

import type { components } from "../../shared/api/generated/schema";
import type { FrameEditorStore } from "./frameEditorStore";

type Frame = components["schemas"]["FrameRead"];
type Annotation = components["schemas"]["AnnotationRead"];

interface FrameCanvasProps {
  frame: Frame;
  annotations: Annotation[];
  store: FrameEditorStore;
}

interface DragState {
  startX: number;
  startY: number;
}

export function FrameCanvas({ frame, annotations, store }: FrameCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const dragRef = useRef<DragState | null>(null);
  const [frameImage, setFrameImage] = useState<HTMLImageElement | null>(null);

  const activeTool = useStore(store, (state) => state.activeTool);
  const addPrompt = useStore(store, (state) => state.addPrompt);
  const selectedAnnotationId = useStore(store, (state) => state.selectedAnnotationId);

  useEffect(() => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => setFrameImage(img);
    img.src = frame.image_url;
  }, [frame.image_url]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !frameImage) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    canvas.width = frame.width;
    canvas.height = frame.height;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(frameImage, 0, 0, canvas.width, canvas.height);

    for (const annotation of annotations) {
      if (!annotation.mask_url) continue;
      const maskImg = new Image();
      maskImg.crossOrigin = "anonymous";
      maskImg.onload = () => {
        ctx.globalAlpha = annotation.id === selectedAnnotationId ? 0.85 : 0.5;
        ctx.drawImage(maskImg, 0, 0, canvas.width, canvas.height);
        ctx.globalAlpha = 1;
      };
      maskImg.src = annotation.mask_url;
    }
  }, [frameImage, frame.width, frame.height, annotations, selectedAnnotationId]);

  function toNormalized(clientX: number, clientY: number): [number, number] {
    const canvas = canvasRef.current;
    if (!canvas) return [0, 0];
    const rect = canvas.getBoundingClientRect();
    const x = (clientX - rect.left) / rect.width;
    const y = (clientY - rect.top) / rect.height;
    return [Math.min(1, Math.max(0, x)), Math.min(1, Math.max(0, y))];
  }

  function handleMouseDown(event: React.MouseEvent<HTMLCanvasElement>) {
    if (event.button !== 0) return;
    if (event.ctrlKey) return; // remove-shape gesture, handled on mouseup below
    const [x, y] = toNormalized(event.clientX, event.clientY);
    dragRef.current = { startX: x, startY: y };
  }

  function handleMouseUp(event: React.MouseEvent<HTMLCanvasElement>) {
    if (event.button !== 0) return;
    const drag = dragRef.current;
    dragRef.current = null;

    if (event.ctrlKey) {
      // Remove-shape gesture: no hit-testing wired to canvas clicks yet --
      // removal is handled by the masks list (Task 13) via its own
      // selection + delete affordance, not by clicking the canvas.
      return;
    }
    if (!drag || activeTool === "mask") return;

    const [endX, endY] = toNormalized(event.clientX, event.clientY);
    const dx = Math.abs(endX - drag.startX);
    const dy = Math.abs(endY - drag.startY);
    const isDrag = dx > 0.01 || dy > 0.01;

    if (isDrag) {
      addPrompt({
        type: "box",
        coords: [
          Math.min(drag.startX, endX),
          Math.min(drag.startY, endY),
          Math.max(drag.startX, endX),
          Math.max(drag.startY, endY),
        ],
        label: true,
      });
    } else {
      addPrompt({ type: "point", coords: [drag.startX, drag.startY], label: true });
    }
  }

  return (
    <canvas
      ref={canvasRef}
      data-testid="frame-canvas"
      onMouseDown={handleMouseDown}
      onMouseUp={handleMouseUp}
      className="h-full w-full cursor-crosshair bg-gray-900"
    />
  );
}
