import type { components } from "../../shared/api/generated/schema";
import { MetricsChart } from "./MetricsChart";
import { isActiveRun } from "./runLogic";
import {
  allFields,
  isChanged,
  type SettingValue,
  type SettingsSchema,
} from "./settingsLogic";
import { useRunMetrics } from "./useRunMetrics";

type TrainingRunRead = components["schemas"]["TrainingRunRead"];

interface RunOverviewProps {
  run: TrainingRunRead;
  schema: SettingsSchema | null;
}

const SECTION = "rounded border border-gray-800 bg-gray-900 p-4";
const HEADING = "mb-2 text-[15px] font-semibold text-gray-200";
const LIST = "grid grid-cols-[minmax(8rem,14rem)_1fr] gap-x-4 gap-y-1 text-sm";

const DETECTION_CARDS: Array<[string, string]> = [
  ["Precision", "metrics/precision(B)"],
  ["Recall", "metrics/recall(B)"],
  ["mAP50", "metrics/mAP50(B)"],
  ["mAP50-95", "metrics/mAP50-95(B)"],
  ["Fitness", "fitness"],
];
const CLASSIFICATION_CARDS: Array<[string, string]> = [
  ["Top-1", "metrics/accuracy_top1"],
  ["Top-5", "metrics/accuracy_top5"],
  ["Fitness", "fitness"],
];

function formatValue(value: unknown): string {
  return value === null || value === undefined ? "—" : String(value);
}

/** The result cards: the known keys for the task when present, otherwise
 * every numeric metric under its own key (a trainer with another vocabulary). */
function resultCards(
  taskType: string,
  metrics: Record<string, unknown>,
): Array<{ label: string; value: number }> {
  const known = taskType === "classification" ? CLASSIFICATION_CARDS : DETECTION_CARDS;
  const cards = known
    .filter(([, key]) => typeof metrics[key] === "number")
    .map(([label, key]) => ({ label, value: metrics[key] as number }));
  if (cards.length > 0) return cards;
  return Object.entries(metrics)
    .filter(([, value]) => typeof value === "number")
    .map(([key, value]) => ({ label: key, value: value as number }));
}

export function RunOverview({ run, schema }: RunOverviewProps) {
  const active = isActiveRun(run);
  const { data } = useRunMetrics(run.id, active, run.current_epoch);

  const config = run.config as Record<string, unknown>;
  const configKeys = Object.keys(config);
  const known = new Set(schema ? allFields(schema).map((field) => field.key) : []);
  const unknown = configKeys.filter((key) => !known.has(key));
  const history = (data?.history ?? []) as Array<Record<string, number>>;
  const cards = resultCards(run.task_type, run.metrics as Record<string, unknown>);

  const changed = schema
    ? allFields(schema).filter(
        (field) =>
          field.key in config &&
          isChanged(field, config[field.key] as SettingValue | undefined),
      )
    : [];

  return (
    <div className="flex flex-col gap-4">
      {run.error && (
        <p className="rounded border border-red-800 bg-red-950 p-3 text-sm text-red-300">
          {run.error}
        </p>
      )}

      {cards.length > 0 && (
        <section aria-label="Results" className="flex flex-wrap gap-2">
          {cards.map((card) => (
            <div
              key={card.label}
              className="min-w-28 rounded border border-gray-800 bg-gray-900 px-3 py-2"
            >
              <div className="text-[13px] text-gray-400">{card.label}</div>
              <div
                className="text-lg font-semibold text-gray-100"
                title={String(card.value)}
              >
                {card.value.toFixed(3)}
              </div>
            </div>
          ))}
        </section>
      )}

      {history.length > 0 && (
        <section className={SECTION}>
          <h3 className={HEADING}>Training curve</h3>
          <div className="min-h-[280px] max-w-full">
            <MetricsChart history={history} />
          </div>
        </section>
      )}

      {schema && changed.length > 0 && (
        <section className={SECTION}>
          <h3 className={HEADING}>Changed settings</h3>
          <dl className={LIST}>
            {changed.map((field) => (
              <div key={field.key} className="contents">
                <dt className="text-gray-400">{field.label}</dt>
                <dd className="text-blue-300">
                  {formatValue(config[field.key])}
                  <span className="ml-2 text-[13px] text-gray-400">
                    {`(default ${formatValue(field.default)})`}
                  </span>
                </dd>
              </div>
            ))}
          </dl>
        </section>
      )}

      <details className={SECTION}>
        <summary className="cursor-pointer text-[15px] font-semibold text-gray-200">
          {`All settings (${configKeys.length})`}
        </summary>
        <div className="mt-3 flex flex-col gap-3">
          {schema ? (
            <>
              {schema.groups
                .filter((group) => group.fields.some((field) => field.key in config))
                .map((group) => (
                  <div key={group.id}>
                    <h4 className="mb-1 text-sm text-gray-300">{group.label}</h4>
                    <dl className={LIST}>
                      {group.fields
                        .filter((field) => field.key in config)
                        .map((field) => {
                          const value = config[field.key] as SettingValue | undefined;
                          return (
                            <div key={field.key} className="contents">
                              <dt className="text-gray-400">{field.label}</dt>
                              <dd
                                className={
                                  isChanged(field, value) ? "text-blue-300" : "text-gray-200"
                                }
                              >
                                {formatValue(value)}
                              </dd>
                            </div>
                          );
                        })}
                    </dl>
                  </div>
                ))}
              {unknown.length > 0 && (
                <RawList title="Other settings" keys={unknown} config={config} />
              )}
            </>
          ) : (
            <RawList title="Settings" keys={configKeys} config={config} />
          )}
        </div>
      </details>
    </div>
  );
}

function RawList({
  title,
  keys,
  config,
}: {
  title: string;
  keys: string[];
  config: Record<string, unknown>;
}) {
  return (
    <div>
      <h4 className="mb-1 text-sm text-gray-300">{title}</h4>
      <dl className={LIST}>
        {keys.map((key) => (
          <div key={key} className="contents">
            <dt className="text-gray-400">{key}</dt>
            <dd className="text-gray-200">{formatValue(config[key])}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}
