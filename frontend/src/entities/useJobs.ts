import { useQuery } from "@tanstack/react-query";

import { apiClient } from "../shared/api/client";

const TERMINAL_STATUSES = new Set(["succeeded", "failed"]);

export function useJob(jobId: number | null) {
  return useQuery({
    queryKey: ["jobs", jobId],
    queryFn: async () => {
      const result = await apiClient.GET("/jobs/{job_id}", {
        params: { path: { job_id: jobId as number } },
      });
      return result.data;
    },
    enabled: jobId !== null,
    refetchInterval: (query) => {
      const status = query.state.data?.status;
      if (status && TERMINAL_STATUSES.has(status)) {
        return false;
      }
      return 1500;
    },
  });
}
