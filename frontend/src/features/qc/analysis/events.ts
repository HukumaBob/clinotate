/** Tolerance so the event the playhead already sits on is not picked again. */
const TOLERANCE_MS = 1;

/** `events` must be sorted by startMs (findFlickers and mergeBlips return them that way). */
export function nextEvent<T extends { startMs: number }>(events: T[], timeMs: number): T | null {
  return events.find((event) => event.startMs > timeMs + TOLERANCE_MS) ?? null;
}

export function prevEvent<T extends { startMs: number }>(events: T[], timeMs: number): T | null {
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i].startMs < timeMs - TOLERANCE_MS) return events[i];
  }
  return null;
}
