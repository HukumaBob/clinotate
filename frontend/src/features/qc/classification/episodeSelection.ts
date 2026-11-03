import type { Episode } from "./evaluationLogic";

export type EpisodeFilters = {
  interiorOnly: boolean;
  minFrames: number | null;
  minConfidence: number | null;
};

/** Stable identity of an episode within a run: its axis and start time. */
export function episodeKey(axis: string, episode: { start_ms: number }): string {
  return `${axis}|${episode.start_ms}`;
}

/** Keys of the episodes that pass every enabled filter. */
export function filterSelection(
  axis: string,
  episodes: Episode[],
  filters: EpisodeFilters,
): string[] {
  return episodes
    .filter(
      (e) =>
        (!filters.interiorOnly || e.kind === "interior") &&
        (filters.minFrames === null || e.frames >= filters.minFrames) &&
        (filters.minConfidence === null || e.mean_confidence >= filters.minConfidence),
    )
    .map((e) => episodeKey(axis, e));
}

/** Parse keys back; the axis may contain "|", so split on the last one. */
export function toRequestEpisodes(keys: string[]): { axis: string; start_ms: number }[] {
  const out: { axis: string; start_ms: number }[] = [];
  for (const key of keys) {
    const cut = key.lastIndexOf("|");
    if (cut <= 0) continue;
    const raw = key.slice(cut + 1);
    if (!/^-?\d+$/.test(raw)) continue;
    out.push({ axis: key.slice(0, cut), start_ms: Number(raw) });
  }
  return out;
}

export function selectionSummary(
  keys: string[],
  episodesByAxis: Record<string, Episode[]>,
): { episodes: number; frames: number } {
  const wanted = new Set(keys);
  let episodes = 0;
  let frames = 0;
  for (const [axis, list] of Object.entries(episodesByAxis)) {
    for (const e of list) {
      if (wanted.has(episodeKey(axis, e))) {
        episodes += 1;
        frames += e.frames;
      }
    }
  }
  return { episodes, frames };
}
