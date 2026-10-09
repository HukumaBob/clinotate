import type { components } from "../../shared/api/generated/schema";
import { RunLogView } from "./RunLogView";
import { RunMetricsView } from "./RunMetricsView";
import { RunModelView } from "./RunModelView";
import { RunOverview } from "./RunOverview";
import { STATUS_STYLES } from "./RunsTable";
import type { SettingsSchema } from "./settingsLogic";

type TrainingRunRead = components["schemas"]["TrainingRunRead"];

export type RunDetailView = "overview" | "metrics" | "log" | "model";

interface RunDetailProps {
  run: TrainingRunRead;
  view: RunDetailView;
  onViewChange: (view: RunDetailView) => void;
  onBack: () => void;
  schema: SettingsSchema | null;
  onRepeat: (run: TrainingRunRead) => void;
  onDeleteRun: (run: TrainingRunRead) => void;
  onChanged: () => void;
  deleteError: string | null;
}

const TABS: Array<{ id: RunDetailView; label: string }> = [
  { id: "overview", label: "Overview" },
  { id: "metrics", label: "Metrics" },
  { id: "log", label: "Log" },
  { id: "model", label: "Model" },
];

export function RunDetail({
  run,
  view,
  onViewChange,
  onBack,
  schema,
  onRepeat,
  onDeleteRun,
  onChanged,
  deleteError,
}: RunDetailProps) {
  const hasModel = run.model_version_id !== null && run.model_version_id !== undefined;
  return (
    <div className="flex flex-col gap-4">
      <header className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={onBack}
          className="rounded border border-gray-700 px-2 py-1 text-xs text-gray-300 hover:text-gray-100"
        >
          ← Runs
        </button>
        <span className="text-gray-400">{`#${run.id}`}</span>
        {run.name && <span className="text-gray-100">{run.name}</span>}
        <span
          className={`rounded px-2 py-0.5 text-xs ${STATUS_STYLES[run.status] ?? "bg-gray-700 text-gray-200"}`}
        >
          {run.status}
        </span>
      </header>

      <div role="tablist" aria-label="Run details" className="flex gap-1 border-b border-gray-800">
        {TABS.map((tab) => {
          const disabled = tab.id === "model" && !hasModel;
          const selected = view === tab.id;
          return (
            <button
              key={tab.id}
              type="button"
              role="tab"
              id={`run-tab-${tab.id}`}
              aria-selected={selected}
              aria-controls="run-tabpanel"
              disabled={disabled}
              title={disabled ? "This run has no model" : undefined}
              onClick={() => onViewChange(tab.id)}
              className={`px-3 py-1.5 text-sm disabled:cursor-not-allowed disabled:opacity-40 ${
                selected ? "border-b-2 border-blue-500 text-gray-100" : "text-gray-400 hover:text-gray-200"
              }`}
            >
              {tab.label}
            </button>
          );
        })}
      </div>

      <div role="tabpanel" id="run-tabpanel" aria-labelledby={`run-tab-${view}`}>
        {view === "overview" && (
          <RunOverview
            run={run}
            schema={schema}
            onRepeat={onRepeat}
            onDeleteRun={onDeleteRun}
            onChanged={onChanged}
            deleteError={deleteError}
          />
        )}
        {view === "metrics" && <RunMetricsView run={run} />}
        {view === "log" && <RunLogView run={run} />}
        {view === "model" && <RunModelView run={run} onChanged={onChanged} />}
      </div>
    </div>
  );
}
