export interface ClassificationDocument {
  task_type: "classification";
  fps: number;
  frame_stride: number;
  axes: { name: string; classes: string[] }[];
  frames: Record<
    string,
    {
      timestamp_ms: number;
      axes: { class_id: number; confidence: number; probs: number[] }[];
    }
  >;
}
