import { useEffect, useRef, useState } from "react";

import { apiClient } from "../../shared/api/client";
import type { components } from "../../shared/api/generated/schema";

type RunMetricsRead = components["schemas"]["RunMetricsRead"];

export function useCompareMetrics(runIds: number[]) {
  const [byId, setById] = useState<Record<number, RunMetricsRead | null>>({});
  const [settledKey, setSettledKey] = useState("");
  const [error, setError] = useState(false);
  const requestRef = useRef(0);
  const key = runIds.join(",");
  // Derived so it is already true on the first render and on a key change.
  const loading = key !== "" && settledKey !== key;

  useEffect(() => {
    const requestId = ++requestRef.current;
    const ids = key === "" ? [] : key.split(",").map(Number);
    setById({});
    setError(false);
    if (ids.length === 0) {
      return () => {
        requestRef.current += 1;
      };
    }
    let pending = ids.length;
    const settle = () => {
      pending -= 1;
      if (pending === 0 && requestId === requestRef.current) setSettledKey(key);
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
