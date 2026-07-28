import type { components } from "../../shared/api/generated/schema";

type LabelTreeNode = components["schemas"]["LabelTreeNode"];

export function buildLabelColorMap(tree: LabelTreeNode[]): Map<number, string> {
  const map = new Map<number, string>();
  for (const node of tree) {
    map.set(node.category.id, node.category.color);
    for (const child of node.children) {
      map.set(child.id, child.color);
    }
  }
  return map;
}
