import type { Detection } from "../predictions";

/** Intersection over union of two [x, y, w, h] boxes. */
export function iou(a: Detection["bbox"], b: Detection["bbox"]): number {
  const width = Math.min(a[0] + a[2], b[0] + b[2]) - Math.max(a[0], b[0]);
  const height = Math.min(a[1] + a[3], b[1] + b[3]) - Math.max(a[1], b[1]);
  if (width <= 0 || height <= 0) return 0;
  const intersection = width * height;
  const union = a[2] * a[3] + b[2] * b[3] - intersection;
  return union > 0 ? intersection / union : 0;
}

/** Greedy class-aware non-maximum suppression: boxes are visited from the
 * most to the least confident, and one is dropped when its IoU with an
 * already kept box of the same class is at or above `maxIou`. The result
 * is ordered by confidence, highest first. Boxes only: segmentation
 * polygons are not intersected. */
export function nms(detections: Detection[], maxIou: number): Detection[] {
  const order = detections
    .map((_, i) => i)
    .sort((i, j) => detections[j].confidence - detections[i].confidence);
  const kept: Detection[] = [];
  for (const i of order) {
    const candidate = detections[i];
    const suppressed = kept.some(
      (other) => other.class_id === candidate.class_id && iou(other.bbox, candidate.bbox) >= maxIou,
    );
    if (!suppressed) kept.push(candidate);
  }
  return kept;
}
