import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { apiClient } from "../../shared/api/client";
import type { components } from "../../shared/api/generated/schema";
import { ActiveRunStrip } from "./ActiveRunStrip";
import { CompareView } from "./CompareView";
import { MAX_COMPARE } from "./compareLogic";
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
import { TrainToolbar } from "./TrainToolbar";
import { useActiveRun } from "./useActiveRun";
import { useRunMetrics } from "./useRunMetrics";
import { useRuns } from "./useRuns";
import { useTrainUrl } from "./useTrainUrl";

type TrainingRunRead = components["schemas"]["TrainingRunRead"];
type BaseModelOption = components["schemas"]["BaseModelOption"];

interface Prefill {
  nonce: number;
  baseKey: string;
  values: SettingsValues;
}

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
    const ticked = validCompareIds.includes(run.id);
    const remaining = validCompareIds.filter((other) => other !== run.id);
    if (url.run === run.id || ticked) {
      update({
        ...(url.run === run.id ? { run: null } : {}),
        ...(ticked
          ? {
              compare: remaining,
              compareOpen: remaining.length >= 2 ? url.compareOpen : false,
            }
          : {}),
      });
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

  // The runs list does not poll; the polled active run is fresher for its own
  // row and details. Memoised so the array keeps its reference between renders.
  const liveRuns = useMemo(
    () =>
      activeRun && runs.some((run) => run.id === activeRun.id)
        ? runs.map((run) => (run.id === activeRun.id ? activeRun : run))
        : runs,
    [runs, activeRun],
  );
  const openRun =
    url.run !== null
      ? (liveRuns.find((run) => run.id === url.run) ?? null)
      : null;
  const missingRun =
    url.run !== null && openRun === null && !loading && runsError === null;

  useEffect(() => {
    setDeleteError(null);
  }, [selectedDatasetId, url.run]);

  // The URL's compare ids, kept only once the list is loaded and only when
  // they are finished runs of this dataset (order kept, capped).
  // "Loaded" means the first load for this dataset has completed; a background
  // refresh (loading flips back to true) must not unmount the compare view.
  const [loadedFor, setLoadedFor] = useState<number | null>(null);
  const sawLoadingRef = useRef<number | null>(null);
  useEffect(() => {
    if (loading) {
      sawLoadingRef.current = selectedDatasetId;
    } else if (
      selectedDatasetId !== null &&
      sawLoadingRef.current === selectedDatasetId &&
      runsError === null
    ) {
      setLoadedFor(selectedDatasetId);
    }
  }, [loading, runsError, selectedDatasetId]);
  const listLoaded = loadedFor === selectedDatasetId && runsError === null;
  const validCompareIds = listLoaded
    ? url.compare
        .filter((id) =>
          liveRuns.some(
            (run) => run.id === id && (run.status === "succeeded" || run.status === "stopped"),
          ),
        )
        .slice(0, MAX_COMPARE)
    : [];
  const compareDropped = listLoaded && validCompareIds.length < url.compare.length;
  const compareRuns = validCompareIds
    .map((id) => liveRuns.find((run) => run.id === id))
    .filter((run): run is TrainingRunRead => run !== undefined);
  const showCompare = url.compareOpen && validCompareIds.length >= 2;

  function handleToggleCompare(id: number) {
    // Ticking never opens the view; it also drops a latent cmp from the link.
    if (validCompareIds.includes(id)) {
      update({ compare: validCompareIds.filter((other) => other !== id), compareOpen: false });
    } else if (validCompareIds.length < MAX_COMPARE) {
      update({ compare: [...validCompareIds, id], compareOpen: false });
    }
  }

  function handleRemoveCompare(id: number) {
    const remaining = validCompareIds.filter((other) => other !== id);
    update(
      remaining.length < 2
        ? { compare: remaining, compareOpen: false }
        : { compare: remaining },
    );
  }

  const lastPoint = activeMetrics.data?.history.at(-1);
  const headline =
    activeRun && lastPoint
      ? headlineScore(activeRun.task_type, lastPoint)
      : { label: "", value: "—" };

  return (
    <div className="flex flex-col gap-3 bg-gray-950 px-6 py-4 text-gray-100">
      <TrainToolbar
        datasets={datasets}
        selectedId={selectedDatasetId}
        onSelect={(id) => update({ dataset: id })}
        runCount={selectedDatasetId !== null ? runs.length : undefined}
        onNewRun={() => update({ tab: "new" })}
        formOpen={url.tab === "new"}
        onCloseForm={() => update({ tab: "runs" })}
      />

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
                compare: [],
                compareOpen: false,
                tab: "runs",
                run: activeRun.id,
                view: "overview",
              });
            } else {
              update({ tab: "runs", run: activeRun.id, view: "overview" });
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

      {url.tab === "runs" && (
        <>
          {showCompare ? (
            <CompareView
              runs={compareRuns}
              schema={settingsSchema}
              onBack={() => update({ compareOpen: false })}
              onRemove={handleRemoveCompare}
            />
          ) : openRun ? (
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
                <p className="mb-3 text-[13px] text-gray-400">
                  {`Run #${url.run} is not on this dataset (it may have been deleted).`}
                </p>
              )}
              {compareDropped && (
                <p className="mb-3 text-[13px] text-gray-400">
                  Some runs in the link are not on this dataset and were left out.
                </p>
              )}
              <RunsTable
                runs={liveRuns}
                selectedForCompare={validCompareIds}
                onToggleCompare={handleToggleCompare}
                onCompare={() => update({ compareOpen: true })}
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

      {/* Stays mounted while the Runs view is shown, so edits and the kept
          settings survive a look at the table or a started run. */}
      <div hidden={url.tab !== "new"} className="max-w-5xl">
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
  );
}
