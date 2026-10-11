import type { components } from "../../shared/api/generated/schema";
import { COMPARE_COLORS, CompareCurves, type CompareRunInfo } from "./CompareCurves";
import { CompareTables } from "./CompareTables";
import { runLabel, type Confusion, type HistoryPoint } from "./compareLogic";
import { ConfusionCompare } from "./ConfusionCompare";
import type { SettingsSchema } from "./settingsLogic";
import { useCompareMetrics } from "./useCompareMetrics";

type TrainingRunRead = components["schemas"]["TrainingRunRead"];

interface CompareViewProps {
  runs: TrainingRunRead[];
  schema: SettingsSchema | null;
  onBack: () => void;
  onRemove: (runId: number) => void;
}

export function CompareView({ runs, schema, onBack, onRemove }: CompareViewProps) {
  const { byId, loading } = useCompareMetrics(runs.map((run) => run.id));

  const infos: CompareRunInfo[] = runs.map((run, i) => ({
    id: run.id,
    label: runLabel(run),
    color: COMPARE_COLORS[i % COMPARE_COLORS.length],
  }));
  const failed = loading ? [] : infos.filter((info) => byId[info.id] === null);
  const metrics = runs.map((run) => {
    const m = byId[run.id];
    return m ? { metrics: m.metrics, per_class: m.per_class } : null;
  });

  return (
    <div className="space-y-6">
      <div className="space-y-2">
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={onBack}
            className="text-sm text-gray-300 hover:text-white"
          >
            ← Runs
          </button>
          <h2 className="text-base font-semibold text-gray-100">
            {`Comparing ${infos.map((info) => info.label).join(", ")}`}
          </h2>
        </div>
        <ul className="flex flex-wrap gap-2">
          {infos.map((info) => (
            <li
              key={info.id}
              className="flex items-center gap-2 rounded-full border border-gray-700 px-3 py-1 text-xs text-gray-200"
            >
              <span
                aria-hidden="true"
                className="inline-block h-2.5 w-2.5 rounded-full"
                style={{ backgroundColor: info.color }}
              />
              {info.label}
              <button
                type="button"
                aria-label={`Remove run ${info.id} from the comparison`}
                onClick={() => onRemove(info.id)}
                className="text-gray-400 hover:text-white"
              >
                ×
              </button>
            </li>
          ))}
        </ul>
      </div>

      {loading ? (
        <p className="text-sm text-gray-500">Loading metrics…</p>
      ) : (
        <>
          {failed.map((info) => (
            <p key={info.id} className="text-sm text-gray-500">
              {`Could not load metrics for ${info.label}; it is shown without numbers.`}
            </p>
          ))}
          <CompareCurves
            runs={infos}
            histories={runs.map((run) => (byId[run.id]?.history ?? []) as HistoryPoint[])}
          />
          <CompareTables
            runs={infos}
            runObjects={runs.map((run) => ({
              id: run.id,
              base_model: run.base_model,
              base_model_version_id: run.base_model_version_id,
              config: run.config as Record<string, unknown>,
            }))}
            metrics={metrics}
            schema={schema}
          />
          <ConfusionCompare
            runs={infos}
            confusions={runs.map((run) => (byId[run.id]?.confusion ?? null) as Confusion | null)}
          />
        </>
      )}
    </div>
  );
}
