import { useRef, useState } from "react";

import { useVideoSequences } from "../../entities/useSequences";
import { useVideo } from "../../entities/useVideo";
import { RecutSequenceForm } from "./RecutSequenceForm";
import { RenameSequenceForm } from "./RenameSequenceForm";
import { SequenceFromMarksForm } from "./SequenceFromMarksForm";
import { SequenceTimeline } from "./SequenceTimeline";
import { TranscodePrompt } from "./TranscodePrompt";

export function VideoReviewPlayer({
  videoId,
  onBack,
  onOpenSequence,
}: {
  videoId: number;
  onBack: () => void;
  onOpenSequence: (sequenceId: number) => void;
}) {
  const videoQuery = useVideo(videoId);
  const sequencesQuery = useVideoSequences(videoId);
  const videoRef = useRef<HTMLVideoElement>(null);
  const [markStart, setMarkStart] = useState<number | null>(null);
  const [markEnd, setMarkEnd] = useState<number | null>(null);
  const [videoReady, setVideoReady] = useState(false);
  const [renamingSequenceId, setRenamingSequenceId] = useState<number | null>(null);
  const [recuttingSequenceId, setRecuttingSequenceId] = useState<number | null>(null);

  function handleMarkStart() {
    if (videoRef.current) setMarkStart(videoRef.current.currentTime);
  }

  function handleMarkEnd() {
    if (videoRef.current) setMarkEnd(videoRef.current.currentTime);
  }

  function handleRenameSequence(sequenceId: number) {
    setRecuttingSequenceId(null);
    setRenamingSequenceId(sequenceId);
  }

  function handleRecutSequence(sequenceId: number) {
    setRenamingSequenceId(null);
    setRecuttingSequenceId(sequenceId);
    const target = sequencesQuery.data?.find((s) => s.id === sequenceId);
    if (target) {
      setMarkStart(target.start_time);
      setMarkEnd(target.start_time + target.duration);
    }
  }

  function handleEditDone() {
    setRenamingSequenceId(null);
    setRecuttingSequenceId(null);
    setMarkStart(null);
    setMarkEnd(null);
    sequencesQuery.refetch();
  }

  function handleCreated() {
    setMarkStart(null);
    setMarkEnd(null);
    sequencesQuery.refetch();
  }

  const video = videoQuery.data;

  return (
    <div className="flex flex-col gap-4 rounded border border-gray-800 bg-gray-900 p-4">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-medium text-gray-100">{video?.title ?? "Video"}</h2>
        <button type="button" onClick={onBack} className="text-sm text-blue-400 hover:underline">
          ← Upload another video
        </button>
      </div>

      {video?.browser_playable === false ? (
        <TranscodePrompt videoId={videoId} onTranscodeComplete={() => videoQuery.refetch()} />
      ) : video ? (
        <>
          <video
            ref={videoRef}
            src={video.stream_url}
            controls
            className="max-h-[40vh] w-full rounded bg-black"
            onLoadedMetadata={() => setVideoReady(true)}
          />
          <SequenceTimeline
            durationSeconds={video.duration_seconds}
            sequences={sequencesQuery.data ?? []}
            markStart={markStart}
            markEnd={markEnd}
            onMarkStart={handleMarkStart}
            onMarkEnd={handleMarkEnd}
            onOpenSequence={onOpenSequence}
            onRenameSequence={handleRenameSequence}
            onRecutSequence={handleRecutSequence}
            markStartDisabled={!videoReady}
            markEndDisabled={!videoReady}
          />
          {renamingSequenceId !== null && (() => {
            const target = sequencesQuery.data?.find((s) => s.id === renamingSequenceId);
            return target ? (
              <RenameSequenceForm sequence={target} onDone={handleEditDone} />
            ) : null;
          })()}
          {recuttingSequenceId !== null && markStart !== null && markEnd !== null && (() => {
            const target = sequencesQuery.data?.find((s) => s.id === recuttingSequenceId);
            return target ? (
              <RecutSequenceForm
                sequence={target}
                markStart={markStart}
                markEnd={markEnd}
                onDone={handleEditDone}
              />
            ) : null;
          })()}
          {recuttingSequenceId === null && markStart !== null && markEnd !== null && markEnd !== markStart && (
            <SequenceFromMarksForm
              videoId={videoId}
              markStart={markStart}
              markEnd={markEnd}
              procedureId={video.procedure_id ?? undefined}
              onCreated={handleCreated}
            />
          )}
          {recuttingSequenceId === null && markStart !== null && markEnd !== null && markEnd === markStart && (
            <p className="text-sm text-red-400">Start and end can&apos;t be the same point.</p>
          )}
        </>
      ) : null}
    </div>
  );
}
