import type { components } from "../../../shared/api/generated/schema";

export type Episode = components["schemas"]["EvalEpisodeRead"];

export function sortEpisodes(episodes: Episode[], mode: "longest" | "confident"): Episode[] {
  const byMode =
    mode === "longest"
      ? (a: Episode, b: Episode) => b.frames - a.frames || a.start_ms - b.start_ms
      : (a: Episode, b: Episode) =>
          b.mean_confidence - a.mean_confidence ||
          b.frames - a.frames ||
          a.start_ms - b.start_ms;
  return [...episodes].sort(byMode);
}

export function formatRatio(value: number | null): string {
  return value === null ? "—" : `${(value * 100).toFixed(1)}%`;
}

export function episodeSpans(
  episodes: Episode[],
  stepMs: number,
): { startMs: number; endMs: number }[] {
  return episodes.map((e) => ({ startMs: e.start_ms, endMs: e.end_ms + stepMs }));
}

/** Median gap between consecutive processed timestamps; 0 for fewer than two. */
export function processedStepMs(timestamps: number[]): number {
  if (timestamps.length < 2) return 0;
  const gaps: number[] = [];
  for (let i = 1; i < timestamps.length; i++) gaps.push(timestamps[i] - timestamps[i - 1]);
  gaps.sort((a, b) => a - b);
  const mid = gaps.length >> 1;
  return gaps.length % 2 === 1 ? gaps[mid] : (gaps[mid - 1] + gaps[mid]) / 2;
}
