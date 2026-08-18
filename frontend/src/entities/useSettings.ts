import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { apiClient } from "../shared/api/client";

export function useSettings() {
  return useQuery({
    queryKey: ["settings"],
    queryFn: async () => {
      const result = await apiClient.GET("/settings", {});
      if (result.error) throw result.error;
      return result.data;
    },
  });
}

export function useUpdateSettings() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({
      maxTrackRangeFrames,
      maskPostprocessStrength,
      minMaskAreaFraction,
    }: {
      maxTrackRangeFrames: number;
      maskPostprocessStrength: number;
      minMaskAreaFraction: number;
    }) => {
      const result = await apiClient.PATCH("/settings", {
        body: {
          max_track_range_frames: maxTrackRangeFrames,
          mask_postprocess_strength: maskPostprocessStrength,
          min_mask_area_fraction: minMaskAreaFraction,
        },
      });
      if (result.error) throw result.error;
      return result.data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["settings"] });
    },
  });
}
