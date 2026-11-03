import { useMutation, useQueryClient } from "@tanstack/react-query";

import { apiClient } from "../shared/api/client";
import type { components } from "../shared/api/generated/schema";

export type CommitEpisodesRead = components["schemas"]["CommitEpisodesRead"];

export type CommitEpisodesVariables = {
  episodes: { axis: string; start_ms: number }[];
  stepMs: number;
  marginMs: number;
  name?: string | null;
  dryRun: boolean;
};

/** Sends (or, with dryRun, only counts) frames around chosen error episodes. */
export function useCommitEpisodes(
  runId: number | null,
  videoId?: number | null,
  options?: { /** Runs for a real commit only, even after the caller unmounted. */ onSuccess?: (data: CommitEpisodesRead) => void },
) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (vars: CommitEpisodesVariables): Promise<CommitEpisodesRead> => {
      const result = await apiClient.POST("/reference/runs/{run_id}/commit-episodes", {
        params: { path: { run_id: runId as number } },
        body: {
          episodes: vars.episodes,
          step_ms: vars.stepMs,
          margin_ms: vars.marginMs,
          name: vars.name,
          dry_run: vars.dryRun,
        },
      });
      if (result.error) throw result.error;
      return result.data as CommitEpisodesRead;
    },
    onSuccess: (data, vars) => {
      if (vars.dryRun) return;
      void queryClient.invalidateQueries({ queryKey: ["video-sent", videoId ?? null] });
      void queryClient.invalidateQueries({ queryKey: ["video-sequences", videoId ?? null] });
      void queryClient.invalidateQueries({ queryKey: ["sequences"] });
      options?.onSuccess?.(data);
    },
  });
}
