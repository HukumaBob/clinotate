import { MIN_INTERVAL_MS, SNAP_MS, type RefInterval } from "./types";

export type KeyAction =
  | { kind: "start"; startMs: number }
  | { kind: "close"; id: number; endMs: number }
  | { kind: "switch"; closeId: number; closeEndMs: number; startMs: number }
  | { kind: "relabel"; id: number }
  | { kind: "none" };

/** End of the nearest interval of the axis ending at or before tMs, if at most
 * SNAP_MS before it; otherwise tMs. */
export function snapStart(intervals: RefInterval[], categoryId: number, tMs: number): number {
  let best = -Infinity;
  for (const iv of intervals) {
    if (iv.categoryId !== categoryId || iv.endMs > tMs || tMs - iv.endMs > SNAP_MS) continue;
    if (iv.endMs > best) best = iv.endMs;
  }
  return best === -Infinity ? tMs : best;
}

/** Start of the next interval of the axis beginning at or after fromMs (ignoring selfId). */
function nextStart(intervals: RefInterval[], categoryId: number, selfId: number | null, fromMs: number): number {
  let next = Infinity;
  for (const iv of intervals) {
    if (iv.categoryId !== categoryId || iv.id === selfId) continue;
    if (iv.startMs >= fromMs && iv.startMs < next) next = iv.startMs;
  }
  return next;
}

/** Free room after a start: up to the next interval of the axis or the video end. */
function roomAfter(
  intervals: RefInterval[],
  categoryId: number,
  selfId: number | null,
  startMs: number,
  durationMs: number,
): number {
  return Math.min(nextStart(intervals, categoryId, selfId, startMs), durationMs) - startMs;
}

/** Limits an end so it never passes the next interval of the axis or the video
 * end, and never falls below startMs + MIN_INTERVAL_MS (the minimum wins). */
export function clampEnd(
  intervals: RefInterval[],
  categoryId: number,
  selfId: number | null,
  startMs: number,
  endMs: number,
  durationMs: number,
): number {
  const upper = Math.min(nextStart(intervals, categoryId, selfId, startMs), durationMs);
  return Math.max(Math.min(endMs, upper), startMs + MIN_INTERVAL_MS);
}

/** A copy of the interval with one edge moved, clamped against its neighbours
 * on the axis, the video bounds and the minimum length. Null for an unknown id. */
export function moveEdge(
  intervals: RefInterval[],
  id: number,
  edge: "start" | "end",
  ms: number,
  durationMs: number,
): RefInterval | null {
  const self = intervals.find((iv) => iv.id === id);
  if (!self) return null;
  if (edge === "start") {
    let lower = 0;
    for (const iv of intervals) {
      if (iv.categoryId === self.categoryId && iv.id !== id && iv.endMs <= self.startMs && iv.endMs > lower) {
        lower = iv.endMs;
      }
    }
    const upper = self.endMs - MIN_INTERVAL_MS;
    return { ...self, startMs: Math.max(lower, Math.min(ms, upper)) };
  }
  const lower = self.startMs + MIN_INTERVAL_MS;
  const upper = Math.min(nextStart(intervals, self.categoryId, id, self.endMs), durationMs);
  if (upper < lower) return { ...self };
  return { ...self, endMs: Math.max(lower, Math.min(ms, upper)) };
}

export function decideKey(
  state: { growing: Record<number, RefInterval | undefined>; selectedId: number | null; intervals: RefInterval[] },
  target: { categoryId: number; labelId: number },
  tMs: number,
  durationMs: number,
): KeyAction {
  const { categoryId, labelId } = target;
  const growing = state.growing[categoryId];
  if (growing) {
    const endMs = clampEnd(state.intervals, categoryId, growing.id, growing.startMs, tMs, durationMs);
    if (growing.labelId === labelId) return { kind: "close", id: growing.id, endMs };
    if (roomAfter(state.intervals, categoryId, growing.id, endMs, durationMs) < MIN_INTERVAL_MS) {
      return { kind: "close", id: growing.id, endMs };
    }
    return { kind: "switch", closeId: growing.id, closeEndMs: endMs, startMs: endMs };
  }
  const selected =
    state.selectedId === null
      ? undefined
      : state.intervals.find((iv) => iv.id === state.selectedId && iv.categoryId === categoryId);
  if (selected) return { kind: "relabel", id: selected.id };
  const inside = state.intervals.some((iv) => iv.categoryId === categoryId && iv.startMs < tMs && tMs < iv.endMs);
  if (inside) return { kind: "none" };
  const startMs = snapStart(state.intervals, categoryId, tMs);
  if (roomAfter(state.intervals, categoryId, null, startMs, durationMs) < MIN_INTERVAL_MS) return { kind: "none" };
  return { kind: "start", startMs };
}

/** Fraction (0..1) of the video covered by the axis's intervals. */
export function coverage(intervals: RefInterval[], categoryId: number, durationMs: number): number {
  if (durationMs <= 0) return 0;
  let covered = 0;
  for (const iv of intervals) {
    if (iv.categoryId === categoryId) covered += Math.max(0, Math.min(iv.endMs, durationMs) - Math.max(iv.startMs, 0));
  }
  return Math.min(1, covered / durationMs);
}
