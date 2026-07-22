import { useQuery } from "@tanstack/react-query";

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
