import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";

import { useEvaluation } from "../../../entities/useEvaluation";
import { formatClock } from "../analysis/strip";
import { ConfusionMatrix } from "./ConfusionMatrix";
import { formatRatio, sortEpisodes } from "./evaluationLogic";

export interface EvaluationPanelProps {
  runId: number;
  videoId: number;
  /** False when the video has no reference labels: nothing is requested. */
  hasReference: boolean;
  /** Called with the start of a clicked episode, in milliseconds. */
  onSeek: (ms: number) => void;
  /** Notified whenever the boundary tolerance changes, in milliseconds. */
  onBoundaryChange?: (ms: number) => void;
  /** The boundary tolerance the panel starts with, in milliseconds (default 0). */
  initialBoundaryMs?: number;
}

const EPISODE_CAP = 200;

function errorMessage(error: unknown): string {
  const detail = (error as { detail?: unknown } | null)?.detail;
  return typeof detail === "string" ? detail : "Could not score this run.";
}

export function EvaluationPanel({
  runId,
  videoId,
  hasReference,
  onSeek,
  onBoundaryChange,
  initialBoundaryMs = 0,
}: EvaluationPanelProps) {
  const [boundaryMs, setBoundaryMs] = useState(initialBoundaryMs);
  const [draft, setDraft] = useState(String(initialBoundaryMs / 1000));
  const [axisName, setAxisName] = useState<string | null>(null);
  const [sort, setSort] = useState<"longest" | "confident">("longest");
  const [shown, setShown] = useState(EPISODE_CAP);
  const query = useEvaluation(runId, boundaryMs, hasReference);

  const axis = useMemo(() => {
    const axes = query.data?.axes ?? [];
    return axes.find((a) => a.name === axisName) ?? axes[0];
  }, [query.data, axisName]);
  const episodes = useMemo(() => (axis ? sortEpisodes(axis.episodes, sort) : []), [axis, sort]);
  useEffect(() => setShown(EPISODE_CAP), [axis?.name, sort]);

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

  const onTolerance = (text: string) => {
    setDraft(text);
    const seconds = Number(text);
    if (text === "" || !Number.isFinite(seconds) || seconds < 0 || seconds > 60) return;
    const ms = Math.round(seconds * 1000);
    setBoundaryMs(ms);
    onBoundaryChange?.(ms);
  };

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
          max={60}
          step={0.5}
          className="w-16 rounded border border-gray-700 bg-gray-900 px-2 py-1 text-right text-sm text-gray-100"
          value={draft}
          onChange={(e) => onTolerance(e.target.value)}
          onBlur={() => setDraft(String(boundaryMs / 1000))}
        />
      </div>
      {query.isPending && <p className="text-xs text-gray-400">Scoring…</p>}
      {query.isError && (
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
        <>
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
          {episodes.length === 0 ? (
            <p className="text-xs text-gray-400">No error episodes</p>
          ) : (
            <ul className="flex flex-col gap-0.5">
              {episodes.slice(0, shown).map((e) => (
                <li key={`${e.start_ms}-${e.truth}-${e.predicted}`}>
                  <button
                    type="button"
                    onClick={() => onSeek(e.start_ms)}
                    className="w-full rounded px-1 py-0.5 text-left text-xs hover:bg-gray-800"
                  >
                    {formatClock(e.start_ms)} {e.truth} → {e.predicted}, {e.frames}{" "}
                    {e.frames === 1 ? "frame" : "frames"}, {Math.round(e.mean_confidence * 100)}%, {e.kind}
                  </button>
                </li>
              ))}
            </ul>
          )}
          {episodes.length > shown && (
            <button
              type="button"
              onClick={() => setShown((n) => n + EPISODE_CAP)}
              className="rounded border border-gray-700 px-2 py-0.5 text-xs text-gray-300"
            >
              Show more
            </button>
          )}
        </>
      )}
    </section>
  );
}
