import { useEffect, useRef, useState } from "react";

import { apiClient } from "../../shared/api/client";
import type { components } from "../../shared/api/generated/schema";

type RunMetricsRead = components["schemas"]["RunMetricsRead"];

export function useRunMetrics(runId: number | null, active: boolean, epoch: number) {
  const [data, setData] = useState<RunMetricsRead | null>(null);
  const [error, setError] = useState(false);
  const [loading, setLoading] = useState(false);
  const requestRef = useRef(0);

  useEffect(() => {
    setData(null);
    setError(false);
  }, [runId]);

  // epoch only matters while the run is active; -1 keeps the effect still otherwise.
  const epochKey = active ? epoch : -1;

  useEffect(() => {
    const requestId = ++requestRef.current;
    if (runId === null) {
      setLoading(false);
      return;
    }
    setLoading(true);
    (async () => {
      try {
        const { data: body, error: failed } = await apiClient.GET("/training/runs/{run_id}/metrics", {
          params: { path: { run_id: runId } },
        });
        if (requestId !== requestRef.current) return;
        if (failed || !body) {
          setError(true);
        } else {
          setError(false);
          setData(body);
        }
      } catch {
        if (requestId === requestRef.current) setError(true);
      } finally {
        if (requestId === requestRef.current) setLoading(false);
      }
    })();
    return () => {
      requestRef.current += 1;
    };
  }, [runId, active, epochKey]);

  return { data, error, loading };
}
