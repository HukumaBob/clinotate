import { useQuery } from "@tanstack/react-query";

import { apiClient } from "../shared/api/client";
import type { components } from "../shared/api/generated/schema";

export type EvaluationRead = components["schemas"]["EvaluationRead"];

export function useEvaluation(runId: number | null, boundaryMs: number, enabled: boolean) {
  return useQuery({
    queryKey: ["evaluation", runId, boundaryMs],
    queryFn: async () => {
      const result = await apiClient.GET("/reference/runs/{run_id}/evaluation", {
        params: { path: { run_id: runId as number }, query: { boundary_ms: boundaryMs } },
      });
      if (result.error) throw result.error;
      return result.data as EvaluationRead;
    },
    enabled: enabled && runId !== null,
  });
}
