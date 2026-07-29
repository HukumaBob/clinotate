import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { apiClient } from "../shared/api/client";

export function useVideo(videoId: number | null) {
  return useQuery({
    queryKey: ["video", videoId],
    queryFn: async () => {
      const result = await apiClient.GET("/media/videos/{video_id}", {
        params: { path: { video_id: videoId as number } },
      });
      if (result.error) throw result.error;
      return result.data;
    },
    enabled: videoId !== null,
  });
}

export function useTranscodeVideo() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (videoId: number) => {
      const result = await apiClient.POST("/media/videos/{video_id}/transcode", {
        params: { path: { video_id: videoId } },
      });
      if (result.error) throw result.error;
      return result.data;
    },
    onSuccess: (_data, videoId) => {
      queryClient.invalidateQueries({ queryKey: ["video", videoId] });
    },
  });
}
