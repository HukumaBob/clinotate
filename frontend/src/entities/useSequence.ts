import { useQuery } from "@tanstack/react-query";

import { apiClient } from "../shared/api/client";

export function useSequence(sequenceId: number) {
  return useQuery({
    queryKey: ["sequence", sequenceId],
    queryFn: async () => {
      const result = await apiClient.GET("/media/sequences/{sequence_id}", {
        params: { path: { sequence_id: sequenceId } },
      });
      return result.data;
    },
    enabled: Number.isFinite(sequenceId),
  });
}
