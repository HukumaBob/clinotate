import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { apiClient } from "../shared/api/client";

export function useAnnotations(frameId: number) {
  return useQuery({
    queryKey: ["annotations", frameId],
    queryFn: async () => {
      const result = await apiClient.GET("/annotation/frames/{frame_id}/annotations", {
        params: { path: { frame_id: frameId } },
      });
      return result.data ?? [];
    },
    enabled: Number.isFinite(frameId),
  });
}

export function useCreateAnnotation(frameId: number) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (labelId: number) => {
      const result = await apiClient.POST("/annotation/frames/{frame_id}/annotations", {
        params: { path: { frame_id: frameId } },
        body: { label_id: labelId },
      });
      return result.data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["annotations", frameId] });
    },
  });
}

export function useDeleteAnnotation(frameId: number) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (annotationId: number) => {
      await apiClient.DELETE("/annotation/annotations/{annotation_id}", {
        params: { path: { annotation_id: annotationId } },
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["annotations", frameId] });
    },
  });
}

export function useDeleteJobAnnotations(frameId: number) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (jobId: number) => {
      const result = await apiClient.DELETE("/annotation/jobs/{job_id}/annotations", {
        params: { path: { job_id: jobId } },
      });
      return result.data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["annotations", frameId] });
    },
  });
}

export function useBulkClassifyFrames(sequenceId: number) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ frameIds, labelId }: { frameIds: number[]; labelId: number }) => {
      const result = await apiClient.POST("/annotation/frames/bulk-classify", {
        body: { frame_ids: frameIds, label_id: labelId },
      });
      return result.data;
    },
    onSuccess: (_data, variables) => {
      for (const frameId of variables.frameIds) {
        queryClient.invalidateQueries({ queryKey: ["annotations", frameId] });
      }
      queryClient.invalidateQueries({ queryKey: ["frames", sequenceId] });
    },
  });
}

export function useBulkClearClassification(sequenceId: number) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({
      frameIds,
      categoryId,
      evaluationTypeId,
    }: {
      frameIds: number[];
      categoryId: number;
      evaluationTypeId: number;
    }) => {
      const result = await apiClient.POST("/annotation/frames/bulk-clear-classification", {
        body: { frame_ids: frameIds, category_id: categoryId, evaluation_type_id: evaluationTypeId },
      });
      return result.data;
    },
    onSuccess: (_data, variables) => {
      for (const frameId of variables.frameIds) {
        queryClient.invalidateQueries({ queryKey: ["annotations", frameId] });
      }
      queryClient.invalidateQueries({ queryKey: ["frames", sequenceId] });
    },
  });
}

export function useBulkMarkNoFindings(sequenceId: number) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ frameIds }: { frameIds: number[] }) => {
      const result = await apiClient.POST("/annotation/frames/bulk-mark-no-findings", {
        body: { frame_ids: frameIds },
      });
      return result.data;
    },
    onSuccess: (_data, variables) => {
      for (const frameId of variables.frameIds) {
        queryClient.invalidateQueries({ queryKey: ["annotations", frameId] });
      }
      queryClient.invalidateQueries({ queryKey: ["frames", sequenceId] });
    },
  });
}

export function useBulkClearNoFindings(sequenceId: number) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ frameIds }: { frameIds: number[] }) => {
      const result = await apiClient.POST("/annotation/frames/bulk-clear-no-findings", {
        body: { frame_ids: frameIds },
      });
      return result.data;
    },
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({ queryKey: ["frames", sequenceId] });
    },
  });
}

function unwrap<T>(result: { data?: T; error?: unknown }): T {
  if (result.data === undefined) {
    const detail = (result.error as { detail?: unknown } | undefined)?.detail;
    throw new Error(typeof detail === "string" ? detail : "Request failed");
  }
  return result.data;
}

export type TagRegionsParams = {
  frameIds: number[];
  sourceLabelId: number;
  targetLabelId: number;
  skipManualFrames: boolean;
};

export type RemoveCopiesParams = {
  frameIds: number[];
  targetLabelId: number;
};

function tagBody(params: TagRegionsParams, dryRun: boolean) {
  return {
    frame_ids: params.frameIds,
    source_label_id: params.sourceLabelId,
    target_label_id: params.targetLabelId,
    skip_manual_frames: params.skipManualFrames,
    dry_run: dryRun,
  };
}

function removeBody(params: RemoveCopiesParams, dryRun: boolean) {
  return { frame_ids: params.frameIds, target_label_id: params.targetLabelId, dry_run: dryRun };
}

export function useRegionLabels(frameIds: number[], enabled: boolean) {
  const sortedIds = [...frameIds].sort((a, b) => a - b);
  return useQuery({
    queryKey: ["region-labels", sortedIds],
    enabled,
    queryFn: async () =>
      unwrap(
        await apiClient.POST("/annotation/frames/region-labels", { body: { frame_ids: sortedIds } }),
      ),
  });
}

export function useTagRegionsPreview(params: TagRegionsParams | null) {
  return useQuery({
    queryKey: ["tag-regions-preview", params],
    enabled: params !== null,
    queryFn: async () =>
      unwrap(
        await apiClient.POST("/annotation/frames/tag-regions", { body: tagBody(params!, true) }),
      ),
  });
}

export function useRemoveCopiesPreview(params: RemoveCopiesParams | null) {
  return useQuery({
    queryKey: ["remove-copies-preview", params],
    enabled: params !== null,
    queryFn: async () =>
      unwrap(
        await apiClient.POST("/annotation/frames/remove-region-copies", {
          body: removeBody(params!, true),
        }),
      ),
  });
}

function invalidateAfterRegionChange(
  queryClient: ReturnType<typeof useQueryClient>,
  frameIds: number[],
  sequenceId: number,
) {
  for (const frameId of frameIds) {
    queryClient.invalidateQueries({ queryKey: ["annotations", frameId] });
  }
  queryClient.invalidateQueries({ queryKey: ["frames", sequenceId] });
  queryClient.invalidateQueries({ queryKey: ["region-labels"] });
  queryClient.invalidateQueries({ queryKey: ["tag-regions-preview"] });
  queryClient.invalidateQueries({ queryKey: ["remove-copies-preview"] });
}

export function useTagRegions(sequenceId: number) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (params: TagRegionsParams) =>
      unwrap(
        await apiClient.POST("/annotation/frames/tag-regions", { body: tagBody(params, false) }),
      ),
    onSuccess: (_data, variables) =>
      invalidateAfterRegionChange(queryClient, variables.frameIds, sequenceId),
  });
}

export function useRemoveRegionCopies(sequenceId: number) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (params: RemoveCopiesParams) =>
      unwrap(
        await apiClient.POST("/annotation/frames/remove-region-copies", {
          body: removeBody(params, false),
        }),
      ),
    onSuccess: (_data, variables) =>
      invalidateAfterRegionChange(queryClient, variables.frameIds, sequenceId),
  });
}
