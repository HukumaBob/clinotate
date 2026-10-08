import type { InferenceRun } from "../../entities/useInferenceRuns";

export type Comparability = { ok: true } | { ok: false; reason: string };

export function comparability(a: InferenceRun | undefined, b: InferenceRun | undefined): Comparability {
  if (!a || !b) return { ok: false, reason: "Select two runs to compare" };
  if (a.id === b.id) return { ok: false, reason: "Select two different runs" };
  if (a.status !== "succeeded" || b.status !== "succeeded")
    return { ok: false, reason: "Both runs must be finished" };
  if (a.video_id !== b.video_id) return { ok: false, reason: "The runs are of different videos" };
  if (a.frame_stride !== b.frame_stride)
    return { ok: false, reason: "The runs used different frame strides" };
  return { ok: true };
}

/** fp: the wrong side saw a class the other did not. fn: it missed one. */
export function flagKindForWrongSide(
  side: "a" | "b",
  frame: { only_a: string[]; only_b: string[] },
): "fp" | "fn" {
  const own = side === "a" ? frame.only_a : frame.only_b;
  return own.length > 0 ? "fp" : "fn";
}

/** The next disagreement strictly after (or before) `currentMs`; null at the ends. */
export function nextDisagreement(timesMs: number[], currentMs: number, direction: 1 | -1): number | null {
  const sorted = [...timesMs].sort((x, y) => x - y);
  if (direction === 1) return sorted.find((t) => t > currentMs) ?? null;
  return [...sorted].reverse().find((t) => t < currentMs) ?? null;
}
