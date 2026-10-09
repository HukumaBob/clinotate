import { useCallback, useEffect, useRef, useState } from "react";

import { apiClient } from "../../shared/api/client";

const POLL_INTERVAL_MS = 2000;

export function useRunLog(runId: number | null, active: boolean) {
  const [text, setText] = useState("");
  const [error, setError] = useState(false);
  const offsetRef = useRef(0);
  const requestRef = useRef(0);

  // Fetches from `offset`; `replace` swaps the text instead of appending.
  const fetchFrom = useCallback(async (id: number, offset: number, replace: boolean) => {
    const requestId = ++requestRef.current;
    try {
      const { data, error: failed } = await apiClient.GET("/training/runs/{run_id}/log", {
        params: { path: { run_id: id }, query: { offset } },
      });
      if (requestId !== requestRef.current) return;
      if (failed || !data) {
        setError(true);
        return;
      }
      setError(false);
      if (!replace && data.offset < offsetRef.current) {
        // The server's log shrank (reset): start over from the beginning.
        offsetRef.current = 0;
        await fetchFrom(id, 0, true);
        return;
      }
      offsetRef.current = data.offset;
      setText((current) => (replace ? data.text : current + data.text));
    } catch {
      if (requestId === requestRef.current) setError(true);
    }
  }, []);

  useEffect(() => {
    offsetRef.current = 0;
    setText("");
    setError(false);
    if (runId === null) return;
    void fetchFrom(runId, 0, true);
    return () => {
      requestRef.current += 1;
    };
  }, [runId, fetchFrom]);

  useEffect(() => {
    if (runId === null || !active) return;
    const interval = setInterval(() => {
      void fetchFrom(runId, offsetRef.current, false);
    }, POLL_INTERVAL_MS);
    return () => {
      clearInterval(interval);
    };
  }, [runId, active, fetchFrom]);

  return { text, error };
}
