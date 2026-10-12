import { useEffect, useRef, useState } from "react";

import type { components } from "../../shared/api/generated/schema";
import { useDismissableMenu } from "./useDismissableMenu";
import { MAX_COMPARE } from "./compareLogic";
import { bestRunId, formatDuration, headlineScore, settingsLine } from "./runLogic";

type TrainingRunRead = components["schemas"]["TrainingRunRead"];

export const STATUS_STYLES: Record<string, string> = {
  pending: "bg-gray-700 text-gray-200",
  running: "bg-blue-600 text-white",
  succeeded: "bg-green-700 text-white",
  failed: "bg-red-700 text-white",
  stopped: "bg-yellow-700 text-white",
};

interface RunsTableProps {
  runs: TrainingRunRead[];
  selectedRunId: number | null;
  loading: boolean;
  error: string | null;
  onOpen: (runId: number) => void;
  onRepeat: (run: TrainingRunRead) => void;
  onDelete: (run: TrainingRunRead) => void;
  deleteError: string | null;
  selectedForCompare?: number[];
  onToggleCompare?: (runId: number) => void;
  onCompare?: () => void;
  onClearCompare?: () => void;
}

const BUTTON = "rounded border border-gray-700 px-3 py-1 text-[13px] text-gray-300 hover:text-gray-100";
const CHECKBOX = "h-4 w-4 accent-blue-500 [color-scheme:dark]";
const ITEM =
  "block w-full px-3 py-1.5 text-left text-[13px] text-gray-200 hover:bg-gray-800 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent";

interface RowMenuProps {
  run: TrainingRunRead;
  blockReason: string | undefined;
  rowsKey: string;
  onDelete: (run: TrainingRunRead) => void;
}

function RowMenu({ run, blockReason, rowsKey, onDelete }: RowMenuProps) {
  const [pos, setPos] = useState<{ top: number; right: number } | null>(null);
  const [armed, setArmed] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const open = pos !== null;

  const close = (refocus: boolean) => {
    setPos(null);
    setArmed(false);
    if (refocus) trigger.current?.focus();
  };

  useDismissableMenu(open, close, menu, trigger, true);

  // Arming swaps the focused item out; keep focus inside so Escape still lands.
  useEffect(() => {
    if (open) menu.current?.querySelector<HTMLElement>("button:not(:disabled)")?.focus();
  }, [armed, open]);

  // Rows shift when the list changes and a fixed-position menu would float
  // next to the wrong row; a changed block reason must not keep Confirm armed.
  useEffect(() => {
    close(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [blockReason, rowsKey]);

  const toggle = () => {
    if (open) return close(false);
    const r = trigger.current!.getBoundingClientRect();
    setPos({ top: r.bottom + 4, right: window.innerWidth - r.right });
  };

  return (
    <>
      <button
        ref={trigger}
        type="button"
        className={`${BUTTON} px-2`}
        aria-label={`More actions for run ${run.id}`}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={toggle}
      >
        ⋯
      </button>
      {open && (
        <div
          ref={menu}
          role="menu"
          className="fixed z-20 min-w-[9rem] rounded border border-gray-700 bg-gray-900 py-1 shadow-lg"
          style={{ top: pos.top, right: pos.right }}
          onClick={(e) => e.stopPropagation()}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              e.stopPropagation();
              close(true);
            }
          }}
        >
          {armed && !blockReason ? (
            <button
              type="button"
              role="menuitem"
              className={`${ITEM} text-red-300`}
              aria-label={`Confirm delete run ${run.id}`}
              onClick={() => {
                onDelete(run);
                close(true);
              }}
            >
              Confirm delete
            </button>
          ) : (
            <button
              type="button"
              role="menuitem"
              className={ITEM}
              disabled={blockReason !== undefined}
              title={blockReason}
              aria-label={`Delete run ${run.id}`}
              onClick={() => setArmed(true)}
            >
              Delete
            </button>
          )}
        </div>
      )}
    </>
  );
}

export function RunsTable({
  runs,
  selectedRunId,
  loading,
  error,
  onOpen,
  onRepeat,
  onDelete,
  deleteError,
  selectedForCompare = [],
  onToggleCompare = () => {},
  onCompare = () => {},
  onClearCompare,
}: RunsTableProps) {
  if (error) return <p className="text-[14px] text-red-400">{error}</p>;
  if (loading) return <p className="text-[14px] text-gray-400">Loading runs…</p>;
  if (runs.length === 0) {
    return (
      <p className="text-[14px] text-gray-400">
        No runs on this dataset yet. Start one with the + New run button.
      </p>
    );
  }

  const rowsKey = runs.map((r) => r.id).join(",");
  const best = bestRunId(runs);
  const now = new Date();

  return (
    <div>
      {deleteError && (
        <p role="alert" className="mb-2 text-[14px] text-red-400">
          {deleteError}
        </p>
      )}
      {selectedForCompare.length > 0 && (
        <div className="mb-2 flex items-center gap-3 text-[13px] text-gray-400">
          <span>{`${selectedForCompare.length} selected`}</span>
          <button
            type="button"
            className={`${BUTTON} disabled:cursor-not-allowed disabled:opacity-40`}
            disabled={selectedForCompare.length < 2}
            title={selectedForCompare.length < 2 ? "Select at least 2 runs" : undefined}
            onClick={onCompare}
          >
            Compare
          </button>
          <button
            type="button"
            className="text-gray-300 hover:text-gray-100"
            onClick={() =>
              onClearCompare ? onClearCompare() : selectedForCompare.forEach((id) => onToggleCompare(id))
            }
          >
            Clear
          </button>
        </div>
      )}
      <div className="overflow-x-auto">
        <table className="w-full text-left text-[14px] text-gray-200">
          <thead>
            <tr className="border-b border-gray-800 text-[13px] text-gray-400">
              <th className="px-3 py-2 font-normal">
                <span className="sr-only">Compare</span>
              </th>
              <th className="px-3 py-2 font-normal">#</th>
              <th className="px-3 py-2 font-normal">Base</th>
              <th className="px-3 py-2 font-normal">Settings</th>
              <th className="px-3 py-2 font-normal">Status</th>
              <th className="px-3 py-2 font-normal">Score</th>
              <th className="px-3 py-2 font-normal">Duration</th>
              <th className="px-3 py-2 font-normal">Created</th>
              <th className="px-3 py-2 text-right font-normal">
                <span className="sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {runs.map((run) => {
              const score = headlineScore(run.task_type, run.metrics as Record<string, unknown>);
              const active = run.status === "pending" || run.status === "running";
              const ownsModel = run.model_version_id !== null && run.model_version_id !== undefined;
              const blockReason = ownsModel
                ? "Delete the model first"
                : active
                  ? "Stop the run first"
                  : undefined;
              const selected = run.id === selectedRunId;
              const finished = run.status === "succeeded" || run.status === "stopped";
              const checked = selectedForCompare.includes(run.id);
              const full = selectedForCompare.length >= MAX_COMPARE && !checked;
              const compareReason = !finished && !checked
                ? "Only finished runs can be compared"
                : full
                  ? `You can compare up to ${MAX_COMPARE} runs`
                  : undefined;
              return (
                <tr
                  key={run.id}
                  aria-current={selected ? "true" : undefined}
                  className={`h-14 cursor-pointer border-b border-gray-900 ${
                    selected ? "bg-gray-800" : "hover:bg-gray-900"
                  }`}
                  tabIndex={0}
                  onKeyDown={(event) => {
                    if (event.target === event.currentTarget && event.key === "Enter") onOpen(run.id);
                  }}
                  onClick={(event) => {
                    if ((event.target as HTMLElement).closest("button, input")) return;
                    onOpen(run.id);
                  }}
                >
                  <td className="px-3 py-2" onClick={(e) => e.stopPropagation()}>
                    <input
                      type="checkbox"
                      className={CHECKBOX}
                      aria-label={`Select run ${run.id} for comparison`}
                      checked={checked}
                      disabled={compareReason !== undefined}
                      title={compareReason}
                      onChange={() => onToggleCompare(run.id)}
                    />
                  </td>
                  <td className="max-w-[16rem] px-3 py-2" title={run.note ?? undefined}>
                    <div className="text-gray-300">{`#${run.id}`}</div>
                    {run.name && <div className="truncate text-[13px] text-gray-400">{run.name}</div>}
                  </td>
                  <td className="whitespace-nowrap px-3 py-2 text-gray-400">
                    {run.base_model_version_id !== null && run.base_model_version_id !== undefined
                      ? `↳ ${run.base_model}`
                      : run.base_model}
                  </td>
                  <td className="whitespace-nowrap px-3 py-2 text-gray-400">
                    {settingsLine(run.config as Record<string, unknown>)}
                  </td>
                  <td className="px-3 py-2">
                    <span
                      className={`rounded px-2 py-0.5 text-[13px] ${
                        STATUS_STYLES[run.status] ?? "bg-gray-700 text-gray-200"
                      }`}
                    >
                      {run.status}
                    </span>
                  </td>
                  <td className="whitespace-nowrap px-3 py-2 text-gray-400">
                    {run.id === best ? (
                      <span className="font-semibold text-green-300" title="Best on this dataset">
                        {score.value}
                      </span>
                    ) : (
                      <span>{score.value}</span>
                    )}{" "}
                    <span className="text-[13px] text-gray-400">{score.label}</span>
                  </td>
                  <td className="whitespace-nowrap px-3 py-2 text-gray-400">
                    {formatDuration(run.started_at ?? null, run.finished_at ?? null, now)}
                  </td>
                  <td className="whitespace-nowrap px-3 py-2 text-gray-400">
                    {new Date(run.created_at).toLocaleDateString()}
                  </td>
                  <td className="whitespace-nowrap px-3 py-2 text-right">
                    <button
                      type="button"
                      className={`mr-2 ${BUTTON}`}
                      aria-label={`Repeat run ${run.id} with changes`}
                      onClick={() => onRepeat(run)}
                    >
                      Repeat
                    </button>
                    <RowMenu run={run} blockReason={blockReason} rowsKey={rowsKey} onDelete={onDelete} />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
