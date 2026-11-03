/** For each model axis, the index of the reference axis sharing the most class
 * names (ties to the lower index); null when no class name is shared. */
export function matchAxes(
  modelAxes: { name: string; classes: string[] }[],
  refAxes: { categoryId: number; classes: { name: string }[] }[],
): (number | null)[] {
  return modelAxes.map((model) => {
    const names = new Set(model.classes);
    let best: number | null = null;
    let bestShared = 0;
    refAxes.forEach((ref, i) => {
      const shared = new Set(ref.classes.map((c) => c.name).filter((n) => names.has(n))).size;
      if (shared > bestShared) {
        best = i;
        bestShared = shared;
      }
    });
    return best;
  });
}
