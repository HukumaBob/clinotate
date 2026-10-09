import { useCallback, useEffect, useRef, useState } from "react";

import { apiClient } from "../../shared/api/client";
import type { components } from "../../shared/api/generated/schema";

type TrainingRunRead = components["schemas"]["TrainingRunRead"];

const ERROR_TEXT = "Could not load runs.";

export function useRuns(datasetId: number | null) {
  const [runs, setRuns] = useState<TrainingRunRead[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Only the newest request may write state: a slower answer for a dataset the
  // user has already left must not replace the current list.
  const requestRef = useRef(0);

  const load = useCallback(async () => {
    const requestId = ++requestRef.current;
    if (datasetId === null) {
      setRuns([]);
      setError(null);
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const { data, error: failed } = await apiClient.GET("/training/runs", {
        params: { query: { dataset_id: datasetId, limit: 200 } },
      });
      if (requestId !== requestRef.current) return;
      if (failed || !data) {
        setRuns([]);
        setError(ERROR_TEXT);
      } else {
        setRuns(data);
      }
    } catch {
      if (requestId === requestRef.current) {
        setRuns([]);
        setError(ERROR_TEXT);
      }
    } finally {
      if (requestId === requestRef.current) setLoading(false);
    }
  }, [datasetId]);

  useEffect(() => {
    setRuns([]);
    void load();
    // Invalidate in-flight work on dataset change and on unmount.
    return () => {
      requestRef.current += 1;
    };
  }, [load]);

  return { runs, loading, error, refresh: load };
}
