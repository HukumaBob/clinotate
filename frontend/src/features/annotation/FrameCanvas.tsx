import { useEffect, useRef, useState, type MutableRefObject } from "react";
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
  labelColorById?: Map<number, string>;
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

const MASK_FILL_ALPHA = 0.35;
const MASK_FILL_ALPHA_HIGHLIGHTED = 0.55;
const MASK_OUTLINE_COLOR = "rgba(255, 255, 255, 0.95)";
const DEFAULT_MASK_COLOR = "#22d3ee";

// Stored mask PNGs (see ml-worker's sam2_adapter.py/sam3_adapter.py,
// Image.fromarray(mask_array, mode="L")) are plain opaque grayscale --
// white (255) pixels are inside the mask, black (0) pixels are outside,
// and the alpha channel itself is 255 everywhere (no per-pixel
// transparency at all). Decoding such a PNG via drawImage+getImageData
// therefore yields alpha=255 across the WHOLE canvas, not a silhouette --
// treating that raw alpha as "is this pixel part of the mask" (as every
// consumer of maskImageDataCacheRef used to) makes every mask cover its
// entire bounding canvas. This converts the grayscale luminance into a
// real alpha channel in place, using the same >=128 threshold the
// backend already uses when converting a rough-mask PNG back into SAM2
// logits (_mask_png_to_logits), so silhouette tracing, hit-testing, and
// the tinted fill all operate on genuine transparency.
function luminanceToAlphaMask(imageData: ImageData): void {
  const { data } = imageData;
  for (let i = 0; i < data.length; i += 4) {
    data[i + 3] = data[i] >= 128 ? 255 : 0;
  }
}

function hexToRgb(hex: string): [number, number, number] {
  const normalized = hex.replace("#", "");
  const full =
    normalized.length === 3
      ? normalized
          .split("")
          .map((c) => c + c)
          .join("")
      : normalized;
  const value = Number.parseInt(full, 16);
  if (Number.isNaN(value) || full.length !== 6) return [34, 211, 238];
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255];
}

// Traces the actual silhouette of a mask's opaque region, pixel by pixel:
// an opaque pixel counts as a boundary pixel if any of its 4-connected
// neighbors (or the image edge) is transparent. This is a real per-pixel
// outline (not a bounding box), matching how SAM/CVAT-style tools outline
// a mask -- cheap enough at annotation-frame resolution since it's a
// single pass over the cached alpha channel, no marching-squares/vector
// tracing needed for a screen-space highlight.
function traceAlphaOutline(
  ctx: CanvasRenderingContext2D,
  imageData: ImageData,
  width: number,
  height: number,
  dashPeriod?: number,
): void {
  const { data } = imageData;
  const isOpaque = (x: number, y: number) => x >= 0 && x < width && y >= 0 && y < height && data[(y * width + x) * 4 + 3] > 0;

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (!isOpaque(x, y)) continue;
      const isBoundary = !isOpaque(x - 1, y) || !isOpaque(x + 1, y) || !isOpaque(x, y - 1) || !isOpaque(x, y + 1);
      if (!isBoundary) continue;
      // Dashed mode approximates a stroke dash pattern along the silhouette
      // by skipping boundary pixels in bands based on position -- ctx.stroke's
      // built-in setLineDash only applies to path strokes, not this per-pixel
      // fillRect trace, so the dash has to be encoded into which pixels get
      // drawn at all.
      if (dashPeriod && Math.floor((x + y) / dashPeriod) % 2 === 0) continue;
      ctx.fillRect(x, y, 1, 1);
    }
  }
}

// Renders a mask's cached alpha silhouette as a colored, semi-transparent
// fill (tinted by the label's own color via a 'source-in' stencil, the
// same technique already used for pendingMaskStrokeImage below) plus an
// always-opaque silhouette outline on top, so the mask reads as a distinct
// highlighted region rather than an opaque black-and-white cutout that
// hides the frame underneath.
function paintMaskOverlay(
  ctx: CanvasRenderingContext2D,
  imageData: ImageData,
  color: string,
  fillAlpha: number,
  tintCanvasRef: MutableRefObject<HTMLCanvasElement | null>,
): void {
  const { width, height } = imageData;
  let tintCanvas = tintCanvasRef.current;
  if (!tintCanvas) {
    tintCanvas = document.createElement("canvas");
    tintCanvasRef.current = tintCanvas;
  }
  tintCanvas.width = width;
  tintCanvas.height = height;
  const tintCtx = tintCanvas.getContext("2d");
  if (!tintCtx) return;

  tintCtx.clearRect(0, 0, width, height);
  tintCtx.putImageData(imageData, 0, 0);
  const [r, g, b] = hexToRgb(color);
  tintCtx.globalCompositeOperation = "source-in";
  tintCtx.fillStyle = `rgb(${r}, ${g}, ${b})`;
  tintCtx.fillRect(0, 0, width, height);
  tintCtx.globalCompositeOperation = "source-over";

  ctx.globalAlpha = fillAlpha;
  ctx.drawImage(tintCanvas, 0, 0);
  ctx.globalAlpha = 1;

  ctx.fillStyle = MASK_OUTLINE_COLOR;
  traceAlphaOutline(ctx, imageData, width, height);
}

export function FrameCanvas({
  frame,
  annotations,
  store,
  onPointOrBoxSubmit,
  onRemoveAnnotation,
  labelColorById,
}: FrameCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const maskCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const maskTintCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const maskOverlayTintCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const dragRef = useRef<DragState | null>(null);
  const strokePointsRef = useRef<[number, number][]>([]);
  const maskImageDataCacheRef = useRef<Map<number, ImageData>>(new Map());
  const [frameImage, setFrameImage] = useState<HTMLImageElement | null>(null);
  const [pendingBox, setPendingBox] = useState<PendingBox | null>(null);
  // Mirrors pendingBox for the async mask-image onload handler below, which
  // runs inside a closure captured when the frame/annotations effect last
  // ran -- reading pendingBox directly there could use a stale value from
  // before the user started (or cancelled) a box drag.
  const pendingBoxRef = useRef<PendingBox | null>(null);
  useEffect(() => {
    pendingBoxRef.current = pendingBox;
  }, [pendingBox]);
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
  const labelTagId = useStore(store, (state) => state.labelTagId);
  const triggerLabelPickerPulse = useStore(store, (state) => state.triggerLabelPickerPulse);
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
          const imageData = offCtx.getImageData(0, 0, canvas.width, canvas.height);
          luminanceToAlphaMask(imageData);
          maskImageDataCacheRef.current.set(annotation.id, imageData);
        }

        // Route through drawPendingOverlay instead of drawing this mask
        // directly -- it's the single source of truth for "what alpha does
        // each cached mask get right now" (reads current
        // selectedAnnotationId/hoveredAnnotationId). Drawing directly here
        // with the alpha captured at effect-setup time raced with hover/
        // select changes: whichever of the two finished last "won", so a
        // mask could get stuck highlighted after the mouse left if this
        // onload's stale alpha was applied after drawPendingOverlay's fresh
        // one for the same paint.
        drawPendingOverlay(pendingBoxRef.current);
      };
      maskImg.src = annotation.mask_url;
    }

    // selectedAnnotationId/hoveredAnnotationId/labelColorById intentionally
    // excluded: they only affect the fill color/alpha of already-loaded
    // masks, which the lightweight drawPendingOverlay effect below repaints
    // from maskImageDataCacheRef. Including them here would re-run this
    // effect on every hover/select change (or once the label tree query
    // resolves after this frame's first paint), tearing down and
    // re-decoding every mask Image on the frame from scratch (new Image()
    // + full PNG decode + a fresh offscreen getImageData pass, per
    // annotation) -- for hover in particular, that means one full re-decode
    // pass of every mask per mouseenter/mouseleave while sweeping the
    // cursor across MasksList rows.
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
  }, [pendingPrompts, pendingMaskStrokeImage, draftAnnotationId, selectedAnnotationId, hoveredAnnotationId, labelColorById]);

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

    if (labelTagId === null) {
      triggerLabelPickerPulse();
      return;
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
      const highlighted = isHighlighted(annotation.id, selectedAnnotationId, hoveredAnnotationId);
      const color = labelColorById?.get(annotation.label_id) ?? DEFAULT_MASK_COLOR;
      paintMaskOverlay(
        ctx,
        imageData,
        color,
        highlighted ? MASK_FILL_ALPHA_HIGHLIGHTED : MASK_FILL_ALPHA,
        maskOverlayTintCanvasRef,
      );

      if (annotation.id === draftAnnotationId) {
        // The draft (still-being-refined) mask gets an additional dashed
        // silhouette outline in the accent color, drawn on top of
        // paintMaskOverlay's always-solid white outline, so draft vs.
        // committed stays visually distinct at a glance.
        ctx.fillStyle = "rgba(34, 211, 238, 0.9)";
        traceAlphaOutline(ctx, imageData, canvas.width, canvas.height, 6);
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
        className={`h-full w-full bg-gray-900 ${labelTagId === null ? "cursor-not-allowed" : "cursor-crosshair"}`}
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
