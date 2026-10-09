import type { components } from "../../shared/api/generated/schema";
import { allFields, defaultValues, type SettingsSchema, type SettingsValues } from "./settingsLogic";

type TrainingRunRead = components["schemas"]["TrainingRunRead"];

/** The headline score, which differs by task: mAP50 measures how well
 * predicted boxes overlap real ones and does not exist for a classifier,
 * whose score is top-1 accuracy instead. Showing a dash for a classifier
 * would hide the only number it produces. The known keys are Ultralytics'
 * own; a trainer with a different vocabulary (e.g. RT-DETR's "ap_50") has
 * neither, so we fall back to the first numeric entry in `metrics` and
 * label it with its own key -- never a hardcoded name next to a dash,
 * which would misattribute a metric the trainer never produced. */
export function headlineScore(
  taskType: string,
  metrics: Record<string, unknown>,
): { label: string; value: string } {
  const isClassification = taskType === "classification";
  const raw = isClassification
    ? metrics["metrics/accuracy_top1"] ?? metrics["accuracy_top1"]
    : metrics["metrics/mAP50(B)"] ?? metrics["mAP50"];
  if (typeof raw === "number") {
    return { label: isClassification ? "top-1" : "mAP50", value: raw.toFixed(3) };
  }
  const fallback = Object.entries(metrics).find(([, value]) => typeof value === "number");
  if (fallback) {
    const [key, value] = fallback;
    return { label: key, value: (value as number).toFixed(3) };
  }
  return { label: "", value: "—" };
}

export function headlineValue(taskType: string, metrics: Record<string, unknown>): number | null {
  const raw =
    taskType === "classification"
      ? (metrics["metrics/accuracy_top1"] ?? metrics["accuracy_top1"])
      : (metrics["metrics/mAP50(B)"] ?? metrics["mAP50"]);
  return typeof raw === "number" ? raw : null;
}

export function formatDuration(
  startedAt: string | null,
  finishedAt: string | null,
  now: Date = new Date(),
): string {
  if (!startedAt) return "—";
  const end = finishedAt ? new Date(finishedAt) : now;
  if (Number.isNaN(end.getTime()) || Number.isNaN(new Date(startedAt).getTime())) return "—";
  const seconds = Math.max(0, Math.round((end.getTime() - new Date(startedAt).getTime()) / 1000));
  if (seconds >= 3600) {
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    return `${hours}h ${String(minutes).padStart(2, "0")}m`;
  }
  if (seconds >= 60) {
    const minutes = Math.floor(seconds / 60);
    return `${minutes}m ${String(seconds % 60).padStart(2, "0")}s`;
  }
  return `${seconds}s`;
}

export function settingsLine(config: Record<string, unknown>): string {
  const parts: string[] = [];
  if (config.imgsz != null) parts.push(String(config.imgsz));
  if (config.batch != null) parts.push(`b${config.batch}`);
  if (config.epochs != null) parts.push(`${config.epochs} ep`);
  if (config.freeze !== undefined && config.freeze !== null) parts.push(`freeze ${config.freeze}`);
  if (typeof config.optimizer === "string" && config.optimizer !== "auto") parts.push(config.optimizer);
  return parts.join(" · ");
}

/** The best finished run by a *known* headline metric, or null when fewer than two
 * runs are comparable (an unknown vocabulary has no agreed direction). */
export function bestRunId(runs: TrainingRunRead[]): number | null {
  const scored = runs
    .filter((run) => run.status === "succeeded" || run.status === "stopped")
    .map((run) => ({ id: run.id, value: headlineValue(run.task_type, run.metrics as Record<string, unknown>) }))
    .filter((entry): entry is { id: number; value: number } => entry.value !== null);
  if (scored.length < 2) return null;
  return scored.reduce((best, entry) => (entry.value > best.value ? entry : best)).id;
}

export function baseKeyFromRun(run: TrainingRunRead): string {
  return run.base_model_version_id !== null && run.base_model_version_id !== undefined
    ? `version:${run.base_model_version_id}`
    : `pretrained:${run.base_model}`;
}

export function valuesFromConfig(schema: SettingsSchema, config: Record<string, unknown>): SettingsValues {
  const values = defaultValues(schema);
  for (const field of allFields(schema)) {
    if (field.key in config) {
      const value = config[field.key];
      values[field.key] = (value ?? null) as SettingsValues[string];
    }
  }
  return values;
}

/** A run is active while it is queued or training. */
export function isActiveRun(run: TrainingRunRead): boolean {
  return run.status === "pending" || run.status === "running";
}
