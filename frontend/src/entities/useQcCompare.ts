import { useQuery } from "@tanstack/react-query";

import { apiClient } from "../shared/api/client";
import type { components } from "../shared/api/generated/schema";

export type QcCompare = components["schemas"]["QcCompareRead"];

export function useQcCompare(runA: number | null, runB: number | null, confA: number, confB: number) {
  return useQuery({
    queryKey: ["qc-compare", runA, runB, confA, confB],
    queryFn: async () => {
      const result = await apiClient.GET("/inference/compare", {
        params: { query: { run_a: runA as number, run_b: runB as number, conf_a: confA, conf_b: confB } },
      });
      if (result.error) throw result.error;
      return result.data;
    },
    enabled: runA !== null && runB !== null,
    // Two predictions documents are downloaded server-side per call.
    staleTime: 30_000,
  });
}
