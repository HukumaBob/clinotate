import { memo, useEffect, useMemo, useRef, useState } from "react";

import { formatClock } from "../analysis/strip";
import { colorForClass } from "../predictions";
import { useVideoClock } from "../useVideoClock";
import type { AxisIndex } from "./axisIndex";
import type { Blip } from "./blips";
import { buildSegments, type Segment } from "./segments";
import type { ClassificationDocument } from "./types";

type Axis = ClassificationDocument["axes"][number];

interface AxisLanesProps {
  videoRef: React.RefObject<HTMLVideoElement | null>;
  axes: ClassificationDocument["axes"];
  indexes: AxisIndex[];
  durationMs: number;
  /** Blips of all axes; each lane draws the ones of its own axis. */
  blips: Blip[];
  onSeek: (ms: number) => void;
  /** Axis of the current event, highlighted. */
  activeAxis?: number | null;
  /** Reference intervals per axis. Accepted and ignored for now: a later
   * sub-project draws them as a paired lane above the prediction lane. */
  reference?: unknown[];
}

/** Below this width (px) a segment carries no name inside. */
const MIN_LABEL_PX = 56;

const percent = (ms: number, durationMs: number) =>
  `${Math.min(Math.max(ms / durationMs, 0), 1) * 100}%`;

function classShares(segments: Segment[], classCount: number): number[] {
  const totals = new Array<number>(classCount).fill(0);
  let all = 0;
  for (const segment of segments) {
    const length = segment.endMs - segment.startMs;
    if (segment.classId < classCount) totals[segment.classId] += length;
    all += length;
  }
  return totals.map((t) => (all > 0 ? t / all : 0));
}

// Memoised: the playhead re-renders the lanes every frame; the header, the
// segments and the ticks do not change with it.
const LaneHeader = memo(function LaneHeader({
  axis,
  segments,
  active,
}: {
  axis: Axis;
  segments: Segment[];
  active: boolean;
}) {
  const shares = useMemo(() => classShares(segments, axis.classes.length), [segments, axis]);
  const changes = Math.max(segments.length - 1, 0);
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs">
      <span className={`font-semibold ${active ? "text-white" : "text-gray-200"}`}>{axis.name}</span>
      <span className="text-gray-400">{`${changes} ${changes === 1 ? "change" : "changes"}`}</span>
      {axis.classes.map((name, id) =>
        shares[id] > 0 ? (
          <span key={id} className="flex items-center gap-1 text-gray-400">
            <span
              aria-hidden="true"
              className="inline-block h-2 w-2 rounded-sm"
              style={{ backgroundColor: colorForClass(id) }}
            />
            <span>{`${name} ${Math.round(shares[id] * 100)}%`}</span>
          </span>
        ) : null,
      )}
    </div>
  );
});

const LaneSegments = memo(function LaneSegments({
  axis,
  segments,
  durationMs,
  widthPx,
}: {
  axis: Axis;
  segments: Segment[];
  durationMs: number;
  widthPx: number;
}) {
  return (
    <>
      {segments.map((segment) => {
        const name = axis.classes[segment.classId] ?? `class ${segment.classId}`;
        const share = (segment.endMs - segment.startMs) / durationMs;
        return (
          <div
            key={segment.startMs}
            data-testid="segment"
            title={`${name} · ${formatClock(segment.startMs)}–${formatClock(segment.endMs)}`}
            className="absolute inset-y-0 overflow-hidden border-r border-gray-950/60 px-1 text-[11px] leading-6 text-gray-950"
            style={{
              left: percent(segment.startMs, durationMs),
              width: `${Math.max(share, 0) * 100}%`,
              backgroundColor: colorForClass(segment.classId),
            }}
          >
            {share * widthPx >= MIN_LABEL_PX && <span className="block truncate">{name}</span>}
          </div>
        );
      })}
    </>
  );
});

const BlipTicks = memo(function BlipTicks({ blips, durationMs }: { blips: Blip[]; durationMs: number }) {
  return (
    <>
      {blips.map((blip) => (
        <span
          key={blip.startMs}
          aria-hidden="true"
          data-testid="blip-tick"
          className="pointer-events-none absolute -bottom-1 -top-1 w-0.5 -translate-x-1/2 bg-white shadow-[0_0_2px_rgba(0,0,0,0.9)]"
          style={{ left: percent(blip.startMs, durationMs) }}
        />
      ))}
    </>
  );
});

/** One lane per classification axis under the player: a coloured segment per
 * stretch of one label, white ticks at blips, a playhead, click to seek. */
export function AxisLanes({ videoRef, axes, indexes, durationMs, blips, onSeek, activeAxis = null }: AxisLanesProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [widthPx, setWidthPx] = useState(0);
  const timeMs = useVideoClock(videoRef);

  useEffect(() => {
    const el = containerRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const update = () => setWidthPx(Math.floor(el.clientWidth));
    update();
    const observer = new ResizeObserver(update);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const segmentsByAxis = useMemo(
    () => indexes.map((index) => buildSegments(index, durationMs)),
    [indexes, durationMs],
  );
  const blipsByAxis = useMemo(
    () => axes.map((_, axis) => blips.filter((blip) => blip.axis === axis)),
    [axes, blips],
  );

  function seek(event: React.MouseEvent<HTMLDivElement>) {
    const rect = event.currentTarget.getBoundingClientRect();
    if (rect.width <= 0) return;
    const x = Math.min(Math.max(event.clientX - rect.left, 0), rect.width);
    onSeek((x / rect.width) * durationMs);
  }

  return (
    <div ref={containerRef} className="flex flex-col gap-3">
      {axes.map((axis, i) => {
        const active = activeAxis === i;
        return (
          <div
            key={i}
            role="group"
            aria-label={axis.name}
            data-active={active ? "true" : "false"}
            className={`flex flex-col gap-1 rounded px-1 py-0.5 ${active ? "ring-1 ring-blue-500" : ""}`}
          >
            <LaneHeader axis={axis} segments={segmentsByAxis[i] ?? []} active={active} />
            <div
              data-testid="lane-track"
              className="relative h-6 w-full cursor-pointer rounded bg-gray-900"
              onClick={seek}
            >
              <div className="absolute inset-0 overflow-hidden rounded">
                <LaneSegments
                  axis={axis}
                  segments={segmentsByAxis[i] ?? []}
                  durationMs={durationMs}
                  widthPx={widthPx}
                />
              </div>
              <BlipTicks blips={blipsByAxis[i] ?? []} durationMs={durationMs} />
              <div
                aria-hidden="true"
                className="pointer-events-none absolute -inset-y-0.5 w-0.5 bg-blue-400"
                style={{ left: percent(timeMs, durationMs) }}
              />
            </div>
          </div>
        );
      })}
    </div>
  );
}
