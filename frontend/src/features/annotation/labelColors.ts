import type { components } from "../../shared/api/generated/schema";

type TaxonomyTreeNode = components["schemas"]["TaxonomyTreeNode"];

export function buildLabelColorMap(tree: TaxonomyTreeNode[]): Map<number, string> {
  const map = new Map<number, string>();
  for (const categoryNode of tree) {
    for (const evaluationTypeNode of categoryNode.evaluation_types) {
      for (const label of evaluationTypeNode.labels) {
        map.set(label.id, label.color);
      }
    }
  }
  return map;
}
