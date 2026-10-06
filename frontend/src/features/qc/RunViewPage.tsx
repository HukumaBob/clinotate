import { useCallback, useMemo, useRef } from "react";
import { Link, useParams } from "react-router-dom";

import { useInferenceRun, usePredictions } from "../../entities/useInferenceRuns";
import { useVideo } from "../../entities/useVideo";
import { TranscodePrompt } from "../media/TranscodePrompt";
import { PredictionOverlay } from "./PredictionOverlay";
import {
  DISPLAY_CONFIDENCE_THRESHOLD,
  buildFrameIndex,
  colorForClass,
  countByClass,
} from "./predictions";
import { RunStatus } from "./RunStatus";

export function RunViewPage() {
  const params = useParams();
  const runId = params.runId ? Number(params.runId) : null;
  const runQuery = useInferenceRun(runId);
  const run = runQuery.data ?? null;
  const videoQuery = useVideo(run?.video_id ?? null);
  const predictionsQuery = usePredictions(runId, run?.status === "succeeded");
  const videoRef = useRef<HTMLVideoElement>(null);

  const document = predictionsQuery.data;
  const index = useMemo(() => (document ? buildFrameIndex(document) : null), [document]);
  const counts = useMemo(
    () =>
      document && index
        ? countByClass(index, document.classes.length, DISPLAY_CONFIDENCE_THRESHOLD)
        : [],
    [document, index],
  );

  const video = videoQuery.data;
  const { refetch: refetchVideo } = videoQuery;
  const handleTranscodeComplete = useCallback(() => {
    void refetchVideo();
  }, [refetchVideo]);

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
          <div className="relative flex-1 bg-black">
            <video
              ref={videoRef}
              src={video.stream_url}
              controls
              className="block max-h-[70vh] w-full"
            />
            {index && document && (
              <PredictionOverlay videoRef={videoRef} index={index} classes={document.classes} />
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
          <aside className="w-full shrink-0 rounded border border-gray-800 bg-gray-900 p-4 lg:w-64">
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
            <p className="mt-3 text-xs text-gray-500">
              Showing detections at confidence {DISPLAY_CONFIDENCE_THRESHOLD} and above.
            </p>
          </aside>
        </div>
      )}
    </div>
  );
}
