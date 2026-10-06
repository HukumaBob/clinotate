import { useQuery } from "@tanstack/react-query";

import { apiClient } from "../shared/api/client";

export function useModelVersions() {
  return useQuery({
    queryKey: ["model-versions"],
    queryFn: async () => {
      const result = await apiClient.GET("/training/models", {});
      return result.data ?? [];
    },
  });
}
