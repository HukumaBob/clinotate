import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";

import { useInferenceRun, usePredictions } from "../../entities/useInferenceRuns";
import {
  useCommitQcFlags,
  useDeleteQcFlag,
  usePutQcFlag,
  useQcFlags,
  useVideoSent,
  type QcFlag,
  type QcFlagKind,
} from "../../entities/useQcFlags";
import { useVideo } from "../../entities/useVideo";
import { TranscodePrompt } from "../media/TranscodePrompt";
import { nextEvent, prevEvent } from "./analysis/events";
import { findFlickers, type FlickerEvent } from "./analysis/flicker";
import { useViewParams } from "./analysis/useViewParams";
import { buildView } from "./analysis/view";
import { formatClock } from "./analysis/strip";
import { CommitDialog } from "./CommitDialog";
import { DisplayPanel } from "./DisplayPanel";
import { EventNav } from "./EventNav";
import { errorMessage } from "./errorMessage";
import { eventDirectionFor, flagKindFor, isTypingTarget } from "./eventKeys";
import { FlagButtons } from "./FlagButtons";
import { localIsoDate } from "./localDate";
import { FlagsPanel } from "./FlagsPanel";
import { decideFlagAction } from "./flagDecision";
import { LatencyPanel } from "./LatencyPanel";
import { PredictionOverlay } from "./PredictionOverlay";
import { buildProcessedFrames, processedFrameAt } from "./processedFrame";
import { colorForClass, countByClass } from "./predictions";
import { RunStatus } from "./RunStatus";
import { TimelineStrip } from "./TimelineStrip";

// A stable empty list, so callbacks that depend on `events` keep their identity.
const NO_EVENTS: FlickerEvent[] = [];
const NO_FLAGS: QcFlag[] = [];

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

  const succeeded = run?.status === "succeeded";
  const flagsQuery = useQcFlags(succeeded ? runId : null);
  const flags = flagsQuery.data ?? NO_FLAGS;
  const putFlag = usePutQcFlag(runId);
  const deleteFlag = useDeleteQcFlag(runId);
  const commit = useCommitQcFlags(runId, run?.video_id ?? null);
  const sentQuery = useVideoSent(succeeded ? (run?.video_id ?? null) : null);
  const processedFrames = useMemo(
    () => (document ? buildProcessedFrames(document) : []),
    [document],
  );
  const [snapNote, setSnapNote] = useState<string | null>(null);
  const [flagError, setFlagError] = useState<string | null>(null);
  const [commitOpen, setCommitOpen] = useState(false);
  const [lastSequence, setLastSequence] = useState<{ id: number; name: string } | null>(null);

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

  const { mutate: putFlagMutate } = putFlag;
  const { mutate: deleteFlagMutate } = deleteFlag;
  const flagFrame = useCallback(
    (kind: QcFlagKind) => {
      const el = videoRef.current;
      if (!el || processedFrames.length === 0) return;
      const frame = processedFrameAt(processedFrames, el.currentTime * 1000);
      if (!frame) {
        setSnapNote("No processed frame at this time");
        return;
      }
      // Pause and snap to the frame the overlay shows, so what is flagged is
      // exactly what the model saw.
      el.pause();
      el.currentTime = frame.timestampMs / 1000;
      setSnapNote(`Snapped to processed frame ${formatClock(frame.timestampMs)}`);
      setFlagError(null);

      const existing = flags.find((f) => f.frame_index === frame.frameIndex);
      const action = decideFlagAction(
        existing ? { kind: existing.kind, committed: existing.committed_at !== null } : undefined,
        kind,
      );
      const onError = (error: unknown) =>
        setFlagError(errorMessage(error, "Could not save the flag"));
      if (action === "blocked") {
        setFlagError("This frame was already sent to training");
      } else if (action === "remove" && existing) {
        deleteFlagMutate(existing.id, { onError });
      } else {
        putFlagMutate(
          {
            frame_index: frame.frameIndex,
            timestamp_ms: frame.timestampMs,
            kind,
            // No note: the server keeps the stored one, so a kind change
            // cannot overwrite a note saved a moment ago.
          },
          { onError },
        );
      }
    },
    [processedFrames, flags, putFlagMutate, deleteFlagMutate],
  );

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (commitOpen || isTypingTarget(event.target)) return;
      const direction = eventDirectionFor(event);
      if (direction) {
        jump(direction);
        return;
      }
      // A held flag key must not toggle the flag repeatedly.
      if (event.repeat) return;
      const kind = flagKindFor(event);
      if (kind) flagFrame(kind);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [jump, flagFrame, commitOpen]);

  const blinkCount = events.filter((e) => e.kind === "blink").length;
  const dropoutCount = events.length - blinkCount;

  const pendingFlags = flags.filter((f) => f.committed_at === null);
  const fpCount = pendingFlags.filter((f) => f.kind === "fp").length;
  const fnCount = pendingFlags.length - fpCount;
  const defaultSequenceName = `QC · ${video?.title ?? "video"} · run #${runId} · ${localIsoDate(new Date())}`;
  const sent = sentQuery.data;

  const handleNoteChange = (flag: QcFlag, note: string) =>
    putFlagMutate(
      { frame_index: flag.frame_index, timestamp_ms: flag.timestamp_ms, kind: flag.kind, note: note || null },
      { onError: (error) => setFlagError(errorMessage(error, "Could not save the note")) },
    );
  const openCommit = () => {
    commit.reset();
    setCommitOpen(true);
  };
  const handleConfirm = (name: string) =>
    commit.mutate(
      { name },
      {
        onSuccess: (sequence) => {
          setCommitOpen(false);
          if (sequence) setLastSequence({ id: sequence.id, name: sequence.name });
        },
      },
    );

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

      {sent && sent.frames > 0 && (
        <p className="rounded border border-yellow-700 bg-yellow-950 px-2 py-1 text-xs text-yellow-200">
          {`${sent.frames} ${sent.frames === 1 ? "frame" : "frames"} of this video ${
            sent.frames === 1 ? "was" : "were"
          } sent to training, so it is no longer an unbiased test.`}
        </p>
      )}

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
                  flags={flags}
                  durationMs={durationMs}
                  onSeek={seekTo}
                />
                <EventNav count={events.length} onPrev={() => jump("prev")} onNext={() => jump("next")} />
                <FlagButtons
                  disabled={processedFrames.length === 0}
                  onFlag={flagFrame}
                  snapNote={snapNote}
                  error={flagError}
                />
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
              predictionsQuery.isPending && (
                <p className="text-xs text-gray-500">Display controls appear when predictions load.</p>
              )
            )}

            {document && (
              <FlagsPanel
                flags={flags}
                loadFailed={flagsQuery.isError}
                onRetry={() => void flagsQuery.refetch()}
                onSeek={seekTo}
                onRemove={(id) =>
                  deleteFlagMutate(id, {
                    onError: (error) => setFlagError(errorMessage(error, "Could not remove the flag")),
                  })
                }
                onNoteChange={handleNoteChange}
                onSend={openCommit}
                lastSequence={lastSequence}
              />
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

      {commitOpen && (
        <CommitDialog
          fpCount={fpCount}
          fnCount={fnCount}
          defaultName={defaultSequenceName}
          error={commit.error ? errorMessage(commit.error, "Could not create the sequence, nothing was changed") : null}
          submitting={commit.isPending}
          onConfirm={handleConfirm}
          onCancel={() => setCommitOpen(false)}
        />
      )}
    </div>
  );
}
