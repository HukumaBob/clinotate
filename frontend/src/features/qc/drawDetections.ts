import { colorForClass, type Detection } from "./predictions";

export interface Rect {
  left: number;
  top: number;
  width: number;
  height: number;
}

const LABEL_FONT = "12px sans-serif";
const LABEL_HEIGHT = 16;

/** Draws onto a canvas that covers the whole <video> element. `rect` is
 * where the picture actually sits inside that element (letterboxing), so
 * normalised coordinates are scaled against it, not against the canvas. */
export function drawDetections(
  ctx: CanvasRenderingContext2D,
  rect: Rect,
  detections: Detection[],
  classes: string[],
  threshold: number,
): void {
  for (const detection of detections) {
    if (detection.confidence < threshold) continue;
    const color = colorForClass(detection.class_id);
    const [x, y, w, h] = detection.bbox;
    const px = rect.left + x * rect.width;
    const py = rect.top + y * rect.height;

    if (detection.polygon && detection.polygon.length > 0) {
      ctx.beginPath();
      detection.polygon.forEach(([vx, vy], i) => {
        const cx = rect.left + vx * rect.width;
        const cy = rect.top + vy * rect.height;
        if (i === 0) ctx.moveTo(cx, cy);
        else ctx.lineTo(cx, cy);
      });
      ctx.closePath();
      ctx.fillStyle = color;
      ctx.globalAlpha = 0.3;
      ctx.fill();
      ctx.globalAlpha = 1;
      ctx.strokeStyle = color;
      ctx.lineWidth = 2;
      ctx.stroke();
    }

    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.strokeRect(px, py, w * rect.width, h * rect.height);

    const name = classes[detection.class_id] ?? `#${detection.class_id}`;
    const label = `${name} ${detection.confidence.toFixed(2)}`;
    ctx.font = LABEL_FONT;
    const labelWidth = ctx.measureText(label).width + 8;
    ctx.fillStyle = color;
    ctx.fillRect(px, Math.max(py - LABEL_HEIGHT, 0), labelWidth, LABEL_HEIGHT);
    ctx.fillStyle = "#000000";
    ctx.fillText(label, px + 4, Math.max(py - LABEL_HEIGHT, 0) + 12);
  }
}
