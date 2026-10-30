// Only the model types the worker can run; classification is a later slice.
const RUNNABLE_TASKS = new Set(["detection", "segmentation"]);
// QC inference runs on the Ultralytics checkpoints only. A DINOv3 version
// inherits its dataset's task type, so the task filter alone would offer it
// and the backend would then refuse the run.
const RUNNABLE_ADAPTER = "ultralytics_yolo";

export function runnableModels<T extends { task_type: string; adapter: string }>(
  models: T[],
): T[] {
  return models.filter((m) => RUNNABLE_TASKS.has(m.task_type) && m.adapter === RUNNABLE_ADAPTER);
}
