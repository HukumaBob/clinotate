import { type KeyboardEvent, useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";

import { useEvaluation } from "../../../entities/useEvaluation";
import { ConfusionMatrix } from "./ConfusionMatrix";
import { EpisodeCommitDialog } from "./EpisodeCommitDialog";
import { EpisodeList } from "./EpisodeList";
import { episodeKey, selectionSummary } from "./episodeSelection";
import { formatRatio, sortEpisodes } from "./evaluationLogic";

export interface EvaluationPanelProps {
  runId: number;
  videoId: number;
  /** Whether the video's reference has loaded: nothing is requested until it has. */
  referenceState: ReferenceState;
  /** False when the loaded reference has no labels: nothing is requested.
   * Only meaningful when `referenceState` is "ready". */
  hasReference: boolean;
  /** Called with the start of a clicked episode, in milliseconds. */
  onSeek: (ms: number) => void;
  /** Notified whenever the boundary tolerance changes, in milliseconds. */
  onBoundaryChange?: (ms: number) => void;
  /** The boundary tolerance the panel starts with, in milliseconds (default 2000). */
  initialBoundaryMs?: number;
}

export type ReferenceState = "loading" | "error" | "ready";

/** A valid tolerance commits after this pause in typing (or arrow clicks). */
const TOLERANCE_DEBOUNCE_MS = 500;
const MAX_TOLERANCE_S = 60;

/** The tolerance in milliseconds, or null for an empty or out-of-range draft. */
function parseTolerance(text: string): number | null {
  if (text.trim() === "") return null;
  const seconds = Number(text);
  if (!Number.isFinite(seconds) || seconds < 0 || seconds > MAX_TOLERANCE_S) return null;
  return Math.round(Math.min(MAX_TOLERANCE_S, Math.max(0, seconds)) * 1000);
}

function errorMessage(error: unknown): string {
  const detail = (error as { detail?: unknown } | null)?.detail;
  return typeof detail === "string" ? detail : "Could not score this run.";
}

export function EvaluationPanel({
  runId,
  videoId,
  referenceState,
  hasReference,
  onSeek,
  onBoundaryChange,
  initialBoundaryMs = 2000,
}: EvaluationPanelProps) {
  const [boundaryMs, setBoundaryMs] = useState(initialBoundaryMs);
  const [draft, setDraft] = useState(String(initialBoundaryMs / 1000));
  const [axisName, setAxisName] = useState<string | null>(null);
  const [sort, setSort] = useState<"longest" | "confident">("longest");
  const [selection, setSelection] = useState<Set<string>>(() => new Set());
  const [sendKeys, setSendKeys] = useState<string[] | null>(null);
  const scoring = referenceState === "ready" && hasReference;
  const query = useEvaluation(runId, boundaryMs, scoring);

  // The committed tolerance and the latest callback, read from the debounce timer.
  const committed = useRef(initialBoundaryMs);
  const notify = useRef(onBoundaryChange);
  notify.current = onBoundaryChange;
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cancelPending = () => {
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = null;
  };
  useEffect(() => cancelPending, []);

  const commit = (ms: number) => {
    cancelPending();
    if (ms === committed.current) return;
    committed.current = ms;
    setBoundaryMs(ms);
    notify.current?.(ms);
  };
  const onToleranceChange = (text: string) => {
    setDraft(text);
    cancelPending();
    const ms = parseTolerance(text);
    if (ms !== null) timer.current = setTimeout(() => commit(ms), TOLERANCE_DEBOUNCE_MS);
  };
  /** Blur or Enter: a valid draft commits now, anything else reverts. */
  const finishTolerance = (text: string) => {
    const ms = parseTolerance(text);
    if (ms === null) {
      cancelPending();
      setDraft(String(committed.current / 1000));
      return;
    }
    commit(ms);
    setDraft(String(ms / 1000));
  };
  const onToleranceKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") finishTolerance(e.currentTarget.value);
  };

  const axis = useMemo(() => {
    const axes = query.data?.axes ?? [];
    return axes.find((a) => a.name === axisName) ?? axes[0];
  }, [query.data, axisName]);
  const episodes = useMemo(() => (axis ? sortEpisodes(axis.episodes, sort) : []), [axis, sort]);

  // A new run starts with nothing selected.
  useEffect(() => setSelection((prev) => (prev.size === 0 ? prev : new Set())), [runId]);
  // An evaluation that changes under the user must not leave ghost keys behind.
  const loaded = query.data;
  useEffect(() => {
    if (!loaded) return;
    const present = new Set(loaded.axes.flatMap((a) => a.episodes.map((e) => episodeKey(a.name, e))));
    setSelection((prev) => {
      const kept = [...prev].filter((k) => present.has(k));
      return kept.length === prev.size ? prev : new Set(kept);
    });
  }, [loaded]);
  const summary = useMemo(
    () =>
      selectionSummary(
        [...selection],
        Object.fromEntries((loaded?.axes ?? []).map((a) => [a.name, a.episodes])),
      ),
    [selection, loaded],
  );

  if (referenceState === "loading") {
    return (
      <section aria-label="Evaluation" className="flex flex-col gap-2 text-sm text-gray-300">
        <h2 className="text-sm font-semibold text-gray-200">Evaluation</h2>
        <p className="text-xs text-gray-400">Loading…</p>
      </section>
    );
  }
  if (referenceState === "error") {
    return (
      <section aria-label="Evaluation" className="flex flex-col gap-2 text-sm text-gray-300">
        <h2 className="text-sm font-semibold text-gray-200">Evaluation</h2>
        <p className="text-xs text-gray-400">The reference could not be loaded.</p>
      </section>
    );
  }
  if (!hasReference) {
    return (
      <section aria-label="Evaluation" className="flex flex-col gap-2 text-sm text-gray-300">
        <h2 className="text-sm font-semibold text-gray-200">Evaluation</h2>
        <p className="text-xs text-gray-400">Label this video's reference to score the model</p>
        <Link to={`/qc/reference/${videoId}`} className="text-xs text-blue-400 hover:underline">
          Open the reference editor
        </Link>
      </section>
    );
  }

  const t = axis?.transitions;
  return (
    <section aria-label="Evaluation" className="flex flex-col gap-3 text-sm text-gray-300">
      <h2 className="text-sm font-semibold text-gray-200">Evaluation</h2>
      <div className="flex items-center justify-between gap-2">
        <label htmlFor="qc-eval-boundary">Boundary tolerance (s)</label>
        <input
          id="qc-eval-boundary"
          type="number"
          min={0}
          max={MAX_TOLERANCE_S}
          step={0.5}
          className="w-16 rounded border border-gray-700 bg-gray-900 px-2 py-1 text-right text-sm text-gray-100"
          value={draft}
          onChange={(e) => onToleranceChange(e.target.value)}
          onBlur={(e) => finishTolerance(e.currentTarget.value)}
          onKeyDown={onToleranceKey}
        />
      </div>
      {query.isPending && <p className="text-xs text-gray-400">Scoring…</p>}
      {query.isError && query.data && (
        <p role="alert" className="text-xs text-red-300">
          Could not refresh the scores.
        </p>
      )}
      {query.isError && !query.data && (
        <p role="alert" className="rounded border border-red-700 bg-red-950 px-2 py-1 text-xs text-red-200">
          {errorMessage(query.error)}
        </p>
      )}
      {query.data && query.data.reference_status === "compromised" && (
        <p role="note" className="rounded border border-yellow-700 bg-yellow-950 px-2 py-1 text-xs text-yellow-200">
          These scores are optimistic: frames of this video were used for training.
        </p>
      )}
      {query.data && axis && t && (
        <div
          aria-busy={Boolean(query.isPlaceholderData)}
          className={`flex flex-col gap-3 ${
            query.isPlaceholderData || query.isError ? "opacity-60" : ""
          }`}
        >
          <div className="flex items-center justify-between gap-2">
            <label htmlFor="qc-eval-axis">Axis</label>
            <select
              id="qc-eval-axis"
              className="min-w-0 rounded border border-gray-700 bg-gray-900 px-2 py-1 text-sm text-gray-100"
              value={axis.name}
              onChange={(e) => setAxisName(e.target.value)}
            >
              {query.data.axes.map((a) => (
                <option key={a.name} value={a.name}>{a.name}</option>
              ))}
            </select>
          </div>
          {!axis.matched && (
            <p role="note" className="rounded border border-yellow-700 bg-yellow-950 px-2 py-1 text-xs text-yellow-200">
              This axis has no matching reference axis.
            </p>
          )}
          {axis.matched && axis.frames_evaluated === 0 && (
            <p role="note" className="rounded border border-yellow-700 bg-yellow-950 px-2 py-1 text-xs text-yellow-200">
              No reference intervals on this axis.
            </p>
          )}
          <dl className="grid grid-cols-2 gap-x-2 text-xs">
            <dt className="text-gray-400">Accuracy</dt>
            <dd className="text-right tabular-nums">{formatRatio(axis.accuracy)}</dd>
            <dt className="text-gray-400">Macro F1</dt>
            <dd className="text-right tabular-nums">{formatRatio(axis.macro_f1)}</dd>
          </dl>
          <p className="text-xs text-gray-400">
            {axis.frames_evaluated} evaluated, {axis.frames_excluded} excluded of {axis.frames_total} frames
          </p>
          <p className="text-xs text-gray-400">
            Errors: {axis.errors.boundary_frames} at boundaries, {axis.errors.interior_frames} inside
          </p>
          <p className="text-xs text-gray-400">
            {t.model_switches} model switches vs {t.reference} in the reference ({t.excess_switches} excess)
          </p>
          <p className="text-xs text-gray-400">
            {t.median_lag_ms === null ? "No median lag" : `Median lag ${(t.median_lag_ms / 1000).toFixed(1)} s`}
            {t.never_switched > 0 && `, ${t.never_switched} never switched`}
          </p>
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-xs">
              <thead>
                <tr className="text-gray-500">
                  <th scope="col" className="text-left font-normal">Class</th>
                  <th scope="col" className="text-right font-normal">N</th>
                  <th scope="col" className="text-right font-normal">Prec</th>
                  <th scope="col" className="text-right font-normal">Rec</th>
                  <th scope="col" className="text-right font-normal">F1</th>
                </tr>
              </thead>
              <tbody>
                {axis.classes.map((c) => (
                  <tr key={c.name}>
                    <th scope="row" className="text-left font-normal">{c.name}</th>
                    <td className="text-right tabular-nums">{c.support}</td>
                    <td className="text-right tabular-nums">{formatRatio(c.precision)}</td>
                    <td className="text-right tabular-nums">{formatRatio(c.recall)}</td>
                    <td className="text-right tabular-nums">{formatRatio(c.f1)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <ConfusionMatrix labels={axis.confusion.labels} matrix={axis.confusion.matrix} />
          <div className="flex gap-1" role="group" aria-label="Sort episodes">
            {(["longest", "confident"] as const).map((mode) => (
              <button
                key={mode}
                type="button"
                aria-pressed={sort === mode}
                onClick={() => setSort(mode)}
                className={`rounded border px-2 py-0.5 text-xs ${
                  sort === mode ? "border-blue-500 bg-blue-950 text-blue-200" : "border-gray-700 text-gray-300"
                }`}
              >
                {mode === "longest" ? "Longest first" : "Most confident first"}
              </button>
            ))}
          </div>
          <EpisodeList
            axisName={axis.name}
            episodes={episodes}
            selection={selection}
            onSelectionChange={setSelection}
            onSeek={onSeek}
            summary={summary}
            onSend={setSendKeys}
          />
        </div>
      )}
      {sendKeys !== null && (
        <EpisodeCommitDialog
          runId={runId}
          videoId={videoId}
          keys={sendKeys}
          referenceStatus={query.data?.reference_status}
          onClose={() => setSendKeys(null)}
          onCommitted={() => setSelection(new Set())}
        />
      )}
    </section>
  );
}
