import { describe, expect, it } from "vitest";

import { buildLabelColorMap } from "../src/features/annotation/labelColors";
import type { components } from "../src/shared/api/generated/schema";

type TaxonomyTreeNode = components["schemas"]["TaxonomyTreeNode"];

function label(overrides: Partial<components["schemas"]["LabelRead"]> = {}): components["schemas"]["LabelRead"] {
  return {
    id: 1,
    name: "lesion",
    color: "#ffffff",
    category_id: 1,
    evaluation_type_id: 1,
    taxonomy_version: 1,
    ...overrides,
  };
}

describe("buildLabelColorMap", () => {
  it("maps a label id to its own color", () => {
    const tree: TaxonomyTreeNode[] = [
      {
        category: { id: 1, name: "Anatomy", procedure_id: 5 },
        evaluation_types: [
          {
            evaluation_type: { id: 1, name: "geometric" },
            labels: [label({ id: 10, color: "#ff0000" })],
          },
        ],
      },
    ];
    const map = buildLabelColorMap(tree);
    expect(map.get(10)).toBe("#ff0000");
  });

  it("does not map the category id itself, since categories have no color in this schema", () => {
    const tree: TaxonomyTreeNode[] = [
      {
        category: { id: 1, name: "Anatomy", procedure_id: 5 },
        evaluation_types: [
          {
            evaluation_type: { id: 1, name: "geometric" },
            labels: [label({ id: 10, color: "#ff0000" })],
          },
        ],
      },
    ];
    const map = buildLabelColorMap(tree);
    expect(map.has(1)).toBe(false);
  });

  it("covers labels across multiple categories and evaluation types", () => {
    const tree: TaxonomyTreeNode[] = [
      {
        category: { id: 1, name: "Anatomy", procedure_id: 5 },
        evaluation_types: [
          { evaluation_type: { id: 1, name: "geometric" }, labels: [label({ id: 10, color: "#ff0000" })] },
        ],
      },
      {
        category: { id: 2, name: "Findings", procedure_id: 5 },
        evaluation_types: [
          { evaluation_type: { id: 2, name: "morphological" }, labels: [label({ id: 20, color: "#00ff00" })] },
        ],
      },
    ];
    const map = buildLabelColorMap(tree);
    expect(map.get(10)).toBe("#ff0000");
    expect(map.get(20)).toBe("#00ff00");
  });

  it("returns an empty map for an empty tree", () => {
    const map = buildLabelColorMap([]);
    expect(map.size).toBe(0);
  });
});
