export interface RefInterval {
  id: number;
  categoryId: number;
  labelId: number;
  /** Intervals are half-open: [startMs, endMs). */
  startMs: number;
  endMs: number;
}

export interface RefAxis {
  categoryId: number;
  name: string;
  classes: { labelId: number; name: string; key: string | null }[];
}

export const MIN_INTERVAL_MS = 100;
export const SNAP_MS = 1000;
