import { useEffect, useMemo, useRef, useState } from "react";
import { useParams } from "react-router-dom";

import { useInferenceRun, usePredictions } from "../../entities/useInferenceRuns";
import { useQcCompare } from "../../entities/useQcCompare";
import { usePutQcFlag, useQcFlags } from "../../entities/useQcFlags";
import { useVideo } from "../../entities/useVideo";
import { flagKindForWrongSide, nextDisagreement } from "./compareLogic";
import { filterByConfidence } from "./confidenceFilter";
import { errorMessage } from "./errorMessage";
import { PredictionOverlay } from "./PredictionOverlay";
import { buildFrameIndex, DISPLAY_CONFIDENCE_THRESHOLD, type PredictionsDocument } from "./predictions";
import { useSyncedVideos } from "./useSyncedVideos";
import { useVideoClock } from "./useVideoClock";

const BUTTON =
  "rounded border border-gray-700 px-2 py-1 text-xs text-gray-300 hover:text-gray-100 disabled:opacity-50";

interface SideProps {
  title: string;
  run: { model_name: string; perturbation?: { kind: string; strength: number } | null } | undefined;
  streamUrl: string | undefined;
  videoRef: React.RefObject<HTMLVideoElement | null>;
  controls: boolean;
  doc: PredictionsDocument | undefined;
  confidence: number;
  onConfidence: (value: number) => void;
}

function Side({ title, run, streamUrl, videoRef, controls, doc, confidence, onConfidence }: SideProps) {
  const index = useMemo(() => (doc ? buildFrameIndex(filterByConfidence(doc, confidence)) : null), [doc, confidence]);
  return (
    <div className="flex min-w-0 flex-1 flex-col gap-2">
      <div className="flex items-center gap-2 text-sm text-gray-200">
        <span className="font-semibold">{title}</span>
        <span className="text-gray-400">{run?.model_name}</span>
        {run?.perturbation && (
          <span className="rounded bg-amber-900/50 px-1.5 py-0.5 text-xs text-amber-200">
            {`Stress: ${run.perturbation.kind} ${run.perturbation.strength}`}
          </span>
        )}
      </div>
      <div className="relative bg-black">
        <video ref={videoRef} src={streamUrl} controls={controls} className="block max-h-[60vh] w-full" />
        {index && doc && <PredictionOverlay videoRef={videoRef} index={index} classes={doc.classes} />}
      </div>
      <label className="flex items-center gap-2 text-xs text-gray-400">
        {`Confidence ${title}`}
        <input
          type="range"
          min={0}
          max={1}
          step={0.01}
          value={confidence}
          onChange={(e) => onConfidence(Number(e.target.value))}
        />
        <span>{confidence.toFixed(2)}</span>
      </label>
    </div>
  );
}

export function AbComparePage() {
  const params = useParams();
  const runIdA = params.runA ? Number(params.runA) : null;
  const runIdB = params.runB ? Number(params.runB) : null;
  const runA = useInferenceRun(runIdA).data;
  const runB = useInferenceRun(runIdB).data;
  const video = useVideo(runA?.video_id ?? null).data;
  const docA = usePredictions(runIdA, runA?.status === "succeeded").data;
  const docB = usePredictions(runIdB, runB?.status === "succeeded").data;

  const [confA, setConfA] = useState(DISPLAY_CONFIDENCE_THRESHOLD);
  const [confB, setConfB] = useState(DISPLAY_CONFIDENCE_THRESHOLD);
  const compare = useQcCompare(runIdA, runIdB, confA, confB);
  const flagsA = useQcFlags(runIdA).data ?? [];
  const flagsB = useQcFlags(runIdB).data ?? [];
  const putA = usePutQcFlag(runIdA);
  const putB = usePutQcFlag(runIdB);

  const videoARef = useRef<HTMLVideoElement>(null);
  const videoBRef = useRef<HTMLVideoElement>(null);
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  useSyncedVideos(videoARef, videoBRef);
  const currentMs = useVideoClock(videoARef);

  const frames = compare.data?.frames ?? [];
  const times = frames.map((f) => f.timestamp_ms);
  // A disagreement applies until the next processed frame is shown.
  const windowMs = Math.max(40, ((runA?.frame_stride ?? 1) / (docA?.fps || 25)) * 1000);
  const current =
    [...frames].reverse().find((f) => f.timestamp_ms <= currentMs && currentMs - f.timestamp_ms < windowMs) ?? null;

  function seek(direction: 1 | -1) {
    const target = nextDisagreement(times, currentMs, direction);
    if (target !== null && videoARef.current) videoARef.current.currentTime = target / 1000;
  }

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      const target = event.target as HTMLElement | null;
      if (target && ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName)) return;
      if (event.key === "]") seek(1);
      if (event.key === "[") seek(-1);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  if (compare.error) {
    return (
      <div className="p-6">
        <p role="alert" className="text-sm text-red-400">
          {errorMessage(compare.error, "Could not compare these runs")}
        </p>
      </div>
    );
  }

  const durationMs = (video?.duration_seconds ?? 0) * 1000;
  const flagNote = (frameIndex: number) =>
    [
      ["A", flagsA],
      ["B", flagsB],
    ]
      .map(([label, flags]) => {
        const flag = (flags as typeof flagsA).find((f) => f.frame_index === frameIndex);
        return flag ? `Flagged ${flag.kind.toUpperCase()} on ${label}` : null;
      })
      .filter(Boolean)
      .join(" · ");

  function flag(side: "a" | "b") {
    if (!current) return;
    const mutate = side === "a" ? putA.mutate : putB.mutate;
    mutate({
      frame_index: current.frame,
      timestamp_ms: current.timestamp_ms,
      kind: flagKindForWrongSide(side, current),
    });
  }

  return (
    <div className="flex flex-col gap-4 p-6">
      <h1 className="text-xl font-semibold text-gray-100">Compare runs</h1>
      <p className="text-sm text-gray-300">
        {compare.data
          ? `${compare.data.disagreements} disagreements out of ${compare.data.total} frames`
          : "Comparing…"}
      </p>
      <div className="flex flex-col gap-4 lg:flex-row">
        <Side
          title="A"
          run={runA}
          streamUrl={video?.stream_url}
          videoRef={videoARef}
          controls
          doc={docA}
          confidence={confA}
          onConfidence={setConfA}
        />
        <Side
          title="B"
          run={runB}
          streamUrl={video?.stream_url}
          videoRef={videoBRef}
          controls={false}
          doc={docB}
          confidence={confB}
          onConfidence={setConfB}
        />
      </div>

      {durationMs > 0 && mounted && (
        <div className="relative h-3 rounded bg-gray-800" aria-hidden="true">
          {times.map((t) => (
            <span
              key={t}
              className="absolute top-0 h-3 w-0.5 bg-amber-400"
              style={{ left: `${Math.min(Math.max(t / durationMs, 0), 1) * 100}%` }}
            />
          ))}
          <span
            className="absolute top-0 h-3 w-0.5 bg-blue-400"
            style={{ left: `${Math.min(Math.max(currentMs / durationMs, 0), 1) * 100}%` }}
          />
        </div>
      )}

      <div className="flex items-center gap-2">
        <button type="button" className={BUTTON} disabled={frames.length === 0} onClick={() => seek(-1)} title="Previous disagreement ([)">
          Previous disagreement
        </button>
        <button type="button" className={BUTTON} disabled={frames.length === 0} onClick={() => seek(1)} title="Next disagreement (])">
          Next disagreement
        </button>
        {compare.data && frames.length === 0 && (
          <span className="text-xs text-gray-500">The runs agree on every frame at these settings</span>
        )}
      </div>

      {current && (
        <div className="flex flex-col gap-2 rounded border border-gray-800 bg-gray-900 p-3 text-sm text-gray-200">
          <div>
            {current.only_a.length > 0 && <div>{`Only A: ${current.only_a.join(", ")}`}</div>}
            {current.only_b.length > 0 && <div>{`Only B: ${current.only_b.join(", ")}`}</div>}
          </div>
          <div className="flex items-center gap-2">
            <button type="button" className={BUTTON} disabled={putA.isPending} onClick={() => flag("a")}>
              A wrong
            </button>
            <button type="button" className={BUTTON} disabled={putB.isPending} onClick={() => flag("b")}>
              B wrong
            </button>
            <span role="status" className="text-xs text-gray-400">
              {flagNote(current.frame)}
            </span>
          </div>
          {(putA.error || putB.error) && (
            <p role="alert" className="text-xs text-red-400">
              {errorMessage(putA.error ?? putB.error, "Could not save the flag")}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
