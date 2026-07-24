import { useQuery } from "@tanstack/react-query";

import { apiClient } from "../shared/api/client";

export function useLabelTree() {
  return useQuery({
    queryKey: ["labels", "tree"],
    queryFn: async () => {
      const result = await apiClient.GET("/taxonomy/labels/tree", {});
      return result.data ?? [];
    },
  });
}
