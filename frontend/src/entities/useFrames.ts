import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { apiClient } from "../shared/api/client";

export function useFrames(sequenceId: number) {
  return useQuery({
    queryKey: ["frames", sequenceId],
    queryFn: async () => {
      const result = await apiClient.GET("/media/sequences/{sequence_id}/frames", {
        params: { path: { sequence_id: sequenceId } },
      });
      return result.data ?? [];
    },
    enabled: Number.isFinite(sequenceId),
  });
}

export function useFrame(frameId: number) {
  return useQuery({
    queryKey: ["frame", frameId],
    queryFn: async () => {
      const result = await apiClient.GET("/media/frames/{frame_id}", {
        params: { path: { frame_id: frameId } },
      });
      return result.data;
    },
    enabled: Number.isFinite(frameId),
  });
}

export function useDeleteFrames(sequenceId: number) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (frameIds: number[]) => {
      const result = await apiClient.DELETE("/media/sequences/{sequence_id}/frames", {
        params: { path: { sequence_id: sequenceId } },
        body: { frame_ids: frameIds },
      });
      return result.data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["frames", sequenceId] });
    },
  });
}
