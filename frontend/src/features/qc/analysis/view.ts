import { DISPLAY_CONFIDENCE_THRESHOLD, type FrameIndex, type PredictionsDocument } from "../predictions";
import { nms } from "./nms";

export interface ViewParams {
  /** Detections below this confidence are hidden. */
  threshold: number;
  /** Class-aware NMS IoU limit; NMS_OFF means the model's own result is kept. */
  nmsIou: number;
  /** Flicker window: the longest run, in processed frames, that counts as a flicker. */
  flickerN: number;
}

/** The model already applied NMS at about this IoU, so the slider's top
 * position means "leave it alone". */
export const NMS_OFF = 0.7;

export const DEFAULT_VIEW_PARAMS: ViewParams = {
  threshold: DISPLAY_CONFIDENCE_THRESHOLD,
  nmsIou: NMS_OFF,
  flickerN: 2,
};

/** The stored predictions with the display parameters applied, in the same
 * shape the overlay already reads. The threshold is applied first so a
 * hidden strong box can never suppress a visible weaker one. */
export function buildView(
  doc: PredictionsDocument,
  params: Pick<ViewParams, "threshold" | "nmsIou">,
): FrameIndex {
  const entries = Object.values(doc.frames).sort((a, b) => a.timestamp_ms - b.timestamp_ms);
  return {
    timestamps: entries.map((entry) => entry.timestamp_ms),
    detections: entries.map((entry) => {
      const visible = entry.detections.filter((d) => d.confidence >= params.threshold);
      return params.nmsIou >= NMS_OFF ? visible : nms(visible, params.nmsIou);
    }),
  };
}
