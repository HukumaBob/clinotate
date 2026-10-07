export type FlagKind = "fp" | "fn";
export type FlagAction = "create" | "change" | "remove" | "blocked";

/** What pressing a flag key means on a frame, given any flag already there:
 * the same kind toggles it off, the other kind changes it, and a flag
 * already sent to training is never touched. */
export function decideFlagAction(
  existing: { kind: FlagKind; committed: boolean } | undefined,
  pressed: FlagKind,
): FlagAction {
  if (!existing) return "create";
  if (existing.committed) return "blocked";
  return existing.kind === pressed ? "remove" : "change";
}
