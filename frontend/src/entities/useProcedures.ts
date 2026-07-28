import { useQuery } from "@tanstack/react-query";

import { apiClient } from "../shared/api/client";

export function useProcedures() {
  return useQuery({
    queryKey: ["procedures"],
    queryFn: async () => {
      const result = await apiClient.GET("/taxonomy/procedures", {});
      return result.data ?? [];
    },
  });
}
