import type { components } from "../../shared/api/generated/schema";

type TaxonomyTreeNode = components["schemas"]["TaxonomyTreeNode"];
type LabelRead = components["schemas"]["LabelRead"];

export interface ResolvedLabel {
  categoryId: number;
  categoryName: string;
  tag: LabelRead;
  classification: number;
}

export function resolveLabelFromTree(tree: TaxonomyTreeNode[], labelId: number): ResolvedLabel | null {
  for (const categoryNode of tree) {
    for (const evaluationTypeNode of categoryNode.evaluation_types) {
      const label = evaluationTypeNode.labels.find((l) => l.id === labelId);
      if (label) {
        return {
          categoryId: categoryNode.category.id,
          categoryName: categoryNode.category.name,
          tag: label,
          classification: evaluationTypeNode.evaluation_type.id,
        };
      }
    }
  }
  return null;
}
