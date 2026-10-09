import { useEffect, useState } from "react";

import { apiClient } from "../../shared/api/client";
import type { components } from "../../shared/api/generated/schema";
import { MetricsChart } from "./MetricsChart";
import { isActiveRun } from "./runLogic";
import { allFields, isChanged, type SettingValue, type SettingsSchema } from "./settingsLogic";
import { useRunMetrics } from "./useRunMetrics";

type TrainingRunRead = components["schemas"]["TrainingRunRead"];

interface RunOverviewProps {
  run: TrainingRunRead;
  schema: SettingsSchema | null;
  onRepeat: (run: TrainingRunRead) => void;
  onDeleteRun: (run: TrainingRunRead) => void;
  onChanged: () => void;
  deleteError: string | null;
}

const SECTION = "rounded border border-gray-800 bg-gray-900 p-4";
const HEADING = "mb-2 text-xs font-medium uppercase text-gray-500";
const BUTTON = "rounded border border-gray-700 px-3 py-1.5 text-sm text-gray-300 hover:text-gray-100";
const DISABLED = "disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:text-gray-300";
const FIELD =
  "w-full rounded border border-gray-700 bg-gray-950 px-2 py-1 text-sm text-gray-100 focus:border-blue-500 focus:outline-none";

/** An inline-edited text field: saved on blur only when it differs from the
 * stored value, one field per request; Escape restores without saving. */
function EditableField({
  run,
  field,
  label,
  multiline,
  onChanged,
}: {
  run: TrainingRunRead;
  field: "name" | "note";
  label: string;
  multiline: boolean;
  onChanged: () => void;
}) {
  const stored = run[field] ?? "";
  const [text, setText] = useState(stored);
  const [focused, setFocused] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    // Unsaved edits (including ones whose save failed) are never overwritten.
    // A saved edit stays "dirty" until the server value catches up with it.
    if (dirty && stored === text) {
      setDirty(false);
      return;
    }
    if (!focused && !dirty) setText(stored);
  }, [stored, focused, dirty, text]);

  useEffect(() => {
    setError(null);
    setDirty(false);
    setText(stored);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [run.id]);

  async function save() {
    setFocused(false);
    if (text === stored) {
      setDirty(false);
      return;
    }
    try {
      const { error: failed } = await apiClient.PATCH("/training/runs/{run_id}", {
        params: { path: { run_id: run.id } },
        body: { [field]: text },
      });
      if (failed) {
        setError(`Could not save the ${field}.`);
        return;
      }
      setError(null);
      onChanged();
    } catch {
      setError(`Could not save the ${field}.`);
    }
  }

  const common = {
    "aria-label": label,
    value: text,
    className: FIELD,
    onFocus: () => setFocused(true),
    onBlur: () => void save(),
    onChange: (event: { target: { value: string } }) => {
      setText(event.target.value);
      setDirty(true);
      setError(null);
    },
    onKeyDown: (event: React.KeyboardEvent) => {
      if (event.key === "Escape") {
        setText(stored);
        setDirty(false);
        setError(null);
      }
    },
  };

  return (
    <div>
      <label className="mb-1 block text-xs text-gray-500">{label}</label>
      {multiline ? <textarea rows={2} {...common} /> : <input type="text" {...common} />}
      {error && (
        <p role="alert" className="mt-1 text-xs text-red-400">
          {error}
        </p>
      )}
    </div>
  );
}

function formatValue(value: unknown): string {
  return value === null || value === undefined ? "—" : String(value);
}

export function RunOverview({
  run,
  schema,
  onRepeat,
  onDeleteRun,
  onChanged,
  deleteError,
}: RunOverviewProps) {
  const active = isActiveRun(run);
  const { data } = useRunMetrics(run.id, active, run.current_epoch);
  const [armed, setArmed] = useState(false);

  useEffect(() => {
    setArmed(false);
  }, [run.id, run.status]);

  const config = run.config as Record<string, unknown>;
  const known = new Set(schema ? allFields(schema).map((field) => field.key) : []);
  const unknown = Object.keys(config).filter((key) => !known.has(key));
  const history = (data?.history ?? []) as Array<Record<string, number>>;
  const numericMetrics = Object.entries(run.metrics as Record<string, unknown>).filter(
    ([, value]) => typeof value === "number",
  ) as Array<[string, number]>;

  const ownsModel = run.model_version_id !== null && run.model_version_id !== undefined;
  const blockReason = ownsModel ? "Delete the model first" : active ? "Stop the run first" : undefined;
  const percent =
    run.total_epochs > 0 ? Math.min(100, Math.round((run.current_epoch / run.total_epochs) * 100)) : 0;

  return (
    <div className="flex flex-col gap-4">
      <section className={`${SECTION} grid gap-3 md:grid-cols-2`}>
        <EditableField run={run} field="name" label="Name" multiline={false} onChanged={onChanged} />
        <EditableField run={run} field="note" label="Note" multiline onChanged={onChanged} />
      </section>

      {run.error && (
        <p className="rounded border border-red-800 bg-red-950 p-3 text-sm text-red-300">{run.error}</p>
      )}

      {active && (
        <section className={SECTION}>
          <h3 className={HEADING}>Progress</h3>
          <div
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={run.total_epochs}
            aria-valuenow={run.current_epoch}
            aria-label="Training progress"
            className="h-2 w-full overflow-hidden rounded bg-gray-800"
          >
            <div className="h-full bg-blue-600" style={{ width: `${percent}%` }} />
          </div>
          <p className="mt-1 text-xs text-gray-400">{`Epoch ${run.current_epoch} / ${run.total_epochs}`}</p>
        </section>
      )}

      <section className={SECTION}>
        <h3 className={HEADING}>Configuration</h3>
        {schema ? (
          <div className="flex flex-col gap-3">
            {schema.groups.map((group) => (
              <div key={group.id}>
                <h4 className="mb-1 text-sm text-gray-300">{group.label}</h4>
                <dl className="grid grid-cols-[minmax(8rem,14rem)_1fr] gap-x-4 gap-y-1 text-sm">
                  {group.fields
                    .filter((field) => field.key in config)
                    .map((field) => {
                      const value = config[field.key] as SettingValue | undefined;
                      const changed = isChanged(field, value);
                      return (
                        <div key={field.key} className="contents">
                          <dt className="text-gray-400">{field.label}</dt>
                          <dd className={changed ? "text-blue-300" : "text-gray-200"}>
                            {formatValue(value)}
                            {changed && (
                              <span className="ml-2 text-xs text-gray-500">
                                {`(default ${formatValue(field.default)})`}
                              </span>
                            )}
                          </dd>
                        </div>
                      );
                    })}
                </dl>
              </div>
            ))}
            {unknown.length > 0 && <RawList title="Other settings" keys={unknown} config={config} />}
          </div>
        ) : (
          <RawList title="Settings" keys={Object.keys(config)} config={config} />
        )}
      </section>

      {numericMetrics.length > 0 && (
        <section className={SECTION}>
          <h3 className={HEADING}>Final metrics</h3>
          <table className="text-sm text-gray-200">
            <tbody>
              {numericMetrics.map(([key, value]) => (
                <tr key={key}>
                  <td className="pr-6 text-gray-400">{key}</td>
                  <td>{value}</td>
                </tr>
              ))}
            </tbody>
          </table>
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

      <section className={`${SECTION} flex flex-wrap items-center gap-2`}>
        <button type="button" className={BUTTON} onClick={() => onRepeat(run)}>
          Repeat with changes
        </button>
        {armed ? (
          <>
            <button
              type="button"
              aria-label={`Confirm delete run #${run.id}`}
              className="rounded border border-red-700 px-3 py-1.5 text-sm text-red-300 hover:text-red-100"
              onClick={() => onDeleteRun(run)}
            >
              Confirm
            </button>
            <button type="button" className={BUTTON} onClick={() => setArmed(false)}>
              Cancel
            </button>
          </>
        ) : (
          <button
            type="button"
            aria-label={`Delete run #${run.id}`}
            disabled={blockReason !== undefined}
            title={blockReason}
            className={`${BUTTON} ${DISABLED}`}
            onClick={() => setArmed(true)}
          >
            Delete run
          </button>
        )}
        {deleteError && (
          <p role="alert" className="w-full text-sm text-red-400">
            {deleteError}
          </p>
        )}
      </section>
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
      <dl className="grid grid-cols-[minmax(8rem,14rem)_1fr] gap-x-4 gap-y-1 text-sm">
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
