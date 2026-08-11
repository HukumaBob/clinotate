import { useMutation, useQueryClient } from "@tanstack/react-query";

import { apiClient } from "../shared/api/client";

export function useReapplyMaskPostprocess(frameId: number) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ annotationId, strength }: { annotationId: number; strength: number }) => {
      const result = await apiClient.PATCH("/annotation/annotations/{annotation_id}/mask-postprocess", {
        params: { path: { annotation_id: annotationId } },
        body: { strength },
      });
      if (result.error) throw result.error;
      return result.data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["annotations", frameId] });
    },
  });
}
