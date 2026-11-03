import { describe, expect, it } from "vitest";

import { matchAxes } from "./matchAxes";

const ref = (categoryId: number, names: string[]) => ({ categoryId, classes: names.map((name) => ({ name })) });

describe("matchAxes", () => {
  it("is empty for no model axes", () => {
    expect(matchAxes([], [ref(1, ["a"])])).toEqual([]);
  });
  it("is null when there are no reference axes", () => {
    expect(matchAxes([{ name: "m", classes: ["a"] }], [])).toEqual([null]);
  });
  it("picks the reference axis sharing the most names", () => {
    expect(matchAxes([{ name: "m", classes: ["a", "b", "c"] }], [ref(1, ["a"]), ref(2, ["b", "c"])])).toEqual([1]);
  });
  it("ignores a model class missing from the reference", () => {
    expect(matchAxes([{ name: "m", classes: ["a", "zzz"] }], [ref(1, ["a", "b"])])).toEqual([0]);
  });
  it("breaks a tie between axes sharing one name to the lower index", () => {
    expect(matchAxes([{ name: "m", classes: ["a"] }], [ref(1, ["a"]), ref(2, ["a"])])).toEqual([0]);
  });
  it("is null when nothing overlaps", () => {
    expect(matchAxes([{ name: "m", classes: ["a"] }], [ref(1, ["b"])])).toEqual([null]);
  });
});
