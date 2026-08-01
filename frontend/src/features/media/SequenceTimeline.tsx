import { useEffect, useRef, useState } from "react";

import { findSnapSeconds, pixelToSeconds } from "./computeTimelineDrag";
import type { components } from "../../shared/api/generated/schema";

const SEGMENT_COLORS = ["bg-blue-600", "bg-emerald-600", "bg-amber-600", "bg-purple-600", "bg-pink-600"];
const SNAP_PIXELS = 8;
const MIN_REGION_SECONDS = 1;
const CLICK_THRESHOLD_PIXELS = 3;

type SequenceRead = components["schemas"]["SequenceRead"];
type DragState =
  | { edge: "start" | "end"; anchorSeconds: number }
  | { edge: "new"; anchorSeconds: number; mouseDownClientX: number };

function computeGapBounds(
  clickSeconds: number,
  sequences: SequenceRead[],
  durationSeconds: number
): [number, number] {
  let left = 0;
  let right = durationSeconds;
  for (const s of sequences) {
    const segEnd = s.start_time + s.duration;
    if (segEnd <= clickSeconds && segEnd > left) left = segEnd;
    if (s.start_time >= clickSeconds && s.start_time < right) right = s.start_time;
  }
  return [left, right];
}

export function SequenceTimeline({
  durationSeconds,
  sequences,
  markStart,
  markEnd,
  onOpenSequence,
  onSegmentClick,
  onEmptyBackgroundClick,
  onMarkStartChange,
  onMarkEndChange,
  onScrub,
}: {
  durationSeconds: number;
  sequences: SequenceRead[];
  markStart: number | null;
  markEnd: number | null;
  onOpenSequence: (id: number) => void;
  onSegmentClick: (sequenceId: number, startTime: number, endTime: number) => void;
  onEmptyBackgroundClick: () => void;
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

    function handleMouseUp(event: MouseEvent) {
      const current = dragState!;
      if (current.edge === "new" && Math.abs(event.clientX - current.mouseDownClientX) < CLICK_THRESHOLD_PIXELS) {
        const [left, right] = computeGapBounds(current.anchorSeconds, sequences, durationSeconds);
        onMarkStartChange(left);
        onMarkEndChange(right);
        onEmptyBackgroundClick();
      }
      setDragState(null);
    }

    window.addEventListener("mousemove", handleMouseMove);
    window.addEventListener("mouseup", handleMouseUp);
    return () => {
      window.removeEventListener("mousemove", handleMouseMove);
      window.removeEventListener("mouseup", handleMouseUp);
    };
  }, [dragState, sequences, markStart, markEnd, durationSeconds, onMarkStartChange, onMarkEndChange, onScrub, onEmptyBackgroundClick]);

  function handleRootMouseDown(event: React.MouseEvent<HTMLDivElement>) {
    if (event.target !== event.currentTarget) return;
    const rect = rootRef.current?.getBoundingClientRect();
    if (!rect) return;
    const anchorSeconds = pixelToSeconds(event.clientX, rect, durationSeconds);
    setDragState({ edge: "new", anchorSeconds, mouseDownClientX: event.clientX });
  }

  return (
    <div ref={rootRef} onMouseDown={handleRootMouseDown} className="relative h-10 w-full rounded bg-gray-800">
      {sequences.map((sequence) => (
        <div
          key={sequence.id}
          title={sequence.name}
          onMouseDown={(event) => {
            event.stopPropagation();
            onSegmentClick(sequence.id, sequence.start_time, sequence.start_time + sequence.duration);
          }}
          className={`absolute top-0 flex h-full items-center justify-center overflow-hidden whitespace-nowrap px-1 text-xs text-white ${SEGMENT_COLORS[sequence.id % SEGMENT_COLORS.length]}`}
          style={{ left: `${pct(sequence.start_time)}%`, width: `${pct(sequence.duration)}%` }}
        >
          <button
            type="button"
            onMouseDown={(event) => event.stopPropagation()}
            onClick={(event) => {
              event.stopPropagation();
              onOpenSequence(sequence.id);
            }}
            className="truncate underline"
          >
            {sequence.name}
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
