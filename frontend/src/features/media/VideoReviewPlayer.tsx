import { useCallback, useEffect, useRef, useState } from "react";

import { useVideoSequences } from "../../entities/useSequences";
import { useVideo } from "../../entities/useVideo";
import { computeVideoMediaRect } from "./computeVideoMediaRect";
import type { Crop } from "./CropFields";
import { CropOverlay } from "./CropOverlay";
import { formatTimestamp } from "./formatTimestamp";
import { SequenceForm } from "./SequenceForm";
import { SequenceTimeline } from "./SequenceTimeline";
import { TranscodePrompt } from "./TranscodePrompt";

function marksStorageKey(videoId: number): string {
  return `video-marks-${videoId}`;
}

function loadStoredMarks(videoId: number): { markStart: number | null; markEnd: number | null } {
  try {
    const raw = localStorage.getItem(marksStorageKey(videoId));
    if (!raw) return { markStart: null, markEnd: null };
    const parsed = JSON.parse(raw) as { markStart: number | null; markEnd: number | null };
    return { markStart: parsed.markStart ?? null, markEnd: parsed.markEnd ?? null };
  } catch {
    return { markStart: null, markEnd: null };
  }
}

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
  const [markStart, setMarkStart] = useState<number | null>(() => loadStoredMarks(videoId).markStart);
  const [markEnd, setMarkEnd] = useState<number | null>(() => loadStoredMarks(videoId).markEnd);
  const [videoReady, setVideoReady] = useState(false);
  const [videoHovered, setVideoHovered] = useState(false);
  const [editingSequenceId, setEditingSequenceId] = useState<number | null>(null);
  const [activeCrop, setActiveCrop] = useState<Crop | null>(null);
  const [mediaRect, setMediaRect] = useState<{ left: number; top: number; width: number; height: number } | null>(
    null
  );

  const recomputeMediaRect = useCallback(() => {
    const el = videoRef.current;
    if (!el) return;
    setMediaRect(computeVideoMediaRect(el.videoWidth, el.videoHeight, el.clientWidth, el.clientHeight));
  }, []);

  useEffect(() => {
    window.addEventListener("resize", recomputeMediaRect);
    return () => window.removeEventListener("resize", recomputeMediaRect);
  }, [recomputeMediaRect]);

  useEffect(() => {
    if (markStart === null && markEnd === null) {
      localStorage.removeItem(marksStorageKey(videoId));
      return;
    }
    localStorage.setItem(marksStorageKey(videoId), JSON.stringify({ markStart, markEnd }));
  }, [videoId, markStart, markEnd]);

  function handleMarkStart() {
    if (videoRef.current) setMarkStart(videoRef.current.currentTime);
  }

  function handleMarkEnd() {
    if (videoRef.current) setMarkEnd(videoRef.current.currentTime);
  }

  function handleSegmentClick(sequenceId: number, startTime: number, endTime: number) {
    setEditingSequenceId(sequenceId);
    setMarkStart(startTime);
    setMarkEnd(endTime);
  }

  function handleEmptyBackgroundClick() {
    setEditingSequenceId(null);
  }

  function handleEditDone() {
    setEditingSequenceId(null);
    setMarkStart(null);
    setMarkEnd(null);
    setActiveCrop(null);
    sequencesQuery.refetch();
  }

  function handleCreated() {
    setMarkStart(null);
    setMarkEnd(null);
    setActiveCrop(null);
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
          <div className="flex flex-col gap-4 lg:flex-row">
            <div
              className="relative min-w-0 flex-[2]"
              onMouseEnter={() => setVideoHovered(true)}
              onMouseLeave={() => setVideoHovered(false)}
            >
              <video
                ref={videoRef}
                src={video.stream_url}
                controls={videoHovered}
                className="max-h-[40vh] w-full rounded bg-black"
                onLoadedMetadata={() => {
                  setVideoReady(true);
                  recomputeMediaRect();
                }}
              />
              {activeCrop !== null && (
                <CropOverlay crop={activeCrop} mediaRect={mediaRect ?? undefined} />
              )}
            </div>
            <div className="flex min-w-0 flex-[3] flex-col gap-3 rounded border border-gray-800 bg-gray-950 p-3">
              <div className="flex gap-3">
                <div className="flex flex-col items-start gap-1">
                  <button
                    type="button"
                    onClick={handleMarkStart}
                    disabled={!videoReady}
                    className="rounded border border-gray-700 px-3 py-1 text-sm hover:bg-gray-800 disabled:opacity-50"
                  >
                    Mark start
                  </button>
                  <span className="text-xs text-gray-400">
                    {markStart !== null ? formatTimestamp(markStart) : "—"}
                  </span>
                </div>
                <div className="flex flex-col items-start gap-1">
                  <button
                    type="button"
                    onClick={handleMarkEnd}
                    disabled={!videoReady}
                    className="rounded border border-gray-700 px-3 py-1 text-sm hover:bg-gray-800 disabled:opacity-50"
                  >
                    Mark end
                  </button>
                  <span className="text-xs text-gray-400">
                    {markEnd !== null ? formatTimestamp(markEnd) : "—"}
                  </span>
                </div>
              </div>
              {editingSequenceId !== null && markStart !== null && markEnd !== null && (() => {
                const target = sequencesQuery.data?.find((s) => s.id === editingSequenceId);
                return target ? (
                  <SequenceForm
                    sequence={target}
                    videoId={videoId}
                    markStart={markStart}
                    markEnd={markEnd}
                    existingSequences={sequencesQuery.data ?? []}
                    onCropChange={setActiveCrop}
                    onDone={handleEditDone}
                    onOpenEditor={onOpenSequence}
                  />
                ) : null;
              })()}
              {editingSequenceId === null && markStart !== null && markEnd !== null && markEnd !== markStart && (
                <SequenceForm
                  videoId={videoId}
                  markStart={markStart}
                  markEnd={markEnd}
                  procedureId={video.procedure_id ?? undefined}
                  existingSequences={sequencesQuery.data ?? []}
                  onCropChange={setActiveCrop}
                  onDone={handleCreated}
                />
              )}
              {editingSequenceId === null && markStart !== null && markEnd !== null && markEnd === markStart && (
                <p className="text-sm text-red-400">Start and end can&apos;t be the same point.</p>
              )}
            </div>
          </div>
          <SequenceTimeline
            durationSeconds={video.duration_seconds}
            sequences={sequencesQuery.data ?? []}
            markStart={markStart}
            markEnd={markEnd}
            onOpenSequence={onOpenSequence}
            onSegmentClick={handleSegmentClick}
            onEmptyBackgroundClick={handleEmptyBackgroundClick}
            onMarkStartChange={setMarkStart}
            onMarkEndChange={setMarkEnd}
            onScrub={(seconds) => {
              if (videoRef.current) videoRef.current.currentTime = seconds;
            }}
          />
        </>
      ) : null}
    </div>
  );
}
