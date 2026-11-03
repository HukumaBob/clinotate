import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";

import { useInferenceRun, usePredictions } from "../../../entities/useInferenceRuns";
import { useVideo } from "../../../entities/useVideo";
import { TranscodePrompt } from "../../media/TranscodePrompt";
import { nextEvent, prevEvent } from "../analysis/events";
import { isCoarseWindow } from "../analysis/flicker";
import { formatClock } from "../analysis/strip";
import { useViewParams } from "../analysis/useViewParams";
import { EventNav } from "../EventNav";
import { eventDirectionFor, isTypingTarget } from "../eventKeys";
import { RunStatus } from "../RunStatus";
import { AxisBadges } from "./AxisBadges";
import { AxisLanes } from "./AxisLanes";
import { buildAxisIndexes } from "./axisIndex";
import { BlipWindowControl } from "./BlipWindowControl";
import { findBlips, mergeBlips, type Blip } from "./blips";
import type { ClassificationDocument } from "./types";
import { useRunEvaluation } from "./useRunEvaluation";
import { useRunReference } from "./useRunReference";
import { WorkingAreaOutline } from "../WorkingAreaOutline";

const NO_BLIPS: Blip[] = [];

/** The run view for a classification run (one with axes): badges over the
 * video, one lane per axis under it, blip navigation. The detection tools
 * (flags, reels, A/B, confidence and NMS) do not apply and are not shown. */
export function ClassificationRunPage() {
  const params = useParams();
  const runId = params.runId ? Number(params.runId) : null;
  const runQuery = useInferenceRun(runId);
  const run = runQuery.data ?? null;
  const videoQuery = useVideo(run?.video_id ?? null);
  const predictionsQuery = usePredictions<ClassificationDocument>(runId, run?.status === "succeeded");
  const videoRef = useRef<HTMLVideoElement>(null);

  // The blip window is the detection view's flicker window, remembered per browser.
  const [viewParams, setViewParams] = useViewParams();
  const blipWindow = useDeferredValue(viewParams.flickerN);

  const document = predictionsQuery.data;
  const indexes = useMemo(() => (document ? buildAxisIndexes(document) : []), [document]);
  const blips = useMemo(
    () => (indexes.length > 0 ? mergeBlips(indexes.map((index, axis) => findBlips(index, axis, blipWindow))) : NO_BLIPS),
    [indexes, blipWindow],
  );
  const isCoarse = useMemo(
    () => (indexes.length > 0 ? isCoarseWindow(indexes[0].timestamps, blipWindow) : false),
    [indexes, blipWindow],
  );

  const [activeBlip, setActiveBlip] = useState<Blip | null>(null);
  // A new window gives a new list: the old current event may be gone.
  useEffect(() => setActiveBlip(null), [blips]);

  const video = videoQuery.data;
  const { refetch: refetchVideo } = videoQuery;
  const handleTranscodeComplete = useCallback(() => {
    void refetchVideo();
  }, [refetchVideo]);

  const durationMs = useMemo(() => {
    const timestamps = indexes[0]?.timestamps ?? [];
    const lastFrameMs = timestamps[timestamps.length - 1] ?? 0;
    return Math.max((video?.duration_seconds ?? 0) * 1000, lastFrameMs);
  }, [video, indexes]);

  const runReference = useRunReference({
    videoRef,
    videoId: run?.video_id ?? null,
    modelAxes: document?.axes,
    durationMs,
  });

  const moveTo = useCallback((ms: number) => {
    const el = videoRef.current;
    if (el) el.currentTime = ms / 1000;
  }, []);
  // A manual seek (lane click) leaves the active blip behind.
  const seekTo = useCallback(
    (ms: number) => {
      moveTo(ms);
      setActiveBlip(null);
    },
    [moveTo],
  );

  const evaluation = useRunEvaluation({
    videoRef,
    runId,
    videoId: run?.video_id ?? null,
    referenceState: runReference.referenceState,
    hasReference: runReference.hasReference,
    modelAxes: document?.axes,
    indexes,
    seekTo,
  });

  const jump = useCallback(
    (direction: "prev" | "next") => {
      const el = videoRef.current;
      if (!el || blips.length === 0) return;
      const now = el.currentTime * 1000;
      const target = direction === "next" ? nextEvent(blips, now) : prevEvent(blips, now);
      if (target) {
        moveTo(target.startMs);
        setActiveBlip(target);
      }
    },
    [blips, moveTo],
  );

  // Scrubbing or playing past the active blip drops the highlight.
  useEffect(() => {
    const el = videoRef.current;
    if (!el || !activeBlip) return;
    const blip = activeBlip;
    function onTime() {
      const now = (el as HTMLVideoElement).currentTime * 1000;
      if (now < blip.startMs - 1 || now >= blip.endMs) setActiveBlip(null);
    }
    el.addEventListener("timeupdate", onTime);
    return () => el.removeEventListener("timeupdate", onTime);
  }, [activeBlip]);

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (isTypingTarget(event.target)) return;
      const direction = eventDirectionFor(event);
      if (direction) jump(direction);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [jump]);

  const activeAxis = activeBlip?.axis ?? null;
  const activeAxisInfo = activeBlip && document ? document.axes[activeBlip.axis] : null;

  return (
    <div className="flex flex-col gap-4 p-6 lg:h-full lg:min-h-0">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold text-gray-100">
          {video?.title ?? "Run"} · {run?.model_name}
        </h1>
        <Link to="/qc" className="text-sm text-blue-400 hover:underline">
          ← Back to QC
        </Link>
      </div>

      {runQuery.isError && <p className="text-sm text-red-400">This run could not be loaded.</p>}

      {run && run.status !== "succeeded" && <RunStatus run={run} />}

      {run?.status === "succeeded" && video?.browser_playable === false && (
        <TranscodePrompt videoId={video.id} onTranscodeComplete={handleTranscodeComplete} />
      )}

      {run?.status === "succeeded" && video && video.browser_playable !== false && (
        <div className="flex flex-col gap-4 lg:min-h-0 lg:flex-1 lg:flex-row">
          <div className="flex min-w-0 flex-1 flex-col gap-3 lg:min-h-0 lg:overflow-y-auto">
            {runReference.banner}
            <div className="relative bg-black lg:min-h-[16rem] lg:flex-1">
              <video
                ref={videoRef}
                src={video.stream_url}
                controls
                className="block max-h-[70vh] w-full lg:absolute lg:inset-0 lg:h-full lg:max-h-none"
              />
              <WorkingAreaOutline videoRef={videoRef} crop={run?.crop_box} />
              {document && <AxisBadges videoRef={videoRef} indexes={indexes} axes={document.axes} />}
              {predictionsQuery.isPending && (
                <p className="absolute left-2 top-2 rounded bg-gray-900/80 px-2 py-1 text-xs text-gray-300">
                  Loading predictions…
                </p>
              )}
              {predictionsQuery.isError && (
                <p className="absolute left-2 top-2 rounded bg-red-900/80 px-2 py-1 text-xs text-red-100">
                  Could not load predictions.
                </p>
              )}
            </div>

            {document && durationMs > 0 ? (
              <>
                {runReference.bar}
                <AxisLanes
                  videoRef={videoRef}
                  axes={document.axes}
                  indexes={indexes}
                  durationMs={durationMs}
                  blips={blips}
                  onSeek={seekTo}
                  activeAxis={activeAxis}
                  reference={runReference.lanes}
                  errorSpans={evaluation.errorSpans}
                />
                <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
                  <EventNav
                    count={blips.length}
                    onPrev={() => jump("prev")}
                    onNext={() => jump("next")}
                    emptyText="No blips at these settings"
                  />
                  {activeBlip && activeAxisInfo && (
                    <span className="text-xs text-gray-400">
                      {`${activeAxisInfo.name} at ${formatClock(activeBlip.startMs)}: ${
                        activeAxisInfo.classes[activeBlip.classId] ?? activeBlip.classId
                      } for ${activeBlip.frames} ${activeBlip.frames === 1 ? "frame" : "frames"} within ${
                        activeAxisInfo.classes[activeBlip.surroundingClassId] ?? activeBlip.surroundingClassId
                      }`}
                    </span>
                  )}
                </div>
              </>
            ) : (
              <div aria-hidden="true" className="h-5 rounded bg-gray-800/50" />
            )}
          </div>

          <aside className="flex w-full shrink-0 flex-col gap-5 rounded border border-gray-800 bg-gray-900 p-4 lg:min-h-0 lg:w-72 lg:overflow-y-auto">
            {document ? (
              <BlipWindowControl
                value={viewParams.flickerN}
                onChange={(flickerN) => setViewParams({ ...viewParams, flickerN })}
                blipCount={blips.length}
                isCoarse={isCoarse}
              />
            ) : (
              predictionsQuery.isPending && (
                <p className="text-xs text-gray-500">Blip controls appear when predictions load.</p>
              )
            )}
            {evaluation.panel}
          </aside>
        </div>
      )}
    </div>
  );
}
