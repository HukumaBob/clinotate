import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { apiClient } from "../shared/api/client";

export function useSequencesForVideo(videoId: number) {
  return useQuery({
    queryKey: ["sequences", "video", videoId],
    queryFn: async () => {
      const result = await apiClient.GET("/media/videos/{video_id}/sequences", {
        params: { path: { video_id: videoId } },
      });
      return result.data ?? [];
    },
    enabled: Number.isFinite(videoId),
  });
}

export function useCreateStandaloneSequence() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (procedureId: number) => {
      const result = await apiClient.POST("/media/sequences", {
        body: { procedure_id: procedureId, start_time: 0, duration: 0 },
      });
      return result.data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["sequences"] });
    },
  });
}
