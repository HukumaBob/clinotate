import type { ClassificationDocument } from "./types";

/** Two axes over seven processed frames, 100 ms apart:
 * Anatomy: caecum caecum ascending caecum caecum transverse transverse (a blip at 200 ms)
 * Mode:    white  white  white     white  NBI    white      white      (a blip at 400 ms) */
export function makeDoc(stepMs = 100, frameStride = 1): ClassificationDocument {
  const anatomy = [0, 0, 1, 0, 0, 2, 2];
  const mode = [0, 0, 0, 0, 1, 0, 0];
  const frames: ClassificationDocument["frames"] = {};
  anatomy.forEach((classId, i) => {
    frames[String(i * frameStride)] = {
      timestamp_ms: i * stepMs,
      axes: [
        { class_id: classId, confidence: i === 0 ? 0.912 : 0.8, probs: [] },
        { class_id: mode[i], confidence: 0.99, probs: [] },
      ],
    };
  });
  return {
    task_type: "classification",
    fps: 10,
    frame_stride: frameStride,
    axes: [
      { name: "Anatomy", classes: ["caecum", "ascending", "transverse"] },
      { name: "Mode", classes: ["white light", "NBI"] },
    ],
    frames,
  };
}
