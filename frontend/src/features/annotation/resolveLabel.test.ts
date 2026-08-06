import { describe, expect, it } from "vitest";

import { resolveLabelFromTree } from "./resolveLabel";
import type { components } from "../../shared/api/generated/schema";

type TaxonomyTreeNode = components["schemas"]["TaxonomyTreeNode"];

function buildTree(): TaxonomyTreeNode[] {
  return [
    {
      category: { id: 1, name: "Polyp", procedure_id: 1 },
      evaluation_types: [
        {
          evaluation_type: { id: 10, name: "Morphology" },
          labels: [
            { id: 100, name: "Sessile", color: "#ff0000", category_id: 1 },
            { id: 101, name: "Pedunculated", color: "#00ff00", category_id: 1 },
          ],
        },
      ],
    },
    {
      category: { id: 2, name: "Bleeding", procedure_id: 1 },
      evaluation_types: [
        {
          evaluation_type: { id: 20, name: "Severity" },
          labels: [{ id: 200, name: "Active", color: "#0000ff", category_id: 2 }],
        },
      ],
    },
  ];
}

describe("resolveLabelFromTree", () => {
  it("resolves a label nested under the first category/evaluation type", () => {
    const result = resolveLabelFromTree(buildTree(), 100);
    expect(result).toEqual({
      categoryId: 1,
      categoryName: "Polyp",
      tag: { id: 100, name: "Sessile", color: "#ff0000", category_id: 1 },
      classification: 10,
    });
  });

  it("resolves a label nested under a later category", () => {
    const result = resolveLabelFromTree(buildTree(), 200);
    expect(result).toEqual({
      categoryId: 2,
      categoryName: "Bleeding",
      tag: { id: 200, name: "Active", color: "#0000ff", category_id: 2 },
      classification: 20,
    });
  });

  it("returns null when the label id is not present anywhere in the tree", () => {
    expect(resolveLabelFromTree(buildTree(), 999)).toBeNull();
  });

  it("returns null for an empty tree", () => {
    expect(resolveLabelFromTree([], 100)).toBeNull();
  });
});
