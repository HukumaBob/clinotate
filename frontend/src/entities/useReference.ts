import { useMutation, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";

import { apiClient } from "../shared/api/client";
import type { components } from "../shared/api/generated/schema";

export type ReferenceRead = components["schemas"]["ReferenceRead"];
export type ReferenceInterval = components["schemas"]["ReferenceIntervalRead"];

export function useReference(videoId: number | null) {
  return useQuery({
    queryKey: ["reference", videoId],
    queryFn: async () => {
      const result = await apiClient.GET("/reference/videos/{video_id}", {
        params: { path: { video_id: videoId as number } },
      });
      if (result.error) throw result.error;
      return result.data as ReferenceRead;
    },
    enabled: videoId !== null,
  });
}

/** Cancels in-flight fetches (so a refetch cannot overwrite the optimistic
 * state), applies `edit` to the cached reference and returns the snapshot. */
async function optimistic(
  queryClient: QueryClient,
  videoId: number | null,
  edit: (reference: ReferenceRead) => ReferenceRead,
) {
  const key = ["reference", videoId];
  await queryClient.cancelQueries({ queryKey: key });
  const previous = queryClient.getQueryData<ReferenceRead>(key);
  if (previous) queryClient.setQueryData<ReferenceRead>(key, edit(previous));
  return { previous };
}

function rollback(
  queryClient: QueryClient,
  videoId: number | null,
  context: { previous?: ReferenceRead } | undefined,
) {
  if (context?.previous) queryClient.setQueryData(["reference", videoId], context.previous);
}

let tempId = 0;

export function useCreateInterval(videoId: number | null) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (vars: { labelId: number; startMs: number; endMs: number }) => {
      const result = await apiClient.POST("/reference/videos/{video_id}/intervals", {
        params: { path: { video_id: videoId as number } },
        body: { label_id: vars.labelId, start_ms: vars.startMs, end_ms: vars.endMs },
      });
      if (result.error) throw result.error;
      return result.data as ReferenceInterval;
    },
    onMutate: async (vars) => {
      const id = --tempId;
      const context = await optimistic(queryClient, videoId, (reference) => {
        const axis = reference.axes.find((a) => a.classes.some((c) => c.label_id === vars.labelId));
        const row: ReferenceInterval = {
          id,
          video_id: reference.video_id,
          category_id: axis?.category_id ?? 0,
          label_id: vars.labelId,
          taxonomy_version: 1,
          start_ms: vars.startMs,
          end_ms: vars.endMs,
          orphaned: false,
        };
        return { ...reference, intervals: [...reference.intervals, row] };
      });
      return { ...context, tempId: id };
    },
    onSuccess: (created, _vars, context) => {
      queryClient.setQueryData<ReferenceRead>(["reference", videoId], (reference) =>
        reference
          ? {
              ...reference,
              intervals: reference.intervals.map((i) => (i.id === context?.tempId ? created : i)),
            }
          : reference,
      );
    },
    onError: (_error, _vars, context) => rollback(queryClient, videoId, context),
    onSettled: () => void queryClient.invalidateQueries({ queryKey: ["reference", videoId] }),
  });
}

export function useUpdateInterval(videoId: number | null) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (vars: {
      intervalId: number;
      labelId?: number;
      startMs?: number;
      endMs?: number;
    }) => {
      const body: { label_id?: number; start_ms?: number; end_ms?: number } = {};
      if (vars.labelId !== undefined) body.label_id = vars.labelId;
      if (vars.startMs !== undefined) body.start_ms = vars.startMs;
      if (vars.endMs !== undefined) body.end_ms = vars.endMs;
      const result = await apiClient.PATCH("/reference/videos/{video_id}/intervals/{interval_id}", {
        params: { path: { video_id: videoId as number, interval_id: vars.intervalId } },
        body,
      });
      if (result.error) throw result.error;
      return result.data as ReferenceInterval;
    },
    onMutate: (vars) =>
      optimistic(queryClient, videoId, (reference) => ({
        ...reference,
        intervals: reference.intervals.map((i) =>
          i.id === vars.intervalId
            ? {
                ...i,
                label_id: vars.labelId ?? i.label_id,
                start_ms: vars.startMs ?? i.start_ms,
                end_ms: vars.endMs ?? i.end_ms,
              }
            : i,
        ),
      })),
    onError: (_error, _vars, context) => rollback(queryClient, videoId, context),
    onSettled: () => void queryClient.invalidateQueries({ queryKey: ["reference", videoId] }),
  });
}

export function useDeleteInterval(videoId: number | null) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (intervalId: number) => {
      const result = await apiClient.DELETE("/reference/videos/{video_id}/intervals/{interval_id}", {
        params: { path: { video_id: videoId as number, interval_id: intervalId } },
      });
      if (result.error) throw result.error;
    },
    onMutate: (intervalId) =>
      optimistic(queryClient, videoId, (reference) => ({
        ...reference,
        intervals: reference.intervals.filter((i) => i.id !== intervalId),
      })),
    onError: (_error, _vars, context) => rollback(queryClient, videoId, context),
    onSettled: () => void queryClient.invalidateQueries({ queryKey: ["reference", videoId] }),
  });
}

export function useRestoreClean(videoId: number | null) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      const result = await apiClient.POST("/reference/videos/{video_id}/restore-clean", {
        params: { path: { video_id: videoId as number } },
      });
      if (result.error) throw result.error;
    },
    onSettled: () => void queryClient.invalidateQueries({ queryKey: ["reference", videoId] }),
  });
}

export function useReferenceExposure(datasetId: number | null) {
  return useQuery({
    queryKey: ["reference-exposure", datasetId],
    queryFn: async () => {
      const result = await apiClient.GET("/reference/datasets/{dataset_id}/exposure", {
        params: { path: { dataset_id: datasetId as number } },
      });
      if (result.error) throw result.error;
      return result.data ?? [];
    },
    enabled: datasetId !== null,
  });
}
