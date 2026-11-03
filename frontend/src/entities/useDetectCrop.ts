import { useMutation } from "@tanstack/react-query";

import { apiClient } from "../shared/api/client";

/** Proposes a working area for a video; `crop` is null when nothing reliable was found. */
export function useDetectCrop() {
  return useMutation({
    mutationFn: async (videoId: number) => {
      const result = await apiClient.POST("/inference/videos/{video_id}/detect-crop", {
        params: { path: { video_id: videoId } },
      });
      if (result.error) throw result.error;
      return result.data;
    },
  });
}
