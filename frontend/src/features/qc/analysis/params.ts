import { DEFAULT_VIEW_PARAMS, type ViewParams } from "./view";

export const PARAM_LIMITS = {
  threshold: { min: 0.05, max: 1, step: 0.01 },
  nmsIou: { min: 0.3, max: 0.7, step: 0.05 },
  flickerN: { min: 1, max: 10, step: 1 },
} as const;

export const PARAMS_STORAGE_KEY = "qc-view-params";

function clampOne(key: keyof ViewParams, value: unknown): number {
  const limits = PARAM_LIMITS[key];
  if (typeof value !== "number" || !Number.isFinite(value)) return DEFAULT_VIEW_PARAMS[key];
  const clamped = Math.min(Math.max(value, limits.min), limits.max);
  // Two decimals keep slider values comparable (0.35, not 0.35000000000000003);
  // the flicker window is a whole number of frames.
  return key === "flickerN" ? Math.round(clamped) : Math.round(clamped * 100) / 100;
}

/** Turns anything (stored JSON, a stray slider event) into valid parameters. */
export function clampParams(raw: Partial<Record<keyof ViewParams, unknown>>): ViewParams {
  return {
    threshold: clampOne("threshold", raw.threshold),
    nmsIou: clampOne("nmsIou", raw.nmsIou),
    flickerN: clampOne("flickerN", raw.flickerN),
  };
}

/** Storage can be blocked, empty or corrupt (private windows, cleared site
 * data); the screen must render with the defaults in every case. */
export function loadParams(storage?: Pick<Storage, "getItem">): ViewParams {
  try {
    // Resolved inside the try: merely reading window.localStorage throws a
    // SecurityError when site data is blocked.
    const raw = (storage ?? window.localStorage).getItem(PARAMS_STORAGE_KEY);
    if (!raw) return { ...DEFAULT_VIEW_PARAMS };
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === "object"
      ? clampParams(parsed as Partial<Record<keyof ViewParams, unknown>>)
      : { ...DEFAULT_VIEW_PARAMS };
  } catch {
    return { ...DEFAULT_VIEW_PARAMS };
  }
}

export function saveParams(params: ViewParams, storage?: Pick<Storage, "setItem">): void {
  try {
    (storage ?? window.localStorage).setItem(PARAMS_STORAGE_KEY, JSON.stringify(params));
  } catch {
    // A convenience only; losing it is fine.
  }
}
