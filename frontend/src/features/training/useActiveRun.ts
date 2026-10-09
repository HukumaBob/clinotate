import { useCallback, useEffect, useRef, useState } from "react";

import { apiClient } from "../../shared/api/client";
import type { components } from "../../shared/api/generated/schema";

type TrainingRunRead = components["schemas"]["TrainingRunRead"];

const POLL_INTERVAL_MS = 2000;
const TERMINAL = new Set(["succeeded", "failed", "stopped"]);

export function useActiveRun(onFinished: (run: TrainingRunRead) => void) {
  const [run, setRun] = useState<TrainingRunRead | null>(null);
  const requestRef = useRef(0);
  const onFinishedRef = useRef(onFinished);
  onFinishedRef.current = onFinished;
  const finishedIdRef = useRef<number | null>(null);

  const refresh = useCallback(async () => {
    const requestId = ++requestRef.current;
    try {
      const { data } = await apiClient.GET("/training/runs", { params: { query: { limit: 20 } } });
      if (requestId !== requestRef.current) return;
      const active = (data ?? []).find((r) => r.status === "pending" || r.status === "running");
      setRun(active ?? null);
    } catch {
      // Keep the current state; the next refresh retries.
    }
  }, []);

  useEffect(() => {
    void refresh();
    return () => {
      requestRef.current += 1;
    };
  }, [refresh]);

  const runId = run?.id ?? null;
  const status = run?.status ?? null;

  useEffect(() => {
    if (runId === null || status === null || TERMINAL.has(status)) return;
    const interval = setInterval(async () => {
      const requestId = ++requestRef.current;
      try {
        const { data } = await apiClient.GET("/training/runs/{run_id}", {
          params: { path: { run_id: runId } },
        });
        if (requestId !== requestRef.current || !data) return;
        setRun(data);
        if (TERMINAL.has(data.status)) {
          clearInterval(interval);
          if (finishedIdRef.current !== data.id) {
            finishedIdRef.current = data.id;
            onFinishedRef.current(data);
          }
        }
      } catch {
        // Transient failure: the next tick retries.
      }
    }, POLL_INTERVAL_MS);
    return () => {
      clearInterval(interval);
      requestRef.current += 1;
    };
  }, [runId, status]);

  return { run, refresh };
}
