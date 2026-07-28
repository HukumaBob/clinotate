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
  onPointOrBoxSubmit: (prompts: PromptDraft[]) => void;
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

const POSITIVE_COLOR = "rgba(74, 222, 128, 0.95)";
const NEGATIVE_COLOR = "rgba(248, 113, 113, 0.95)";
const BOX_COLOR = "rgba(96, 165, 250, 0.95)";

function isHighlighted(annotationId: number, selectedId: number | null, hoveredId: number | null): boolean {
  return annotationId === selectedId || annotationId === hoveredId;
}

// Strokes a dashed bounding box around the mask's opaque region so a draft
// (still-being-refined) annotation reads as visually distinct from a
// committed one at a glance. A precise silhouette trace is unnecessary here
// -- masks are usually a single blob, and a bounding-box outline is cheap
// and unambiguous.
function traceAlphaOutline(ctx: CanvasRenderingContext2D, imageData: ImageData, width: number, height: number): void {
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  const { data } = imageData;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const alpha = data[(y * width + x) * 4 + 3];
      if (alpha > 0) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < minX || maxY < minY) return;
  ctx.strokeRect(minX, minY, maxX - minX, maxY - minY);
}

export function FrameCanvas({ frame, annotations, store, onPointOrBoxSubmit, onRemoveAnnotation }: FrameCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const maskCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const maskTintCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const dragRef = useRef<DragState | null>(null);
  const strokePointsRef = useRef<[number, number][]>([]);
  const maskImageDataCacheRef = useRef<Map<number, ImageData>>(new Map());
  const [frameImage, setFrameImage] = useState<HTMLImageElement | null>(null);
  const [pendingBox, setPendingBox] = useState<PendingBox | null>(null);
  // A submitted rough-mask stroke only ever existed as pixels drawn
  // directly on the visible canvas -- not as reusable data -- so the very
  // next full redraw (triggered by pendingPrompts changing, which addPrompt
  // itself causes) wiped it out with nothing to redraw. Decoding it back
  // into an Image here makes it part of the same overlay every other
  // pending prompt already draws from, so it survives redraws until
  // "Generate from mask" clears pendingPrompts.
  const [pendingMaskStrokeImage, setPendingMaskStrokeImage] = useState<HTMLImageElement | null>(null);

  const activeTool = useStore(store, (state) => state.activeTool);
  const addPrompt = useStore(store, (state) => state.addPrompt);
  const setMaskPrompt = useStore(store, (state) => state.setMaskPrompt);
  // Points the user has placed for the object currently being refined --
  // read straight from the store (not a local echo) so they stay visible
  // for as long as they're actually part of the prompt set, through every
  // annotations refetch, instead of vanishing the moment the first draft
  // mask arrives.
  const pendingPrompts = useStore(store, (state) => state.pendingPrompts);
  const removePromptAt = useStore(store, (state) => state.removePromptAt);
  const selectedAnnotationId = useStore(store, (state) => state.selectedAnnotationId);
  const hoveredAnnotationId = useStore(store, (state) => state.hoveredAnnotationId);
  const draftAnnotationId = useStore(store, (state) => state.draftAnnotationId);

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
    // Draw pending point markers immediately, before any mask image has had
    // a chance to load -- otherwise there's a visible gap (bare frame, no
    // points, no mask) between this redraw firing and the async mask
    // image(s) finishing, which happens on every annotations refetch (e.g.
    // right after submitting a refinement point).
    drawPendingPoints();

    maskImageDataCacheRef.current = new Map();

    for (const annotation of annotations) {
      if (!annotation.mask_url) continue;
      const maskImg = new Image();
      maskImg.crossOrigin = "anonymous";
      maskImg.onload = () => {
        ctx.globalAlpha = isHighlighted(annotation.id, selectedAnnotationId, hoveredAnnotationId) ? 0.85 : 0.5;
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

        // A mask image's onload draws straight onto the visible canvas,
        // stomping over any point markers drawn there previously -- redraw
        // them on top so a refinement point never visually disappears the
        // instant its own predict result lands (they're still part of
        // pendingPrompts; only the rendering was clobbered).
        drawPendingPoints();
      };
      maskImg.src = annotation.mask_url;
    }

    // selectedAnnotationId/hoveredAnnotationId intentionally excluded: they
    // only affect the alpha of already-loaded masks, which the lightweight
    // drawPendingOverlay effect below repaints from maskImageDataCacheRef.
    // Including them here would re-run this effect on every hover/select
    // change, tearing down and re-decoding every mask Image on the frame
    // from scratch (new Image() + full PNG decode + a fresh offscreen
    // getImageData pass, per annotation) -- for hover in particular, that
    // means one full re-decode pass of every mask per mouseenter/mouseleave
    // while sweeping the cursor across MasksList rows.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [frameImage, frame.width, frame.height, annotations]);

  // Decode the current mask prompt's mask_png (if any) into an Image so
  // drawPendingOverlay can redraw the rough-mask stroke on every redraw,
  // the same way it redraws point markers -- instead of the stroke living
  // only as pixels on the visible canvas, gone the instant anything forces
  // a redraw.
  useEffect(() => {
    // The backend keeps only the LAST mask prompt if several are present
    // (each overwrites mask_input in _prompts_to_predict_kwargs's loop), so
    // the preview must match that -- show the most recent stroke, not the
    // first.
    const maskPrompt = [...pendingPrompts].reverse().find((p) => p.type === "mask");
    if (!maskPrompt?.mask_png) {
      setPendingMaskStrokeImage(null);
      // The mask prompt is gone (object finished via Generate from mask, or
      // pendingPrompts was cleared) -- discard the accumulation canvas too,
      // so the NEXT rough-mask object starts from a blank canvas instead of
      // painting on top of the previous object's leftover strokes.
      maskCanvasRef.current = null;
      return;
    }
    const img = new Image();
    img.onload = () => setPendingMaskStrokeImage(img);
    img.src = `data:image/png;base64,${maskPrompt.mask_png}`;
  }, [pendingPrompts]);

  // Re-draw the point markers whenever the accumulated prompt set changes
  // (a point added or removed) so they track pendingPrompts live, on top
  // of whatever draft mask is currently rendered underneath.
  useEffect(() => {
    drawPendingOverlay(pendingBox);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingPrompts, pendingMaskStrokeImage, draftAnnotationId, selectedAnnotationId, hoveredAnnotationId]);

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

    // Each annotation's alpha-channel cache is populated asynchronously,
    // once its mask image's `onload` fires. If any annotation (not just
    // the ones actually under the click point) is still loading, we can't
    // yet tell whether it would have been the topmost hit -- testing only
    // the ready ones risks hitting a lower, already-cached annotation
    // while a newer, still-loading one on top of it at this exact pixel
    // gets skipped entirely. Decline to act at all until every annotation
    // has a cache entry, rather than silently testing a partial set.
    const allCached = annotations.every((annotation) => maskImageDataCacheRef.current.has(annotation.id));
    if (!allCached) return null;

    const pixelX = Math.floor(normX * canvas.width);
    const pixelY = Math.floor(normY * canvas.height);

    // Topmost = last-rendered = last element of `annotations` with a
    // nonzero alpha at this pixel.
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

  // Finds the index of the nearest pending point prompt within click range
  // of (normX, normY), so a click can remove a mis-placed refinement point
  // instead of only ever being able to add more.
  function hitTestPendingPoint(normX: number, normY: number): number | null {
    const canvas = canvasRef.current;
    if (!canvas) return null;
    const radiusNorm = pointMarkerRadius(canvas) / canvas.width;
    let closestIndex: number | null = null;
    let closestDistance = Infinity;
    pendingPrompts.forEach((prompt, index) => {
      if (prompt.type !== "point") return;
      const [px, py] = prompt.coords;
      const distance = Math.hypot(px - normX, py - normY);
      if (distance <= radiusNorm * 2.5 && distance < closestDistance) {
        closestDistance = distance;
        closestIndex = index;
      }
    });
    return closestIndex;
  }

  function handleMouseDown(event: React.MouseEvent<HTMLCanvasElement>) {
    if (event.button !== 0) return;
    const [x, y] = toNormalized(event.clientX, event.clientY);

    if (event.ctrlKey) {
      const hitId = hitTestAnnotation(x, y);
      if (hitId !== null) onRemoveAnnotation(hitId);
      return;
    }

    if (!event.shiftKey) {
      const pointIndex = hitTestPendingPoint(x, y);
      if (pointIndex !== null) {
        removePromptAt(pointIndex);
        const remaining = store.getState().pendingPrompts;
        onPointOrBoxSubmit(remaining);
        return;
      }
    }

    dragRef.current = { startX: x, startY: y };
    if (activeTool === "mask") {
      strokePointsRef.current = [[x, y]];
      // Lazily create the offscreen accumulation canvas ONCE per frame and
      // never reset its width/height (or clearRect it) on a later stroke --
      // setting .width/.height on a canvas wipes its buffer even when the
      // value is unchanged, and this used to run on every single stroke,
      // erasing every previous brush stroke the instant a new one started.
      // Rough-mask painting is a multi-stroke gesture (the whole point of
      // a brush tool), so strokes must accumulate on this canvas until
      // "Generate from mask" is clicked.
      if (!maskCanvasRef.current) {
        const maskCanvas = document.createElement("canvas");
        maskCanvas.width = frame.width;
        maskCanvas.height = frame.height;
        maskCanvasRef.current = maskCanvas;
      }
    }
  }

  function pointMarkerRadius(canvas: HTMLCanvasElement): number {
    return Math.max(4, canvas.width * 0.008);
  }

  // Draws the current pendingPrompts' point markers on top of whatever is
  // already on the canvas, WITHOUT clearing it first -- used both by the
  // full-redraw path (drawPendingOverlay) and by each mask image's onload,
  // which draws straight onto the visible canvas and would otherwise paint
  // over any markers already there.
  function drawPendingPoints() {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;
    const pointRadius = pointMarkerRadius(canvas);
    for (const prompt of store.getState().pendingPrompts) {
      if (prompt.type !== "point") continue;
      const [x, y] = prompt.coords;
      ctx.fillStyle = prompt.label ? POSITIVE_COLOR : NEGATIVE_COLOR;
      ctx.beginPath();
      ctx.arc(x * canvas.width, y * canvas.height, pointRadius, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  function drawPendingOverlay(box: PendingBox | null) {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx || !frameImage) return;

    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(frameImage, 0, 0, canvas.width, canvas.height);
    for (const annotation of annotations) {
      const imageData = maskImageDataCacheRef.current.get(annotation.id);
      if (!imageData) continue;
      ctx.globalAlpha = isHighlighted(annotation.id, selectedAnnotationId, hoveredAnnotationId) ? 0.85 : 0.5;
      ctx.putImageData(imageData, 0, 0);
      ctx.globalAlpha = 1;

      if (annotation.id === draftAnnotationId) {
        // The draft (still-being-refined) mask gets a dashed outline drawn
        // on top of its fill, so it reads as visually distinct from a
        // committed mask without needing a second decode of the mask image.
        ctx.save();
        ctx.setLineDash([4, 3]);
        ctx.lineWidth = Math.max(2, canvas.width * 0.003);
        ctx.strokeStyle = "rgba(255, 255, 255, 0.9)";
        traceAlphaOutline(ctx, imageData, canvas.width, canvas.height);
        ctx.restore();
      }
    }

    if (pendingMaskStrokeImage) {
      // pendingMaskStrokeImage is the RAW rough-mask data sent to SAM2 -- a
      // white stroke on a transparent/white canvas (see handleMouseMove's
      // maskCtx below), never meant to be shown to the user as-is (it's
      // invisible against a white/light frame). Recolor it to the same
      // visible brush color used while actively drawing, using the raw
      // mask as an alpha stencil via 'source-in' -- this reproduces
      // exactly the stroke the user drew, nothing more.
      const canvasW = canvas.width;
      const canvasH = canvas.height;
      let tintCanvas = maskTintCanvasRef.current;
      if (!tintCanvas) {
        tintCanvas = document.createElement("canvas");
        maskTintCanvasRef.current = tintCanvas;
      }
      tintCanvas.width = canvasW;
      tintCanvas.height = canvasH;
      const tintCtx = tintCanvas.getContext("2d");
      if (tintCtx) {
        tintCtx.clearRect(0, 0, canvasW, canvasH);
        tintCtx.drawImage(pendingMaskStrokeImage, 0, 0, canvasW, canvasH);
        tintCtx.globalCompositeOperation = "source-in";
        tintCtx.fillStyle = "rgba(34, 211, 238, 0.9)";
        tintCtx.fillRect(0, 0, canvasW, canvasH);
        tintCtx.globalCompositeOperation = "source-over";

        ctx.drawImage(tintCanvas, 0, 0, canvasW, canvasH);
      }
    }

    drawPendingPoints();

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
    // Points/boxes accumulate as refinement prompts for the SAME in-progress
    // object -- each new gesture re-predicts using the FULL accumulated set
    // (not just the latest gesture), matching how SAM's own point-refinement
    // model works (a lone negative point elsewhere narrows the same mask; it
    // does not start a new object). The prompt list is only cleared when the
    // object is finished (Track / Generate from mask), not on every click.
    addPrompt(prompt);
    const updatedPrompts = [...store.getState().pendingPrompts];
    onPointOrBoxSubmit(updatedPrompts);
  }

  function handleMouseUp(event: React.MouseEvent<HTMLCanvasElement>) {
    if (event.button !== 0) return;
    const drag = dragRef.current;
    dragRef.current = null;

    if (event.ctrlKey) return;

    if (activeTool === "mask") {
      const maskCanvas = maskCanvasRef.current;
      const maskCtx = maskCanvas?.getContext("2d");
      if (maskCanvas && maskCtx && strokePointsRef.current.length > 1) {
        // SAM2's mask_input is the model's belief about which pixels ARE
        // the object -- so it needs the FILLED interior of what the user
        // traced, not just the thin outline stroke itself. Submitting only
        // the outline (as this used to do) gives the model a ~3%-coverage
        // sliver instead of the actual rough-mask region, producing a
        // noticeably worse result than even a plain box prompt. Close the
        // traced path back to its start point and fill it solid before
        // reading back the canvas.
        const points = strokePointsRef.current;
        maskCtx.fillStyle = "rgba(255, 255, 255, 1)";
        maskCtx.beginPath();
        maskCtx.moveTo(points[0][0] * maskCanvas.width, points[0][1] * maskCanvas.height);
        for (const [px, py] of points.slice(1)) {
          maskCtx.lineTo(px * maskCanvas.width, py * maskCanvas.height);
        }
        maskCtx.closePath();
        maskCtx.fill();

        const dataUrl = maskCanvas.toDataURL("image/png");
        const base64 = dataUrl.split(",")[1] ?? "";
        setMaskPrompt(base64);
        // Submit immediately, same as point/box -- a closed, filled stroke
        // is already a complete prompt the instant the mouse is released,
        // so there's no separate "confirm" step needed (an explicit
        // Generate button was redundant with the gesture itself).
        onPointOrBoxSubmit(store.getState().pendingPrompts);
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
