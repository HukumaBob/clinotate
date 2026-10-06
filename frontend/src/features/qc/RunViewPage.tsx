import { useCallback, useDeferredValue, useEffect, useMemo, useRef } from "react";
import { Link, useParams } from "react-router-dom";

import { useInferenceRun, usePredictions } from "../../entities/useInferenceRuns";
import { useVideo } from "../../entities/useVideo";
import { TranscodePrompt } from "../media/TranscodePrompt";
import { nextEvent, prevEvent } from "./analysis/events";
import { findFlickers, type FlickerEvent } from "./analysis/flicker";
import { useViewParams } from "./analysis/useViewParams";
import { buildView } from "./analysis/view";
import { DisplayPanel } from "./DisplayPanel";
import { EventNav } from "./EventNav";
import { LatencyPanel } from "./LatencyPanel";
import { PredictionOverlay } from "./PredictionOverlay";
import { colorForClass, countByClass } from "./predictions";
import { RunStatus } from "./RunStatus";
import { TimelineStrip } from "./TimelineStrip";

// A stable empty list, so callbacks that depend on `events` keep their identity.
const NO_EVENTS: FlickerEvent[] = [];

function isTypingTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  return !!el && (["INPUT", "TEXTAREA", "SELECT"].includes(el.tagName) || el.isContentEditable);
}

export function RunViewPage() {
  const params = useParams();
  const runId = params.runId ? Number(params.runId) : null;
  const runQuery = useInferenceRun(runId);
  const run = runQuery.data ?? null;
  const videoQuery = useVideo(run?.video_id ?? null);
  const predictionsQuery = usePredictions(runId, run?.status === "succeeded");
  const videoRef = useRef<HTMLVideoElement>(null);

  const [viewParams, setViewParams, resetViewParams] = useViewParams();
  // The sliders stay responsive: the heavy recomputation follows a deferred copy.
  const deferred = useDeferredValue(viewParams);

  const document = predictionsQuery.data;
  const view = useMemo(
    () => (document ? buildView(document, deferred) : null),
    // Only these two change the view; the flicker window must not rebuild it.
    [document, deferred.threshold, deferred.nmsIou],
  );
  const flicker = useMemo(
    () => (document && view ? findFlickers(view, document.classes.length, deferred.flickerN) : null),
    [document, view, deferred.flickerN],
  );
  const counts = useMemo(
    () => (document && view ? countByClass(view, document.classes.length, 0) : []),
    [document, view],
  );

  const video = videoQuery.data;
  const { refetch: refetchVideo } = videoQuery;
  const handleTranscodeComplete = useCallback(() => {
    void refetchVideo();
  }, [refetchVideo]);

  const durationMs = useMemo(() => {
    const lastFrameMs = view ? (view.timestamps[view.timestamps.length - 1] ?? 0) : 0;
    return Math.max((video?.duration_seconds ?? 0) * 1000, lastFrameMs);
  }, [video, view]);

  const seekTo = useCallback((ms: number) => {
    const el = videoRef.current;
    if (el) el.currentTime = ms / 1000;
  }, []);

  const events = flicker?.events ?? NO_EVENTS;
  const jump = useCallback(
    (direction: "prev" | "next") => {
      const el = videoRef.current;
      if (!el || events.length === 0) return;
      const now = el.currentTime * 1000;
      const target = direction === "next" ? nextEvent(events, now) : prevEvent(events, now);
      if (target) seekTo(target.startMs);
    },
    [events, seekTo],
  );

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (isTypingTarget(event.target)) return;
      if (event.key === "[") jump("prev");
      else if (event.key === "]") jump("next");
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [jump]);

  const blinkCount = events.filter((e) => e.kind === "blink").length;
  const dropoutCount = events.length - blinkCount;

  return (
    <div className="flex flex-col gap-4 p-6">
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
        <div className="flex flex-col gap-4 lg:flex-row">
          <div className="flex min-w-0 flex-1 flex-col gap-3">
            <div className="relative bg-black">
              <video
                ref={videoRef}
                src={video.stream_url}
                controls
                className="block max-h-[70vh] w-full"
              />
              {view && document && (
                <PredictionOverlay videoRef={videoRef} index={view} classes={document.classes} />
              )}
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

            {document && view && durationMs > 0 ? (
              <>
                <TimelineStrip
                  videoRef={videoRef}
                  doc={document}
                  threshold={deferred.threshold}
                  events={events}
                  durationMs={durationMs}
                  onSeek={seekTo}
                />
                <EventNav count={events.length} onPrev={() => jump("prev")} onNext={() => jump("next")} />
              </>
            ) : (
              <div aria-hidden="true" className="h-5 rounded bg-gray-800/50" />
            )}
          </div>

          <aside className="flex w-full shrink-0 flex-col gap-5 rounded border border-gray-800 bg-gray-900 p-4 lg:w-72">
            {document && view ? (
              <DisplayPanel
                params={viewParams}
                onChange={setViewParams}
                onReset={resetViewParams}
                blinkCount={blinkCount}
                dropoutCount={dropoutCount}
                isCoarse={flicker?.isCoarse ?? false}
              />
            ) : (
              <p className="text-xs text-gray-500">Display controls appear when predictions load.</p>
            )}

            <section aria-label="Classes">
              <h2 className="mb-2 text-sm font-semibold text-gray-200">Classes</h2>
              {document && document.classes.length > 0 ? (
                <ul className="flex flex-col gap-1 text-sm text-gray-300">
                  {document.classes.map((name, id) => (
                    <li key={id} className="flex items-center justify-between">
                      <span className="flex items-center gap-2">
                        <span
                          className="inline-block h-3 w-3 rounded-sm"
                          style={{ backgroundColor: colorForClass(id) }}
                        />
                        {name}
                      </span>
                      <span className="text-gray-500">{counts[id] ?? 0}</span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-sm text-gray-500">No classes.</p>
              )}
            </section>

            {document && <LatencyPanel timing={document.timing} />}
          </aside>
        </div>
      )}
    </div>
  );
}
