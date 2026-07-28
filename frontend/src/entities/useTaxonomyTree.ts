import { useQuery } from "@tanstack/react-query";

import { apiClient } from "../shared/api/client";

export function useTaxonomyTree(procedureId: number | null) {
  return useQuery({
    queryKey: ["taxonomy", "tree", procedureId],
    queryFn: async () => {
      const result = await apiClient.GET("/taxonomy/tree", {
        params: { query: { procedure_id: procedureId as number } },
      });
      return result.data ?? [];
    },
    enabled: procedureId !== null,
  });
}
