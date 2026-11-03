import { useCallback, useMemo, useRef } from "react";
import { Link, useParams } from "react-router-dom";

import { useDeleteInterval, useReference, useRestoreClean } from "../../entities/useReference";
import { useVideo } from "../../entities/useVideo";
import { TranscodePrompt } from "../media/TranscodePrompt";
import { errorMessage } from "../qc/errorMessage";
import { orphanRows } from "./OrphanedIntervals";
import { ReferenceKeys } from "./ReferenceKeys";
import { ReferenceLanes } from "./ReferenceLanes";
import { ReferenceStatus } from "./ReferenceStatus";
import { toRefAxes, useReferenceEditor } from "./useReferenceEditor";

/** The reference labeling page: the player with a legend, one editable lane
 * per axis under it, and the reference's status. Keyed by video so another
 * video gets a fresh editor (and save queue). */
export function ReferencePage() {
  const params = useParams();
  const parsed = params.videoId ? Number(params.videoId) : Number.NaN;
  const videoId = Number.isFinite(parsed) ? parsed : null;
  return <ReferenceVideoPage key={videoId ?? "invalid"} videoId={videoId} />;
}

function ReferenceVideoPage({ videoId }: { videoId: number | null }) {
  const referenceQuery = useReference(videoId);
  const videoQuery = useVideo(videoId);
  const restore = useRestoreClean(videoId);
  const deleteOrphan = useDeleteInterval(videoId);
  const videoRef = useRef<HTMLVideoElement>(null);

  const reference = referenceQuery.data;
  const video = videoQuery.data;
  const { refetch: refetchVideo } = videoQuery;
  const handleTranscodeComplete = useCallback(() => {
    void refetchVideo();
  }, [refetchVideo]);

  const axes = useMemo(() => (reference ? toRefAxes(reference) : []), [reference]);
  const durationMs = reference?.duration_ms || (video?.duration_seconds ?? 0) * 1000;
  const editor = useReferenceEditor({ videoRef, reference, durationMs });
  const orphaned = useMemo(() => (reference ? orphanRows(reference) : []), [reference]);
  const referenceFailed = videoId === null || referenceQuery.isError;
  const videoFailed = !referenceFailed && videoQuery.isError;
  const loading = !referenceFailed && !videoFailed && (referenceQuery.isPending || videoQuery.isPending);

  return (
    <div className="flex flex-col gap-4 p-6">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold text-gray-100">{video?.title ?? "Video"} · Reference</h1>
        <Link to="/qc" className="text-sm text-blue-400 hover:underline">
          ← Back to QC
        </Link>
      </div>

      {referenceFailed && (
        <p className="text-sm text-red-400">This video&apos;s reference could not be loaded.</p>
      )}
      {videoFailed && <p className="text-sm text-red-400">This video could not be loaded.</p>}
      {loading && <p className="text-sm text-gray-500">Loading…</p>}

      {video?.browser_playable === false && (
        <TranscodePrompt videoId={video.id} onTranscodeComplete={handleTranscodeComplete} />
      )}

      {reference && video && video.browser_playable !== false && (
        <div className="flex flex-col gap-3">
          <div className="bg-black">
            <video ref={videoRef} src={video.stream_url} controls className="mx-auto block max-h-[60vh] w-full" />
          </div>
          {axes.length === 0 ? (
            <p className="text-sm text-gray-400">
              This video has no procedure or its procedure has no frame-classification labels
            </p>
          ) : (
            <>
              <ReferenceKeys axes={axes} onPress={editor.pressClass} />
              <ReferenceLanes
                videoRef={videoRef}
                axes={axes}
                intervals={editor.intervals}
                growing={editor.growing}
                selectedId={editor.selectedId}
                durationMs={durationMs}
                onSelect={editor.select}
                onDragEdge={editor.dragEdge}
                orphaned={orphaned}
                onDeleteOrphan={(id) => deleteOrphan.mutate(id)}
              />
              {deleteOrphan.isError && (
                <p role="alert" className="text-xs text-red-400">
                  {errorMessage(deleteOrphan.error, "The interval could not be deleted.")}
                </p>
              )}
              <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
                <ReferenceStatus
                  status={reference.status}
                  compromisedAt={reference.compromised_at}
                  onRestore={() => restore.mutate()}
                />
                {restore.isError && (
                  <span role="alert" className="text-xs text-red-400">
                    {errorMessage(restore.error, "The reference could not be restored to clean.")}
                  </span>
                )}
                {editor.saveState === "saving" && <span className="text-xs text-gray-400">Saving…</span>}
                {editor.saveState === "error" && (
                  <span role="alert" className="text-xs text-red-400">
                    Not saved: the change was undone.
                  </span>
                )}
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
