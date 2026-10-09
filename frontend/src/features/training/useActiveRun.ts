import { useCallback, useEffect, useRef, useState } from "react";

import { apiClient } from "../../shared/api/client";
import type { components } from "../../shared/api/generated/schema";

type TrainingRunRead = components["schemas"]["TrainingRunRead"];

const POLL_INTERVAL_MS = 2000;
const TERMINAL = new Set(["succeeded", "failed", "stopped"]);

export function useActiveRun(onFinished: (run: TrainingRunRead) => void) {
  const [run, setRun] = useState<TrainingRunRead | null>(null);
  const discoverRef = useRef(0);
  const pollRef = useRef(0);
  const pollInFlightRef = useRef(false);
  const runRef = useRef<TrainingRunRead | null>(null);
  const onFinishedRef = useRef(onFinished);
  onFinishedRef.current = onFinished;
  const finishedIdRef = useRef<number | null>(null);

  const track = useCallback((next: TrainingRunRead | null) => {
    runRef.current = next;
    setRun(next);
  }, []);

  const finish = useCallback((finished: TrainingRunRead) => {
    if (finishedIdRef.current === finished.id) return;
    finishedIdRef.current = finished.id;
    onFinishedRef.current(finished);
  }, []);

  const refresh = useCallback(async () => {
    const requestId = ++discoverRef.current;
    try {
      const { data } = await apiClient.GET("/training/runs", { params: { query: { limit: 20 } } });
      if (requestId !== discoverRef.current) return;
      const list = data ?? [];
      const active = list.find((r) => r.status === "pending" || r.status === "running");
      const tracked = runRef.current;
      if (tracked && active?.id !== tracked.id) {
        // The tracked run finished since the last poll.
        finish(list.find((r) => r.id === tracked.id) ?? tracked);
      }
      track(active ?? null);
    } catch {
      // Keep the current state; the next refresh retries.
    }
  }, [finish, track]);

  useEffect(() => {
    void refresh();
    return () => {
      discoverRef.current += 1;
    };
  }, [refresh]);

  const runId = run?.id ?? null;
  const status = run?.status ?? null;

  useEffect(() => {
    if (runId === null || status === null || TERMINAL.has(status)) return;
    const interval = setInterval(async () => {
      if (pollInFlightRef.current) return;
      const requestId = ++pollRef.current;
      pollInFlightRef.current = true;
      try {
        const { data } = await apiClient.GET("/training/runs/{run_id}", {
          params: { path: { run_id: runId } },
        });
        if (requestId !== pollRef.current || !data) return;
        track(data);
        if (TERMINAL.has(data.status)) {
          clearInterval(interval);
          finish(data);
        }
      } catch {
        // Transient failure: the next tick retries.
      } finally {
        if (requestId === pollRef.current) pollInFlightRef.current = false;
      }
    }, POLL_INTERVAL_MS);
    return () => {
      clearInterval(interval);
      pollRef.current += 1;
      pollInFlightRef.current = false;
    };
  }, [runId, status, track, finish]);

  return { run, refresh };
}
