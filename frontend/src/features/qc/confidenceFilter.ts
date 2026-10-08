import type { PredictionsDocument } from "./predictions";

/** The document with detections below `threshold` removed. */
export function filterByConfidence(doc: PredictionsDocument, threshold: number): PredictionsDocument {
  return {
    ...doc,
    frames: Object.fromEntries(
      Object.entries(doc.frames).map(([key, frame]) => [
        key,
        { ...frame, detections: frame.detections.filter((d) => d.confidence >= threshold) },
      ]),
    ),
  };
}
