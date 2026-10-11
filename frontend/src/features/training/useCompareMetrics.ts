import { useEffect, useRef, useState } from "react";

import { apiClient } from "../../shared/api/client";
import type { components } from "../../shared/api/generated/schema";

type RunMetricsRead = components["schemas"]["RunMetricsRead"];

export function useCompareMetrics(runIds: number[]) {
  const [byId, setById] = useState<Record<number, RunMetricsRead | null>>({});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);
  const requestRef = useRef(0);
  const key = runIds.join(",");

  useEffect(() => {
    const requestId = ++requestRef.current;
    const ids = key === "" ? [] : key.split(",").map(Number);
    setById({});
    setError(false);
    if (ids.length === 0) {
      setLoading(false);
      return () => {
        requestRef.current += 1;
      };
    }
    setLoading(true);
    let pending = ids.length;
    const settle = () => {
      pending -= 1;
      if (pending === 0 && requestId === requestRef.current) setLoading(false);
    };
    for (const id of ids) {
      (async () => {
        let body: RunMetricsRead | null = null;
        try {
          const res = await apiClient.GET("/training/runs/{run_id}/metrics", {
            params: { path: { run_id: id } },
          });
          body = res.error || !res.data ? null : res.data;
        } catch {
          body = null;
        }
        if (requestId !== requestRef.current) return;
        if (body === null) setError(true);
        setById((prev) => ({ ...prev, [id]: body }));
        settle();
      })();
    }
    return () => {
      requestRef.current += 1;
    };
  }, [key]);

  return { byId, loading, error };
}
