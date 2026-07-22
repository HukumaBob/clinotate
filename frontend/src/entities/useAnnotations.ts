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
