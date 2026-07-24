import { useEffect, useRef, useState } from "react";
import { useStore } from "zustand/react";

import type { components } from "../../shared/api/generated/schema";
import type { FrameEditorStore, PromptDraft } from "./frameEditorStore";

type Frame = components["schemas"]["FrameRead"];
type Annotation = components["schemas"]["AnnotationRead"];

interface FrameCanvasProps {
  frame: Frame;
  annotations: Annotation[];
  store: FrameEditorStore;
  onPointOrBoxSubmit: (prompt: PromptDraft) => void;
  onRemoveAnnotation: (annotationId: number) => void;
}

interface DragState {
  startX: number;
  startY: number;
}

interface PendingBox {
  startX: number;
  startY: number;
  endX: number;
  endY: number;
}

interface RecentPoint {
  x: number;
  y: number;
  positive: boolean;
}

const POSITIVE_COLOR = "rgba(74, 222, 128, 0.95)";
const NEGATIVE_COLOR = "rgba(248, 113, 113, 0.95)";
const BOX_COLOR = "rgba(96, 165, 250, 0.95)";

export function FrameCanvas({ frame, annotations, store, onPointOrBoxSubmit, onRemoveAnnotation }: FrameCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const maskCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const dragRef = useRef<DragState | null>(null);
  const strokePointsRef = useRef<[number, number][]>([]);
  const maskImageDataCacheRef = useRef<Map<number, ImageData>>(new Map());
  const [frameImage, setFrameImage] = useState<HTMLImageElement | null>(null);
  const [pendingBox, setPendingBox] = useState<PendingBox | null>(null);
  // Points the user just placed, kept visible until the next annotations
  // refetch replaces them with a real mask overlay (or, for a rejected/
  // failed job, until cleared manually) -- without this, a submitted point
  // is invisible for the full round trip to SAM 2.1, which is exactly the
  // "invisible gesture" complaint this rewrite exists to fix.
  const [recentPoints, setRecentPoints] = useState<RecentPoint[]>([]);

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

    maskImageDataCacheRef.current = new Map();

    for (const annotation of annotations) {
      if (!annotation.mask_url) continue;
      const maskImg = new Image();
      maskImg.crossOrigin = "anonymous";
      maskImg.onload = () => {
        ctx.globalAlpha = annotation.id === selectedAnnotationId ? 0.85 : 0.5;
        ctx.drawImage(maskImg, 0, 0, canvas.width, canvas.height);
        ctx.globalAlpha = 1;

        // Cache each mask's own alpha channel offscreen (not sampled from
        // the shared visible canvas, which is a composite of the photo +
        // every mask drawn so far) so ctrl-click hit-testing can query
        // "is THIS annotation's mask opaque at this pixel" independently
        // of paint order or the other masks' overlap.
        const offscreen = document.createElement("canvas");
        offscreen.width = canvas.width;
        offscreen.height = canvas.height;
        const offCtx = offscreen.getContext("2d");
        if (offCtx) {
          offCtx.drawImage(maskImg, 0, 0, canvas.width, canvas.height);
          maskImageDataCacheRef.current.set(annotation.id, offCtx.getImageData(0, 0, canvas.width, canvas.height));
        }
      };
      maskImg.src = annotation.mask_url;
    }

    // A fresh `annotations` array means the parent's query refetched --
    // either a submitted prompt turned into a real mask, or the frame
    // changed. Either way, any placeholder point markers are now stale
    // (superseded by a real overlay, or no longer relevant to this frame),
    // so clear them rather than leaving a phantom marker with nothing
    // underneath it once the real mask has rendered.
    setRecentPoints([]);
  }, [frameImage, frame.width, frame.height, annotations, selectedAnnotationId]);

  function toNormalized(clientX: number, clientY: number): [number, number] {
    const canvas = canvasRef.current;
    if (!canvas) return [0, 0];
    const rect = canvas.getBoundingClientRect();
    const x = (clientX - rect.left) / rect.width;
    const y = (clientY - rect.top) / rect.height;
    return [Math.min(1, Math.max(0, x)), Math.min(1, Math.max(0, y))];
  }

  function hitTestAnnotation(normX: number, normY: number): number | null {
    const canvas = canvasRef.current;
    if (!canvas) return null;
    const pixelX = Math.floor(normX * canvas.width);
    const pixelY = Math.floor(normY * canvas.height);

    // Topmost = last-rendered = last element of `annotations` that has
    // cached image data and a nonzero alpha at this pixel.
    for (let i = annotations.length - 1; i >= 0; i -= 1) {
      const annotation = annotations[i];
      const imageData = maskImageDataCacheRef.current.get(annotation.id);
      if (!imageData) continue;
      const pixelIndex = (pixelY * canvas.width + pixelX) * 4;
      const alpha = imageData.data[pixelIndex + 3];
      if (alpha > 0) return annotation.id;
    }
    return null;
  }

  function handleMouseDown(event: React.MouseEvent<HTMLCanvasElement>) {
    if (event.button !== 0) return;
    const [x, y] = toNormalized(event.clientX, event.clientY);

    if (event.ctrlKey) {
      const hitId = hitTestAnnotation(x, y);
      if (hitId !== null) onRemoveAnnotation(hitId);
      return;
    }

    dragRef.current = { startX: x, startY: y };
    if (activeTool === "mask") {
      strokePointsRef.current = [[x, y]];
      if (!maskCanvasRef.current) {
        maskCanvasRef.current = document.createElement("canvas");
      }
      const maskCanvas = maskCanvasRef.current;
      maskCanvas.width = frame.width;
      maskCanvas.height = frame.height;
      const maskCtx = maskCanvas.getContext("2d");
      maskCtx?.clearRect(0, 0, maskCanvas.width, maskCanvas.height);
    }
  }

  function drawPendingOverlay(box: PendingBox | null, points: RecentPoint[] = recentPoints) {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx || !frameImage) return;

    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(frameImage, 0, 0, canvas.width, canvas.height);
    for (const annotation of annotations) {
      const imageData = maskImageDataCacheRef.current.get(annotation.id);
      if (!imageData) continue;
      ctx.globalAlpha = annotation.id === selectedAnnotationId ? 0.85 : 0.5;
      ctx.putImageData(imageData, 0, 0);
      ctx.globalAlpha = 1;
    }

    const pointRadius = Math.max(4, canvas.width * 0.008);
    for (const point of points) {
      ctx.fillStyle = point.positive ? POSITIVE_COLOR : NEGATIVE_COLOR;
      ctx.beginPath();
      ctx.arc(point.x * canvas.width, point.y * canvas.height, pointRadius, 0, Math.PI * 2);
      ctx.fill();
    }

    if (box) {
      const x = Math.min(box.startX, box.endX) * canvas.width;
      const y = Math.min(box.startY, box.endY) * canvas.height;
      const w = Math.abs(box.endX - box.startX) * canvas.width;
      const h = Math.abs(box.endY - box.startY) * canvas.height;
      ctx.strokeStyle = BOX_COLOR;
      ctx.lineWidth = Math.max(2, canvas.width * 0.003);
      ctx.strokeRect(x, y, w, h);
    }
  }

  function handleMouseMove(event: React.MouseEvent<HTMLCanvasElement>) {
    const drag = dragRef.current;
    if (!drag) return;
    const [x, y] = toNormalized(event.clientX, event.clientY);

    if (activeTool === "mask") {
      strokePointsRef.current.push([x, y]);
      const canvas = canvasRef.current;
      const ctx = canvas?.getContext("2d");
      if (!canvas || !ctx) return;
      const points = strokePointsRef.current;
      const [prevX, prevY] = points.length > 1 ? points[points.length - 2] : points[0];

      ctx.strokeStyle = "rgba(34, 211, 238, 0.9)";
      ctx.lineWidth = Math.max(2, canvas.width * 0.01);
      ctx.lineCap = "round";
      ctx.beginPath();
      ctx.moveTo(prevX * canvas.width, prevY * canvas.height);
      ctx.lineTo(x * canvas.width, y * canvas.height);
      ctx.stroke();

      const maskCanvas = maskCanvasRef.current;
      const maskCtx = maskCanvas?.getContext("2d");
      if (maskCanvas && maskCtx) {
        maskCtx.strokeStyle = "rgba(255, 255, 255, 1)";
        maskCtx.lineWidth = Math.max(2, maskCanvas.width * 0.01);
        maskCtx.lineCap = "round";
        maskCtx.beginPath();
        maskCtx.moveTo(prevX * maskCanvas.width, prevY * maskCanvas.height);
        maskCtx.lineTo(x * maskCanvas.width, y * maskCanvas.height);
        maskCtx.stroke();
      }
      return;
    }

    const dx = Math.abs(x - drag.startX);
    const dy = Math.abs(y - drag.startY);
    if (dx > 0.01 || dy > 0.01) {
      const box = { startX: drag.startX, startY: drag.startY, endX: x, endY: y };
      setPendingBox(box);
      drawPendingOverlay(box);
    }
  }

  function submitPointOrBox(prompt: PromptDraft) {
    addPrompt(prompt);
    onPointOrBoxSubmit(prompt);
    if (prompt.type === "point") {
      const [x, y] = prompt.coords;
      const updated = [...recentPoints, { x, y, positive: prompt.label }];
      setRecentPoints(updated);
      drawPendingOverlay(null, updated);
    }
  }

  function handleMouseUp(event: React.MouseEvent<HTMLCanvasElement>) {
    if (event.button !== 0) return;
    const drag = dragRef.current;
    dragRef.current = null;

    if (event.ctrlKey) return;

    if (activeTool === "mask") {
      const maskCanvas = maskCanvasRef.current;
      if (maskCanvas && strokePointsRef.current.length > 1) {
        const dataUrl = maskCanvas.toDataURL("image/png");
        const base64 = dataUrl.split(",")[1] ?? "";
        addPrompt({ type: "mask", coords: [], label: true, mask_png: base64 });
      }
      strokePointsRef.current = [];
      return;
    }

    if (!drag) return;
    const [endX, endY] = toNormalized(event.clientX, event.clientY);
    const dx = Math.abs(endX - drag.startX);
    const dy = Math.abs(endY - drag.startY);
    const isDrag = dx > 0.01 || dy > 0.01;

    if (isDrag) {
      submitPointOrBox({
        type: "box",
        coords: [
          Math.min(drag.startX, endX),
          Math.min(drag.startY, endY),
          Math.max(drag.startX, endX),
          Math.max(drag.startY, endY),
        ],
        label: true,
      });
      setPendingBox(null);
    } else {
      submitPointOrBox({
        type: "point",
        coords: [drag.startX, drag.startY],
        label: !event.shiftKey,
      });
    }
  }

  function handleCancelBox() {
    setPendingBox(null);
    dragRef.current = null;
    drawPendingOverlay(null);
  }

  const canvas = canvasRef.current;
  let cancelButtonStyle: React.CSSProperties | undefined;
  if (pendingBox && canvas) {
    const rect = canvas.getBoundingClientRect();
    const boxLeft = Math.min(pendingBox.startX, pendingBox.endX) * rect.width;
    const boxTop = Math.min(pendingBox.startY, pendingBox.endY) * rect.height;
    cancelButtonStyle = { position: "absolute", left: boxLeft, top: boxTop, transform: "translate(-50%, -50%)" };
  }

  return (
    <div className="relative h-full w-full">
      <canvas
        ref={canvasRef}
        data-testid="frame-canvas"
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        className="h-full w-full cursor-crosshair bg-gray-900"
      />
      {pendingBox && (
        <button
          type="button"
          aria-label="Cancel box"
          onClick={handleCancelBox}
          style={cancelButtonStyle}
          className="flex h-5 w-5 items-center justify-center rounded-full bg-gray-950 text-xs text-gray-200 shadow"
        >
          ✕
        </button>
      )}
    </div>
  );
}
