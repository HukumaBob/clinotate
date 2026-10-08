import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { apiClient } from "../shared/api/client";
import type { components } from "../shared/api/generated/schema";
import type { PredictionsDocument } from "../features/qc/predictions";

export type InferenceRun = components["schemas"]["InferenceRunRead"];

const POLL_INTERVAL_MS = 2000;

function isActive(run: InferenceRun): boolean {
  return run.status === "pending" || run.status === "running";
}

export function useInferenceRuns() {
  return useQuery({
    queryKey: ["inference-runs"],
    queryFn: async () => {
      const result = await apiClient.GET("/inference/runs", {});
      return result.data ?? [];
    },
    // Poll only while something is still running; an idle screen stays quiet.
    refetchInterval: (query) => ((query.state.data ?? []).some(isActive) ? POLL_INTERVAL_MS : false),
  });
}

export function useInferenceRun(runId: number | null) {
  return useQuery({
    queryKey: ["inference-run", runId],
    queryFn: async () => {
      const result = await apiClient.GET("/inference/runs/{run_id}", {
        params: { path: { run_id: runId as number } },
      });
      if (result.error) throw result.error;
      return result.data;
    },
    enabled: runId !== null,
    refetchInterval: (query) =>
      query.state.data && isActive(query.state.data) ? POLL_INTERVAL_MS : false,
  });
}

export function useCreateInferenceRun() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (body: {
      video_id: number;
      model_version_id: number;
      frame_stride: number;
      perturbation?: { kind: "gaussian_noise" | "blur" | "brightness" | "jpeg"; strength: number } | null;
    }) => {
      const result = await apiClient.POST("/inference/runs", { body });
      if (result.error) throw result.error;
      return result.data;
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["inference-runs"] }),
  });
}

export function useDeleteInferenceRun() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ runId, force = false }: { runId: number; force?: boolean }) => {
      const result = await apiClient.DELETE("/inference/runs/{run_id}", {
        params: { path: { run_id: runId }, ...(force ? { query: { force: true } } : {}) },
      });
      if (result.error) throw result.error;
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["inference-runs"] }),
  });
}

/** Downloads the predictions document once and keeps it in the cache. It
 * can be tens of megabytes for a long video, so it is never refetched on
 * focus. The presigned URL points at object storage, not the API, which
 * is why this is a plain fetch and not apiClient. */
export function usePredictions(runId: number | null, enabled: boolean) {
  return useQuery({
    queryKey: ["inference-predictions", runId],
    queryFn: async () => {
      const link = await apiClient.GET("/inference/runs/{run_id}/predictions", {
        params: { path: { run_id: runId as number } },
      });
      if (link.error || !link.data) throw link.error ?? new Error("No predictions link");
      const response = await fetch(link.data.download_url);
      if (!response.ok) throw new Error(`Could not download predictions (${response.status})`);
      return (await response.json()) as PredictionsDocument;
    },
    enabled: runId !== null && enabled,
    staleTime: Infinity,
    refetchOnWindowFocus: false,
  });
}
