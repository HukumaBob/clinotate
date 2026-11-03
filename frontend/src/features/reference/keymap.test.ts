import { describe, expect, it } from "vitest";

import { buildKeymap } from "./keymap";
import type { RefAxis } from "./types";

const KEYS = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "0", null];

describe("buildKeymap", () => {
  it("maps ten keyed classes and leaves the eleventh without an entry", () => {
    const axis: RefAxis = {
      categoryId: 7,
      name: "Quality",
      classes: KEYS.map((key, i) => ({ labelId: 100 + i, name: `c${i}`, key })),
    };
    const map = buildKeymap([axis]);
    expect(map.size).toBe(10);
    expect(map.get("1")).toEqual({ categoryId: 7, labelId: 100 });
    expect(map.get("0")).toEqual({ categoryId: 7, labelId: 109 });
  });
  it("is empty for no axes", () => {
    expect(buildKeymap([]).size).toBe(0);
  });
  it("keeps the first class on a duplicate key", () => {
    const map = buildKeymap([
      { categoryId: 1, name: "a", classes: [{ labelId: 1, name: "x", key: "1" }] },
      { categoryId: 2, name: "b", classes: [{ labelId: 2, name: "y", key: "1" }] },
    ]);
    expect(map.get("1")).toEqual({ categoryId: 1, labelId: 1 });
  });
});
