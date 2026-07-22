import { useQuery } from "@tanstack/react-query";

import { apiClient } from "../shared/api/client";

export function useLabels() {
  return useQuery({
    queryKey: ["labels"],
    queryFn: async () => {
      const result = await apiClient.GET("/taxonomy/labels", {});
      return result.data ?? [];
    },
  });
}
