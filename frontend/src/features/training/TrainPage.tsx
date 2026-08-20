import { useCallback, useEffect, useRef, useState } from "react";

import { apiClient } from "../../shared/api/client";
import type { components } from "../../shared/api/generated/schema";
import { ModelVersionsTable } from "./ModelVersionsTable";
import { TrainConfigForm, type DatasetOption, type TrainConfigValues } from "./TrainConfigForm";
import { TrainRunPanel } from "./TrainRunPanel";

type TrainingRunRead = components["schemas"]["TrainingRunRead"];
type ModelVersionRead = components["schemas"]["ModelVersionRead"];

const POLL_INTERVAL_MS = 2000;
const TERMINAL_STATUSES = new Set(["succeeded", "failed", "stopped"]);

function isActive(run: TrainingRunRead | null): boolean {
  return run !== null && !TERMINAL_STATUSES.has(run.status);
}

export function TrainPage() {
  const [datasets, setDatasets] = useState<DatasetOption[]>([]);
  const [versions, setVersions] = useState<ModelVersionRead[]>([]);
  const [activeRun, setActiveRun] = useState<TrainingRunRead | null>(null);
  const [logText, setLogText] = useState("");
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [submitPending, setSubmitPending] = useState(false);
  const [stopPending, setStopPending] = useState(false);

  // Running offset into the active run's log, kept outside React state so
  // the poll tick can read the latest value without re-subscribing the
  // interval on every append. The log itself can reach megabytes over an
  // hour-long run, so each tick only fetches the tail past this offset.
  const logOffsetRef = useRef(0);
  // Id of the run the log offset/text currently belong to, so refreshRuns
  // can tell "switched to a different run" (reset) apart from "re-fetched
  // the same run" (must not reset, or the whole log gets appended again
  // on top of what is already in state).
  const activeRunIdRef = useRef<number | null>(null);

  const refreshDatasets = useCallback(async () => {
    const { data } = await apiClient.GET("/datasets");
    setDatasets(
      (data ?? []).map((dataset) => ({
        id: dataset.id,
        name: dataset.name,
        exported: Boolean((dataset as { exported?: boolean }).exported),
      })),
    );
  }, []);

  const refreshVersions = useCallback(async () => {
    const { data } = await apiClient.GET("/training/models");
    setVersions(data ?? []);
  }, []);

  const refreshRuns = useCallback(async () => {
    const { data } = await apiClient.GET("/training/runs");
    const list = data ?? [];
    const active = list.find((run) => run.status === "pending" || run.status === "running");
    const chosen = active ?? list[0] ?? null;
    setActiveRun(chosen);
    // A freshly chosen run starts its log tail from scratch; switching
    // between runs must not carry over a stale offset from a previous one.
    // But if this call re-resolves to the SAME run that is already being
    // polled (not just today's call paths, but any future one -- e.g. a
    // manual refresh while a run is active), resetting here would append
    // the whole multi-megabyte log a second time on top of what is
    // already in state. Only reset when the run id actually changes.
    if (chosen?.id !== activeRunIdRef.current) {
      activeRunIdRef.current = chosen?.id ?? null;
      logOffsetRef.current = 0;
      setLogText("");
    }
    return chosen;
  }, []);

  useEffect(() => {
    refreshDatasets();
    refreshRuns();
    refreshVersions();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!isActive(activeRun) || activeRun === null) {
      return;
    }
    const runId = activeRun.id;

    let cancelled = false;

    async function tick() {
      const [runResult, logResult] = await Promise.all([
        apiClient.GET("/training/runs/{run_id}", { params: { path: { run_id: runId } } }),
        apiClient.GET("/training/runs/{run_id}/log", {
          params: { path: { run_id: runId }, query: { offset: logOffsetRef.current } },
        }),
      ]);

      if (cancelled) {
        return;
      }

      if (logResult.data) {
        logOffsetRef.current = logResult.data.offset;
        setLogText((current) => current + logResult.data!.text);
      }

      if (runResult.data) {
        setActiveRun(runResult.data);

        if (TERMINAL_STATUSES.has(runResult.data.status)) {
          clearInterval(interval);
          // A finished run (succeeded or stopped) can produce a new model
          // version -- refresh the table so it shows up without a reload.
          refreshVersions();
        }
      }
    }

    const interval = setInterval(tick, POLL_INTERVAL_MS);

    return () => {
      cancelled = true;
      clearInterval(interval);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeRun?.id, activeRun?.status]);

  async function handleSubmit(values: TrainConfigValues) {
    setSubmitError(null);
    setSubmitPending(true);
    try {
      const { data, error } = await apiClient.POST("/training/runs", {
        body: {
          dataset_id: values.datasetId,
          base_model: values.baseModel,
          epochs: values.epochs,
          batch: values.batch,
          imgsz: values.imgsz,
          advanced: {},
        },
      });
      if (error) {
        const detail = (error as { detail?: string }).detail ?? "Failed to start training.";
        setSubmitError(detail);
        return;
      }
      if (data) {
        await refreshRuns();
      }
    } finally {
      setSubmitPending(false);
    }
  }

  async function handleStop() {
    if (!activeRun) {
      return;
    }
    setStopPending(true);
    try {
      const { data, error } = await apiClient.POST("/training/runs/{run_id}/stop", {
        params: { path: { run_id: activeRun.id } },
      });
      if (error) {
        const detail = (error as { detail?: string }).detail ?? "Failed to stop the run.";
        setSubmitError(detail);
        return;
      }
      if (data) {
        setActiveRun(data);
      }
    } finally {
      setStopPending(false);
    }
  }

  async function handleDownload(id: number) {
    const { data } = await apiClient.GET("/training/models/{version_id}/download", {
      params: { path: { version_id: id } },
    });
    if (data?.download_url) {
      window.open(data.download_url, "_blank", "noopener,noreferrer");
    }
  }

  async function handleDelete(id: number) {
    await apiClient.DELETE("/training/models/{version_id}", {
      params: { path: { version_id: id } },
    });
    await refreshVersions();
  }

  return (
    <div className="flex h-full flex-col overflow-hidden bg-gray-950 p-8 text-gray-100">
      <div className="mb-4 flex shrink-0 items-center justify-between">
        <h1 className="text-lg font-semibold">Train</h1>
      </div>

      <div role="tablist" aria-label="Training adapters" className="mb-4 flex shrink-0 gap-2 border-b border-gray-800">
        <button
          type="button"
          role="tab"
          aria-selected="true"
          className="border-b-2 border-blue-500 px-3 py-2 text-sm font-medium text-gray-100"
        >
          YOLO
        </button>
      </div>

      {submitError && (
        <div
          role="alert"
          className="mb-4 shrink-0 rounded border border-red-800 bg-red-950 px-3 py-2 text-sm text-red-300"
        >
          {submitError}
        </div>
      )}

      <div className="grid flex-1 grid-cols-3 gap-6 overflow-hidden">
        <div className="overflow-y-auto rounded border border-gray-800 bg-gray-900 p-4">
          <TrainConfigForm datasets={datasets} disabled={submitPending} onSubmit={handleSubmit} />
        </div>

        <div className="col-span-2 flex flex-col gap-6 overflow-hidden">
          <div className="min-h-0 flex-1">
            <TrainRunPanel
              run={activeRun}
              logText={logText}
              onStop={handleStop}
              stopPending={stopPending}
            />
          </div>

          <div className="max-h-64 shrink-0 overflow-y-auto rounded border border-gray-800 bg-gray-900 p-4">
            <ModelVersionsTable
              versions={versions}
              onDownload={handleDownload}
              onDelete={handleDelete}
            />
          </div>
        </div>
      </div>
    </div>
  );
}
