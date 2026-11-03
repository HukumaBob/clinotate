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

const TEMP_ID_ERROR = "Interval is still being saved";

function mutationKey(videoId: number | null) {
  return ["reference-mutation", videoId];
}

/** Cancels in-flight fetches (so a refetch cannot overwrite optimistic state)
 * and applies `edit` to the cached reference, if there is one. */
async function applyOptimistic(
  queryClient: QueryClient,
  videoId: number | null,
  edit: (reference: ReferenceRead) => ReferenceRead,
) {
  const key = ["reference", videoId];
  await queryClient.cancelQueries({ queryKey: key });
  queryClient.setQueryData<ReferenceRead>(key, (reference) =>
    reference ? edit(reference) : reference,
  );
}

/** Per-item rollback: only the rows one mutation touched are reverted, never
 * the whole document, so newer in-flight optimistic edits survive. */
function patchCache(
  queryClient: QueryClient,
  videoId: number | null,
  edit: (reference: ReferenceRead) => ReferenceRead,
) {
  queryClient.setQueryData<ReferenceRead>(["reference", videoId], (reference) =>
    reference ? edit(reference) : reference,
  );
}

/** Refetch only when the last in-flight reference mutation of this video
 * settles (the settling one still counts itself), so an early settle cannot
 * overwrite a later optimistic state with stale server data. */
function settle(queryClient: QueryClient, videoId: number | null) {
  if (queryClient.isMutating({ mutationKey: mutationKey(videoId) }) <= 1) {
    void queryClient.invalidateQueries({ queryKey: ["reference", videoId] });
    void queryClient.invalidateQueries({ queryKey: ["evaluation"] });
  }
}

let tempId = 0;

export function useCreateInterval(videoId: number | null) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationKey: mutationKey(videoId),
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
      await applyOptimistic(queryClient, videoId, (reference) => {
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
      return { tempId: id };
    },
    onSuccess: (created, _vars, context) => {
      patchCache(queryClient, videoId, (reference) => ({
        ...reference,
        intervals: reference.intervals.map((i) => (i.id === context?.tempId ? created : i)),
      }));
    },
    onError: (_error, _vars, context) => {
      if (!context) return;
      patchCache(queryClient, videoId, (reference) => ({
        ...reference,
        intervals: reference.intervals.filter((i) => i.id !== context.tempId),
      }));
    },
    onSettled: () => settle(queryClient, videoId),
  });
}

// The editor must wait for the server id of a new interval (the create
// mutation's success) before issuing update/delete for it: a temporary
// (negative) id must never reach the server.
export function useUpdateInterval(videoId: number | null) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationKey: mutationKey(videoId),
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
    onMutate: async (vars) => {
      if (vars.intervalId < 0) throw new Error(TEMP_ID_ERROR);
      const previous = queryClient
        .getQueryData<ReferenceRead>(["reference", videoId])
        ?.intervals.find((i) => i.id === vars.intervalId);
      await applyOptimistic(queryClient, videoId, (reference) => ({
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
      }));
      return { previous };
    },
    onError: (_error, vars, context) => {
      const previous = context?.previous;
      if (!previous) return;
      patchCache(queryClient, videoId, (reference) => ({
        ...reference,
        intervals: reference.intervals.map((i) => (i.id === vars.intervalId ? previous : i)),
      }));
    },
    onSettled: (_data, error) => {
      if (error instanceof Error && error.message === TEMP_ID_ERROR) return;
      settle(queryClient, videoId);
    },
  });
}

/** Re-inserts a row, keeping the order by start within its category. */
function insertSorted(intervals: ReferenceInterval[], row: ReferenceInterval) {
  const sameCategory = intervals
    .map((i, index) => ({ i, index }))
    .filter(({ i }) => i.category_id === row.category_id);
  const next = sameCategory.find(({ i }) => i.start_ms > row.start_ms);
  const at = next
    ? next.index
    : sameCategory.length > 0
      ? sameCategory[sameCategory.length - 1].index + 1
      : intervals.length;
  return [...intervals.slice(0, at), row, ...intervals.slice(at)];
}

export function useDeleteInterval(videoId: number | null) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationKey: mutationKey(videoId),
    mutationFn: async (intervalId: number) => {
      const result = await apiClient.DELETE("/reference/videos/{video_id}/intervals/{interval_id}", {
        params: { path: { video_id: videoId as number, interval_id: intervalId } },
      });
      if (result.error) throw result.error;
    },
    onMutate: async (intervalId) => {
      if (intervalId < 0) throw new Error(TEMP_ID_ERROR);
      const removed = queryClient
        .getQueryData<ReferenceRead>(["reference", videoId])
        ?.intervals.find((i) => i.id === intervalId);
      await applyOptimistic(queryClient, videoId, (reference) => ({
        ...reference,
        intervals: reference.intervals.filter((i) => i.id !== intervalId),
      }));
      return { removed };
    },
    onError: (_error, _intervalId, context) => {
      const removed = context?.removed;
      if (!removed) return;
      patchCache(queryClient, videoId, (reference) =>
        reference.intervals.some((i) => i.id === removed.id)
          ? reference
          : { ...reference, intervals: insertSorted(reference.intervals, removed) },
      );
    },
    onSettled: (_data, error) => {
      if (error instanceof Error && error.message === TEMP_ID_ERROR) return;
      settle(queryClient, videoId);
    },
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
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: ["reference", videoId] });
      void queryClient.invalidateQueries({ queryKey: ["evaluation"] });
    },
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
