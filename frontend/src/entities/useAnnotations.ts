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
