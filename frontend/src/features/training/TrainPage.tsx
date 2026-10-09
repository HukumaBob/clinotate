import { useCallback, useEffect, useRef, useState } from "react";

import { apiClient } from "../../shared/api/client";
import type { components } from "../../shared/api/generated/schema";
import { ActiveRunStrip } from "./ActiveRunStrip";
import { DatasetRail } from "./DatasetRail";
import { RunDetail } from "./RunDetail";
import {
  baseKeyFromRun,
  headlineScore,
  isActiveRun,
  valuesFromConfig,
} from "./runLogic";
import { RunsTable } from "./RunsTable";
import type { SettingsSchema, SettingsValues } from "./settingsLogic";
import {
  TrainConfigForm,
  type DatasetOption,
  type TrainConfigValues,
} from "./TrainConfigForm";
import { useActiveRun } from "./useActiveRun";
import { useRunMetrics } from "./useRunMetrics";
import { useRuns } from "./useRuns";
import { useTrainUrl, type TrainTab } from "./useTrainUrl";

type TrainingRunRead = components["schemas"]["TrainingRunRead"];
type BaseModelOption = components["schemas"]["BaseModelOption"];

interface Prefill {
  nonce: number;
  baseKey: string;
  values: SettingsValues;
}

const TAB_LABELS: Array<{ id: TrainTab; label: string }> = [
  { id: "runs", label: "Runs" },
  { id: "new", label: "New run" },
];

export function TrainPage() {
  const [url, update] = useTrainUrl();
  const [datasets, setDatasets] = useState<DatasetOption[]>([]);
  const [baseModels, setBaseModels] = useState<BaseModelOption[]>([]);
  const [baseModelsError, setBaseModelsError] = useState<string | null>(null);
  const [settingsSchema, setSettingsSchema] = useState<SettingsSchema | null>(
    null,
  );
  const [settingsSchemaError, setSettingsSchemaError] = useState<string | null>(
    null,
  );
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [submitPending, setSubmitPending] = useState(false);
  const [stopPending, setStopPending] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [prefill, setPrefill] = useState<Prefill | null>(null);
  const [clearSignal, setClearSignal] = useState(0);
  const nonceRef = useRef(0);

  const selectedDatasetId = url.dataset;
  const selectedDataset =
    datasets.find((dataset) => dataset.id === selectedDatasetId) ?? null;

  const {
    runs,
    loading,
    error: runsError,
    refresh: refreshRuns,
  } = useRuns(selectedDatasetId);

  const refreshDatasets = useCallback(async () => {
    const { data } = await apiClient.GET("/datasets");
    setDatasets(
      (data ?? []).map((dataset) => ({
        id: dataset.id,
        name: dataset.name,
        exported: Boolean((dataset as { exported?: boolean }).exported),
        taskType: dataset.task_type,
        itemCount: dataset.item_count,
        splitCounts: dataset.split_counts,
        classes: (
          (
            dataset.balance_metrics as {
              classes?: { name: string; instances: number }[];
            }
          ).classes ?? []
        ).map(({ name, instances }) => ({ name, instances })),
      })),
    );
  }, []);

  // Only the newest base-models request may write state: a slower response for
  // an earlier dataset would otherwise leave a wrong-task-type catalog selectable.
  const baseModelsRequestRef = useRef(0);
  const baseModelsDatasetRef = useRef<number | null>(null);

  const loadBaseModels = useCallback(
    async (datasetId: number, reset = true) => {
      const requestId = ++baseModelsRequestRef.current;
      baseModelsDatasetRef.current = datasetId;
      if (reset) {
        setBaseModels([]);
      }
      setBaseModelsError(null);
      try {
        const { data, error } = await apiClient.GET("/training/base-models", {
          params: { query: { dataset_id: datasetId } },
        });
        if (requestId !== baseModelsRequestRef.current) {
          return;
        }
        if (error || !data) {
          setBaseModelsError("Could not load base models.");
          return;
        }
        setBaseModels(data);
      } catch {
        if (requestId === baseModelsRequestRef.current) {
          setBaseModelsError("Could not load base models.");
        }
      }
    },
    [],
  );

  // Same newest-request-wins rule as the catalog.
  const settingsSchemaRequestRef = useRef(0);

  const loadSettingsSchema = useCallback(async (datasetId: number) => {
    const requestId = ++settingsSchemaRequestRef.current;
    setSettingsSchema(null);
    setSettingsSchemaError(null);
    try {
      const { data, error } = await apiClient.GET("/training/settings-schema", {
        params: { query: { dataset_id: datasetId } },
      });
      if (requestId !== settingsSchemaRequestRef.current) {
        return;
      }
      if (error || !data) {
        setSettingsSchemaError("Could not load training settings.");
        return;
      }
      setSettingsSchema(data);
    } catch {
      if (requestId === settingsSchemaRequestRef.current) {
        setSettingsSchemaError("Could not load training settings.");
      }
    }
  }, []);

  // The catalog's "Your models" group mirrors the models; reload without
  // clearing so a still-valid selection survives.
  const refreshCatalog = useCallback(() => {
    if (baseModelsDatasetRef.current !== null) {
      void loadBaseModels(baseModelsDatasetRef.current, false);
    }
  }, [loadBaseModels]);

  const active = useActiveRun(() => {
    void refreshRuns();
    refreshCatalog();
  });
  const activeRun = active.run;
  const activeIsLive = activeRun !== null && isActiveRun(activeRun);
  const activeMetrics = useRunMetrics(
    activeIsLive ? activeRun.id : null,
    activeIsLive,
    activeRun?.current_epoch ?? 0,
  );

  useEffect(() => {
    void refreshDatasets();
  }, [refreshDatasets]);

  // Preselect the first exported dataset in the URL (no history entry); only
  // fills an unset selection, so a manual choice survives list refreshes.
  useEffect(() => {
    if (selectedDatasetId === null) {
      const first = datasets.find((dataset) => dataset.exported);
      if (first) {
        update({ dataset: first.id }, { replace: true });
      }
    }
  }, [datasets, selectedDatasetId, update]);

  // The catalog and the settings schema depend on the dataset (task type).
  useEffect(() => {
    if (selectedDatasetId !== null) {
      void loadBaseModels(selectedDatasetId);
      void loadSettingsSchema(selectedDatasetId);
    }
  }, [selectedDatasetId, loadBaseModels, loadSettingsSchema]);

  async function handleSubmit(values: TrainConfigValues) {
    setSubmitError(null);
    setSubmitPending(true);
    try {
      const { data, error } = await apiClient.POST("/training/runs", {
        body: {
          dataset_id: values.datasetId,
          ...(values.baseModelVersionId !== null
            ? { base_model_version_id: values.baseModelVersionId }
            : { base_model: values.baseModel }),
          ...(values.name ? { name: values.name } : {}),
          ...(values.note ? { note: values.note } : {}),
          settings: values.settings,
        },
      });
      if (error) {
        setSubmitError(
          (error as { detail?: string }).detail ?? "Failed to start training.",
        );
        return;
      }
      if (data) {
        await refreshRuns();
        void active.refresh();
        update({ tab: "runs", run: data.id, view: "overview" });
        setClearSignal((n) => n + 1);
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
      const { error } = await apiClient.POST("/training/runs/{run_id}/stop", {
        params: { path: { run_id: activeRun.id } },
      });
      if (error) {
        setSubmitError(
          (error as { detail?: string }).detail ?? "Failed to stop the run.",
        );
        return;
      }
      void active.refresh();
      void refreshRuns();
    } finally {
      setStopPending(false);
    }
  }

  async function handleDeleteRun(run: TrainingRunRead) {
    setDeleteError(null);
    const { error } = await apiClient.DELETE("/training/runs/{run_id}", {
      params: { path: { run_id: run.id } },
    });
    if (error) {
      setDeleteError(
        (error as { detail?: string }).detail ?? "Failed to delete the run.",
      );
      return;
    }
    await refreshRuns();
    if (url.run === run.id) {
      update({ run: null });
    }
  }

  // "Repeat with changes" is only offered on rows of the selected dataset, so
  // the loaded catalog and schema already belong to it.
  function handleRepeat(run: TrainingRunRead) {
    setPrefill({
      nonce: ++nonceRef.current,
      baseKey: baseKeyFromRun(run),
      values: settingsSchema
        ? valuesFromConfig(
            settingsSchema,
            run.config as Record<string, unknown>,
          )
        : {},
    });
    update({ tab: "new" });
  }

  const openRun =
    url.run !== null ? (runs.find((run) => run.id === url.run) ?? null) : null;
  const missingRun =
    url.run !== null && openRun === null && !loading && runsError === null;

  const lastPoint = activeMetrics.data?.history.at(-1);
  const headline =
    activeRun && lastPoint
      ? headlineScore(activeRun.task_type, lastPoint)
      : { label: "", value: "—" };

  return (
    <div className="flex flex-col gap-4 bg-gray-950 p-8 text-gray-100">
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-semibold">Train</h1>
      </div>

      <div
        role="tablist"
        aria-label="Training adapters"
        className="flex gap-2 border-b border-gray-800"
      >
        <button
          type="button"
          role="tab"
          aria-selected="true"
          className="border-b-2 border-blue-500 px-3 py-2 text-sm font-medium text-gray-100"
        >
          YOLO
        </button>
      </div>

      {activeRun && activeIsLive && (
        <ActiveRunStrip
          run={activeRun}
          headline={headline}
          onStop={handleStop}
          stopPending={stopPending}
          onOpen={() => {
            if (activeRun.dataset_id !== selectedDatasetId) {
              update({
                dataset: activeRun.dataset_id,
                tab: "runs",
                run: activeRun.id,
                view: "overview",
              });
            } else {
              update({ tab: "runs", run: activeRun.id });
            }
          }}
        />
      )}

      {submitError && (
        <div
          role="alert"
          className="rounded border border-red-800 bg-red-950 px-3 py-2 text-sm text-red-300"
        >
          {submitError}
        </div>
      )}

      <div className="flex items-start gap-6">
        <aside className="sticky top-4 w-72 shrink-0">
          <DatasetRail
            datasets={datasets}
            selectedId={selectedDatasetId}
            onSelect={(id) => update({ dataset: id })}
            runCount={selectedDatasetId !== null ? runs.length : undefined}
          />
        </aside>

        <div className="min-w-0 flex-1">
          <div
            role="tablist"
            aria-label="Train sections"
            className="mb-4 flex gap-1 border-b border-gray-800"
          >
            {TAB_LABELS.map((tab) => (
              <button
                key={tab.id}
                type="button"
                role="tab"
                id={`train-tab-${tab.id}`}
                aria-selected={url.tab === tab.id}
                aria-controls={`train-tabpanel-${tab.id}`}
                onClick={() => update({ tab: tab.id })}
                className={`px-3 py-1.5 text-sm ${
                  url.tab === tab.id
                    ? "border-b-2 border-blue-500 text-gray-100"
                    : "text-gray-400 hover:text-gray-200"
                }`}
              >
                {tab.label}
              </button>
            ))}
          </div>

          <div
            role="tabpanel"
            id="train-tabpanel-runs"
            aria-labelledby="train-tab-runs"
            hidden={url.tab !== "runs"}
          >
            {url.tab === "runs" && (
              <>
                {openRun ? (
                  <RunDetail
                    run={openRun}
                    view={url.view}
                    onViewChange={(view) => update({ view })}
                    onBack={() => update({ run: null, view: "overview" })}
                    schema={settingsSchema}
                    onRepeat={handleRepeat}
                    onDeleteRun={handleDeleteRun}
                    onChanged={() => {
                      void refreshRuns();
                      refreshCatalog();
                    }}
                    deleteError={deleteError}
                  />
                ) : (
                  <>
                    {missingRun && (
                      <p className="mb-3 text-sm text-gray-500">
                        {`Run #${url.run} is not on this dataset (it may have been deleted).`}
                      </p>
                    )}
                    <RunsTable
                      runs={runs}
                      selectedRunId={url.run}
                      loading={loading && runs.length === 0}
                      error={runsError}
                      onOpen={(runId) => update({ tab: "runs", run: runId })}
                      onRepeat={handleRepeat}
                      onDelete={handleDeleteRun}
                      deleteError={deleteError}
                    />
                  </>
                )}
              </>
            )}
          </div>

          {/* Stays mounted while the Runs tab is shown, so edits and the kept
              settings survive a look at the table or a started run. */}
          <div
            role="tabpanel"
            id="train-tabpanel-new"
            aria-labelledby="train-tab-new"
            hidden={url.tab !== "new"}
            className="max-w-3xl"
          >
            <TrainConfigForm
              dataset={selectedDataset}
              disabled={submitPending}
              onSubmit={handleSubmit}
              baseModels={baseModels}
              baseModelsError={baseModelsError}
              settingsSchema={settingsSchema}
              settingsSchemaError={settingsSchemaError}
              prefill={prefill}
              clearTextSignal={clearSignal}
            />
          </div>
        </div>
      </div>
    </div>
  );
}
