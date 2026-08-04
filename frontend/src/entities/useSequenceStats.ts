import { useQuery } from "@tanstack/react-query";

import { apiClient } from "../shared/api/client";

export function useSequenceStats(sequenceId: number) {
  return useQuery({
    queryKey: ["sequence-stats", sequenceId],
    queryFn: async () => {
      const result = await apiClient.GET("/media/sequences/{sequence_id}/stats", {
        params: { path: { sequence_id: sequenceId } },
      });
      return result.data;
    },
  });
}
