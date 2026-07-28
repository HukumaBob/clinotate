import { describe, expect, it } from "vitest";

import { buildLabelColorMap } from "../src/features/annotation/labelColors";
import type { components } from "../src/shared/api/generated/schema";

type LabelTreeNode = components["schemas"]["LabelTreeNode"];

function label(overrides: Partial<components["schemas"]["LabelRead"]> = {}): components["schemas"]["LabelRead"] {
  return {
    id: 1,
    name: "lesion",
    label_type: "geometric",
    color: "#ffffff",
    procedure_id: null,
    taxonomy_version: 1,
    ...overrides,
  };
}

describe("buildLabelColorMap", () => {
  it("maps a category id to its own color", () => {
    const tree: LabelTreeNode[] = [{ category: label({ id: 1, color: "#ff0000" }), children: [] }];
    const map = buildLabelColorMap(tree);
    expect(map.get(1)).toBe("#ff0000");
  });

  it("maps a child tag id to its own color, not the parent category's", () => {
    const tree: LabelTreeNode[] = [
      {
        category: label({ id: 1, color: "#ff0000" }),
        children: [label({ id: 2, color: "#00ff00" })],
      },
    ];
    const map = buildLabelColorMap(tree);
    expect(map.get(2)).toBe("#00ff00");
    expect(map.get(1)).toBe("#ff0000");
  });

  it("covers multiple categories and their children", () => {
    const tree: LabelTreeNode[] = [
      { category: label({ id: 1, color: "#ff0000" }), children: [label({ id: 2, color: "#00ff00" })] },
      { category: label({ id: 3, color: "#0000ff" }), children: [label({ id: 4, color: "#ffff00" })] },
    ];
    const map = buildLabelColorMap(tree);
    expect(map.get(1)).toBe("#ff0000");
    expect(map.get(2)).toBe("#00ff00");
    expect(map.get(3)).toBe("#0000ff");
    expect(map.get(4)).toBe("#ffff00");
  });

  it("returns an empty map for an empty tree", () => {
    const map = buildLabelColorMap([]);
    expect(map.size).toBe(0);
  });
});
