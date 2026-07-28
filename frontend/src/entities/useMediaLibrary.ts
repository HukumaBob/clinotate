import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { apiClient } from "../shared/api/client";

export function useMediaLibrary() {
  return useQuery({
    queryKey: ["media-library"],
    queryFn: async () => {
      const result = await apiClient.GET("/media/library", {});
      return result.data ?? [];
    },
  });
}

export function useDeleteVideo() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (videoId: number) => {
      const result = await apiClient.DELETE("/media/videos/{video_id}", {
        params: { path: { video_id: videoId } },
      });
      if (result.error) throw result.error;
      return result.data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["media-library"] });
    },
  });
}

export function useDeleteSequence() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (sequenceId: number) => {
      const result = await apiClient.DELETE("/media/sequences/{sequence_id}", {
        params: { path: { sequence_id: sequenceId } },
      });
      if (result.error) throw result.error;
      return result.data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["media-library"] });
    },
  });
}
