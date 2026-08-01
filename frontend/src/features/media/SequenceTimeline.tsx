import { useEffect, useRef, useState } from "react";

import { findSnapSeconds, pixelToSeconds } from "./computeTimelineDrag";
import type { components } from "../../shared/api/generated/schema";

const SEGMENT_COLORS = ["bg-blue-600", "bg-emerald-600", "bg-amber-600", "bg-purple-600", "bg-pink-600"];
const SNAP_PIXELS = 8;
const MIN_REGION_SECONDS = 1;

type SequenceRead = components["schemas"]["SequenceRead"];
type DragState = { edge: "start" | "end" | "new"; anchorSeconds: number };

export function SequenceTimeline({
  durationSeconds,
  sequences,
  markStart,
  markEnd,
  onOpenSequence,
  onRenameSequence,
  onRecutSequence,
  onMarkStartChange,
  onMarkEndChange,
  onScrub,
}: {
  durationSeconds: number;
  sequences: SequenceRead[];
  markStart: number | null;
  markEnd: number | null;
  onOpenSequence: (id: number) => void;
  onRenameSequence: (id: number) => void;
  onRecutSequence: (id: number) => void;
  onMarkStartChange: (seconds: number) => void;
  onMarkEndChange: (seconds: number) => void;
  onScrub: (seconds: number) => void;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const [dragState, setDragState] = useState<DragState | null>(null);

  function pct(seconds: number): number {
    if (durationSeconds <= 0) return 0;
    return (seconds / durationSeconds) * 100;
  }

  useEffect(() => {
    if (dragState === null) return;

    function handleMouseMove(event: MouseEvent) {
      const rect = rootRef.current?.getBoundingClientRect();
      if (!rect) return;

      const snapCandidates: number[] = sequences.flatMap((s) => [s.start_time, s.start_time + s.duration]);
      if (dragState!.edge === "start" && markEnd !== null) snapCandidates.push(markEnd);
      if (dragState!.edge === "end" && markStart !== null) snapCandidates.push(markStart);

      const raw = pixelToSeconds(event.clientX, rect, durationSeconds);
      const snapped = findSnapSeconds(raw, event.clientX, rect, durationSeconds, snapCandidates, SNAP_PIXELS);

      onScrub(snapped);

      if (dragState!.edge === "start") {
        const max = (markEnd ?? durationSeconds) - MIN_REGION_SECONDS;
        onMarkStartChange(Math.min(snapped, max));
      } else if (dragState!.edge === "end") {
        const min = (markStart ?? 0) + MIN_REGION_SECONDS;
        onMarkEndChange(Math.max(snapped, min));
      } else {
        const anchor = dragState!.anchorSeconds;
        let start = Math.min(anchor, snapped);
        let end = Math.max(anchor, snapped);
        if (end - start < MIN_REGION_SECONDS) {
          if (snapped >= anchor) {
            // Dragging right (or no movement yet): anchor stays fixed as the start.
            end = Math.min(durationSeconds, anchor + MIN_REGION_SECONDS);
          } else {
            // Dragging left: anchor stays fixed as the end.
            start = Math.max(0, anchor - MIN_REGION_SECONDS);
          }
        }
        onMarkStartChange(start);
        onMarkEndChange(end);
      }
    }

    function handleMouseUp() {
      setDragState(null);
    }

    window.addEventListener("mousemove", handleMouseMove);
    window.addEventListener("mouseup", handleMouseUp);
    return () => {
      window.removeEventListener("mousemove", handleMouseMove);
      window.removeEventListener("mouseup", handleMouseUp);
    };
  }, [dragState, sequences, markStart, markEnd, durationSeconds, onMarkStartChange, onMarkEndChange, onScrub]);

  function handleRootMouseDown(event: React.MouseEvent<HTMLDivElement>) {
    if (event.target !== event.currentTarget) return;
    const rect = rootRef.current?.getBoundingClientRect();
    if (!rect) return;
    const anchorSeconds = pixelToSeconds(event.clientX, rect, durationSeconds);
    setDragState({ edge: "new", anchorSeconds });
  }

  return (
    <div ref={rootRef} onMouseDown={handleRootMouseDown} className="relative h-10 w-full rounded bg-gray-800">
      {sequences.map((sequence) => (
        <div
          key={sequence.id}
          title={sequence.name}
          className={`absolute top-0 flex h-full items-center justify-center overflow-hidden whitespace-nowrap px-1 text-xs text-white ${SEGMENT_COLORS[sequence.id % SEGMENT_COLORS.length]}`}
          style={{ left: `${pct(sequence.start_time)}%`, width: `${pct(sequence.duration)}%` }}
        >
          <span className="truncate">{sequence.name}</span>
          <button
            type="button"
            aria-label={`Open ${sequence.name}`}
            onClick={() => onOpenSequence(sequence.id)}
            className="ml-1 shrink-0 underline"
          >
            ↗
          </button>
          <button
            type="button"
            aria-label={`Rename ${sequence.name}`}
            onClick={() => onRenameSequence(sequence.id)}
            className="ml-1 shrink-0 underline"
          >
            ✎
          </button>
          <button
            type="button"
            aria-label={`Re-cut ${sequence.name}`}
            onClick={() => onRecutSequence(sequence.id)}
            className="ml-1 shrink-0 underline"
          >
            ✂
          </button>
        </div>
      ))}
      {markStart !== null && markEnd !== null && (
        <>
          <div
            data-testid="pending-mark-overlay"
            className="absolute top-0 h-full border-2 border-dashed border-yellow-400 bg-yellow-400/20 pointer-events-none"
            style={{
              left: `${pct(Math.min(markStart, markEnd))}%`,
              width: `${pct(Math.abs(markEnd - markStart))}%`,
            }}
          />
          <div
            data-testid="mark-handle-start"
            onMouseDown={(event) => {
              event.stopPropagation();
              setDragState({ edge: "start", anchorSeconds: 0 });
            }}
            className="absolute top-0 h-full bg-yellow-400/60"
            style={{ left: `${pct(Math.min(markStart, markEnd))}%`, width: "6px", cursor: "ew-resize" }}
          />
          <div
            data-testid="mark-handle-end"
            onMouseDown={(event) => {
              event.stopPropagation();
              setDragState({ edge: "end", anchorSeconds: 0 });
            }}
            className="absolute top-0 h-full bg-yellow-400/60"
            style={{ left: `calc(${pct(Math.max(markStart, markEnd))}% - 6px)`, width: "6px", cursor: "ew-resize" }}
          />
        </>
      )}
    </div>
  );
}
