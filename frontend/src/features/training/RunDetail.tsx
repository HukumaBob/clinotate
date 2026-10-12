import { useEffect, useRef, useState } from "react";

import { apiClient } from "../../shared/api/client";
import type { RunView } from "./useTrainUrl";
import type { components } from "../../shared/api/generated/schema";
import { RunLogView } from "./RunLogView";
import { RunMetricsView } from "./RunMetricsView";
import { RunModelView } from "./RunModelView";
import { RunOverview } from "./RunOverview";
import { formatDuration, headlineScore, isActiveRun } from "./runLogic";
import { STATUS_STYLES } from "./RunsTable";
import { useDismissableMenu } from "./useDismissableMenu";
import type { SettingsSchema } from "./settingsLogic";

type TrainingRunRead = components["schemas"]["TrainingRunRead"];

interface RunDetailProps {
  run: TrainingRunRead;
  view: RunView;
  onViewChange: (view: RunView) => void;
  onBack: () => void;
  schema: SettingsSchema | null;
  onRepeat: (run: TrainingRunRead) => void;
  onDeleteRun: (run: TrainingRunRead) => void;
  onChanged: () => void;
  deleteError: string | null;
}

const TABS: Array<{ id: RunView; label: string }> = [
  { id: "overview", label: "Overview" },
  { id: "metrics", label: "Metrics" },
  { id: "log", label: "Log" },
  { id: "model", label: "Model" },
];

const BUTTON =
  "h-8 rounded border border-gray-700 px-3 text-sm text-gray-300 hover:text-gray-100";
const INLINE =
  "rounded border border-transparent bg-transparent px-1.5 py-1 text-gray-100 hover:border-gray-700 focus:border-blue-500 focus:bg-gray-950 focus:outline-none";

/** An inline-edited text field: saved on blur only when it differs from the
 * stored value, one field per request; Escape restores without saving. */
function EditableField({
  run,
  field,
  label,
  placeholder,
  className,
  onChanged,
}: {
  run: TrainingRunRead;
  field: "name" | "note";
  label: string;
  placeholder: string;
  className: string;
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
      const { error: failed } = await apiClient.PATCH(
        "/training/runs/{run_id}",
        {
          params: { path: { run_id: run.id } },
          body: { [field]: text },
        },
      );
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
    className,
    placeholder,
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
    <div className="min-w-0">
      <input type="text" {...common} />
      {error && (
        <p role="alert" className="mt-1 text-[13px] text-red-400">
          {error}
        </p>
      )}
    </div>
  );
}

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
  const active = isActiveRun(run);
  const [menuOpen, setMenuOpen] = useState(false);
  const [armed, setArmed] = useState(false);

  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const closeMenu = (refocus: boolean) => {
    setMenuOpen(false);
    setArmed(false);
    if (refocus) trigger.current?.focus();
  };
  useDismissableMenu(menuOpen, closeMenu, menu, trigger);

  // Arming swaps the focused item out; keep focus inside so Escape still lands.
  useEffect(() => {
    if (menuOpen) menu.current?.querySelector<HTMLElement>("button:not(:disabled)")?.focus();
  }, [armed, menuOpen]);

  useEffect(() => {
    setMenuOpen(false);
    setArmed(false);
  }, [run.id, run.status]);

  const blockReason = hasModel
    ? "Delete the model first"
    : active
      ? "Stop the run first"
      : undefined;
  const score = headlineScore(run.task_type, run.metrics as Record<string, unknown>);
  const duration = formatDuration(run.started_at ?? null, run.finished_at ?? null);

  return (
    <div className="flex flex-col gap-3">
      <header className="flex flex-wrap items-center gap-3">
        <button type="button" onClick={onBack} className={BUTTON}>
          ← Runs
        </button>
        <span className="text-gray-400">{`#${run.id}`}</span>
        <EditableField
          run={run}
          field="name"
          label="Name"
          placeholder="Name this run"
          className={`${INLINE} w-56 text-[15px] font-semibold`}
          onChanged={onChanged}
        />
        <span
          className={`rounded px-2 py-0.5 text-[13px] ${STATUS_STYLES[run.status] ?? "bg-gray-700 text-gray-200"}`}
        >
          {run.status}
        </span>
        <span className="ml-2 flex items-baseline gap-1.5" title="Headline metric">
          <span className="text-2xl font-semibold text-gray-100">{score.value}</span>
          {score.label && <span className="text-[13px] text-gray-400">{score.label}</span>}
        </span>
        <span className="text-[13px] text-gray-400">{duration}</span>
        <div className="relative ml-auto flex items-center gap-2">
          <button type="button" className={BUTTON} onClick={() => onRepeat(run)}>
            Repeat
          </button>
          <button
            ref={trigger}
            type="button"
            aria-label="More actions"
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            className={BUTTON}
            onClick={() => (menuOpen ? closeMenu(false) : setMenuOpen(true))}
          >
            ⋯
          </button>
          {menuOpen && (
            <div
              ref={menu}
              role="menu"
              onKeyDown={(e) => {
                if (e.key === "Escape") {
                  e.stopPropagation();
                  closeMenu(true);
                }
              }}
              className="absolute right-0 top-9 z-10 flex min-w-40 flex-col gap-2 rounded border border-gray-700 bg-gray-900 p-2"
            >
              {armed ? (
                <div className="flex gap-2">
                  <button
                    type="button"
                    role="menuitem"
                    aria-label={`Confirm delete run #${run.id}`}
                    className="h-8 rounded border border-red-700 px-3 text-sm text-red-300 hover:text-red-100"
                    onClick={() => onDeleteRun(run)}
                  >
                    Confirm
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    className={BUTTON}
                    onClick={() => setArmed(false)}
                  >
                    Cancel
                  </button>
                </div>
              ) : (
                <button
                  type="button"
                  role="menuitem"
                  aria-label={`Delete run #${run.id}`}
                  disabled={blockReason !== undefined}
                  title={blockReason}
                  className="h-8 rounded px-3 text-left text-sm text-red-300 hover:text-red-100 disabled:cursor-not-allowed disabled:opacity-40"
                  onClick={() => setArmed(true)}
                >
                  Delete run
                </button>
              )}
            </div>
          )}
        </div>
      </header>

      <EditableField
        run={run}
        field="note"
        label="Note"
        placeholder="Add a note"
        className={`${INLINE} w-full text-sm text-gray-300 placeholder:text-gray-400`}
        onChanged={onChanged}
      />

      {deleteError && (
        <p role="alert" className="text-sm text-red-400">
          {deleteError}
        </p>
      )}

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
        {view === "overview" && <RunOverview run={run} schema={schema} />}
        {view === "metrics" && <RunMetricsView run={run} />}
        {view === "log" && <RunLogView run={run} />}
        {view === "model" && <RunModelView run={run} onChanged={onChanged} />}
      </div>
    </div>
  );
}
