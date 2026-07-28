import { useQuery } from "@tanstack/react-query";

import { apiClient } from "../shared/api/client";

export function useSuggestSequenceName(procedureId: number | undefined) {
  return useQuery({
    queryKey: ["suggest-sequence-name", procedureId],
    queryFn: async () => {
      const result = await apiClient.GET("/media/sequences/suggest-name", {
        params: { query: { procedure_id: procedureId as number } },
      });
      return result.data;
    },
    enabled: procedureId !== undefined,
  });
}
