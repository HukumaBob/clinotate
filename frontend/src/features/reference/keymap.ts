import type { RefAxis } from "./types";

export interface KeyTarget {
  categoryId: number;
  labelId: number;
}

/** Key -> class. Classes without a key are absent; the first class wins a duplicate key. */
export function buildKeymap(axes: RefAxis[]): Map<string, KeyTarget> {
  const map = new Map<string, KeyTarget>();
  for (const axis of axes) {
    for (const cls of axis.classes) {
      if (cls.key === null || map.has(cls.key)) continue;
      map.set(cls.key, { categoryId: axis.categoryId, labelId: cls.labelId });
    }
  }
  return map;
}
