import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { apiClient } from "../shared/api/client";
import type { components } from "../shared/api/generated/schema";

export type QcFlag = components["schemas"]["QcFlagRead"];
export type QcFlagKind = QcFlag["kind"];

export function useQcFlags(runId: number | null) {
  return useQuery({
    queryKey: ["qc-flags", runId],
    queryFn: async () => {
      const result = await apiClient.GET("/inference/runs/{run_id}/flags", {
        params: { path: { run_id: runId as number } },
      });
      if (result.error) throw result.error;
      return result.data ?? [];
    },
    enabled: runId !== null,
  });
}

/** Flags change the run's pending/sent counters, so the run is refreshed too. */
function useRefreshAfterFlagChange(runId: number | null) {
  const queryClient = useQueryClient();
  return () => {
    void queryClient.invalidateQueries({ queryKey: ["qc-flags", runId] });
    void queryClient.invalidateQueries({ queryKey: ["inference-run", runId] });
    void queryClient.invalidateQueries({ queryKey: ["inference-runs"] });
  };
}

export function usePutQcFlag(runId: number | null) {
  const refresh = useRefreshAfterFlagChange(runId);
  return useMutation({
    mutationFn: async (body: {
      frame_index: number;
      timestamp_ms: number;
      kind: QcFlagKind;
      note?: string | null;
    }) => {
      const result = await apiClient.PUT("/inference/runs/{run_id}/flags", {
        params: { path: { run_id: runId as number } },
        body,
      });
      if (result.error) throw result.error;
      return result.data;
    },
    onSuccess: refresh,
  });
}

export function useDeleteQcFlag(runId: number | null) {
  const refresh = useRefreshAfterFlagChange(runId);
  return useMutation({
    mutationFn: async (flagId: number) => {
      const result = await apiClient.DELETE("/inference/runs/{run_id}/flags/{flag_id}", {
        params: { path: { run_id: runId as number, flag_id: flagId } },
      });
      if (result.error) throw result.error;
    },
    onSuccess: refresh,
  });
}

export function useCommitQcFlags(runId: number | null, videoId: number | null) {
  const queryClient = useQueryClient();
  const refresh = useRefreshAfterFlagChange(runId);
  return useMutation({
    mutationFn: async (body: { name?: string | null }) => {
      const result = await apiClient.POST("/inference/runs/{run_id}/commit", {
        params: { path: { run_id: runId as number } },
        body,
      });
      if (result.error) throw result.error;
      return result.data;
    },
    onSuccess: () => {
      refresh();
      void queryClient.invalidateQueries({ queryKey: ["video-sent", videoId] });
      void queryClient.invalidateQueries({ queryKey: ["video-sequences", videoId] });
    },
    // A 409 ("no pending flags", sent from another tab) means the list is stale.
    onError: refresh,
  });
}

export function useVideoSent(videoId: number | null) {
  return useQuery({
    queryKey: ["video-sent", videoId],
    queryFn: async () => {
      const result = await apiClient.GET("/inference/videos/{video_id}/sent", {
        params: { path: { video_id: videoId as number } },
      });
      if (result.error) throw result.error;
      return result.data;
    },
    enabled: videoId !== null,
  });
}
