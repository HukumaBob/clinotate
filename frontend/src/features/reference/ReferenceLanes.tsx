import { useEffect, useRef } from "react";

import { colorForClass } from "../qc/predictions";
import { useVideoClock } from "../qc/useVideoClock";
import { coverage } from "./intervals";
import type { RefAxis, RefInterval } from "./types";

interface ReferenceLanesProps {
  videoRef: React.RefObject<HTMLVideoElement | null>;
  axes: RefAxis[];
  intervals: RefInterval[];
  growing: Record<number, RefInterval | undefined>;
  selectedId: number | null;
  durationMs: number;
  onSelect: (id: number | null) => void;
  onDragEdge: (id: number, edge: "start" | "end", ms: number) => void;
  orphanedCount: number;
}

const HATCH = {
  backgroundImage:
    "repeating-linear-gradient(45deg, rgba(107, 114, 128, 0.45) 0 2px, transparent 2px 6px)",
};

const pct = (ms: number, durationMs: number) => `${Math.min(Math.max(ms / durationMs, 0), 1) * 100}%`;

/** Unlabeled stretches of one axis, clipped to the video. */
function gapsOf(intervals: RefInterval[], durationMs: number): { startMs: number; endMs: number }[] {
  const gaps: { startMs: number; endMs: number }[] = [];
  let cursor = 0;
  for (const iv of [...intervals].sort((a, b) => a.startMs - b.startMs)) {
    if (iv.startMs > cursor) gaps.push({ startMs: cursor, endMs: Math.min(iv.startMs, durationMs) });
    cursor = Math.max(cursor, iv.endMs);
  }
  if (cursor < durationMs) gaps.push({ startMs: cursor, endMs: durationMs });
  return gaps.filter((g) => g.endMs > g.startMs);
}

/** One editable lane per axis: coloured segments, hatched gaps, handles on
 * the selected interval, a playhead and the share of the video labelled. */
export function ReferenceLanes({
  videoRef,
  axes,
  intervals,
  growing,
  selectedId,
  durationMs,
  onSelect,
  onDragEdge,
  orphanedCount,
}: ReferenceLanesProps) {
  const timeMs = useVideoClock(videoRef);
  const drag = useRef<{ id: number; edge: "start" | "end"; lane: HTMLElement } | null>(null);
  const onDragRef = useRef(onDragEdge);
  onDragRef.current = onDragEdge;
  const durationRef = useRef(durationMs);
  durationRef.current = durationMs;

  useEffect(() => {
    function onMove(event: PointerEvent) {
      const current = drag.current;
      if (!current) return;
      const rect = current.lane.getBoundingClientRect();
      if (rect.width <= 0) return;
      const fraction = Math.min(Math.max((event.clientX - rect.left) / rect.width, 0), 1);
      onDragRef.current(current.id, current.edge, Math.round(fraction * durationRef.current));
    }
    function onUp() {
      drag.current = null;
    }
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
    };
  }, []);

  const growingIds = new Set(Object.values(growing).map((g) => g?.id));

  function startDrag(event: React.PointerEvent<HTMLElement>, id: number, edge: "start" | "end") {
    event.preventDefault();
    event.stopPropagation();
    const lane = event.currentTarget.closest<HTMLElement>("[data-lane]");
    if (lane) drag.current = { id, edge, lane };
  }

  return (
    <div className="flex flex-col gap-2">
      {axes.map((axis) => {
        // Orphaned intervals (class no longer on the axis) are only counted in
        // the warning; they are neither drawn nor part of the coverage.
        const classIds = new Set(axis.classes.map((c) => c.labelId));
        const own = intervals.filter((iv) => iv.categoryId === axis.categoryId && classIds.has(iv.labelId));
        const share = durationMs > 0 ? Math.round(coverage(own, axis.categoryId, durationMs) * 100) : 0;
        return (
          <div key={axis.categoryId} className="flex flex-col gap-1">
            <div className="flex justify-between text-xs text-gray-400">
              <span>{axis.name}</span>
              <span>{`${share}% labeled`}</span>
            </div>
            <div
              data-lane
              data-testid={`lane-${axis.categoryId}`}
              className="relative h-6 select-none rounded bg-gray-900"
              onClick={() => onSelect(null)}
            >
              {durationMs > 0 &&
                gapsOf(own, durationMs).map((gap) => (
                  <div
                    key={`gap-${gap.startMs}`}
                    data-testid="gap"
                    className="absolute inset-y-0"
                    style={{
                      ...HATCH,
                      left: pct(gap.startMs, durationMs),
                      width: pct(gap.endMs - gap.startMs, durationMs),
                    }}
                  />
                ))}
              {durationMs > 0 &&
                own.map((iv) => {
                  const selected = iv.id === selectedId;
                  return (
                    <div
                      key={iv.id}
                      data-testid={`segment-${iv.id}`}
                      title={axis.classes.find((c) => c.labelId === iv.labelId)?.name}
                      className={`absolute inset-y-0 cursor-pointer ${
                        growingIds.has(iv.id) ? "z-10 outline outline-2 outline-white" : ""
                      } ${selected ? "z-20 brightness-125" : ""}`}
                      style={{
                        left: pct(iv.startMs, durationMs),
                        width: pct(iv.endMs - iv.startMs, durationMs),
                        backgroundColor: colorForClass(iv.labelId),
                      }}
                      onClick={(event) => {
                        event.stopPropagation();
                        onSelect(iv.id);
                      }}
                    >
                      {selected &&
                        (["start", "end"] as const).map((edge) => (
                          <span
                            key={edge}
                            data-testid={`handle-${iv.id}-${edge}`}
                            className={`absolute inset-y-[-3px] w-1.5 cursor-ew-resize rounded-sm bg-white ${
                              edge === "start" ? "left-0 -translate-x-1/2" : "right-0 translate-x-1/2"
                            }`}
                            onPointerDown={(event) => startDrag(event, iv.id, edge)}
                            onClick={(event) => event.stopPropagation()}
                          />
                        ))}
                    </div>
                  );
                })}
              {durationMs > 0 && (
                <div
                  aria-hidden="true"
                  className="pointer-events-none absolute inset-y-[-2px] z-30 w-0.5 bg-blue-500"
                  style={{ left: pct(timeMs, durationMs) }}
                />
              )}
            </div>
          </div>
        );
      })}
      {orphanedCount > 0 && (
        <p className="text-xs text-amber-400">
          {`${orphanedCount} orphaned ${orphanedCount === 1 ? "interval" : "intervals"}: the class is no longer in the taxonomy`}
        </p>
      )}
    </div>
  );
}
