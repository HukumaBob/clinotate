import { memo, useEffect, useMemo, useRef, useState } from "react";

import type { FlickerEvent } from "./analysis/flicker";
import { LEVEL_COLORS, buildStrip, formatClock, type StripLevel } from "./analysis/strip";
import { colorForClass, type PredictionsDocument } from "./predictions";
import { useVideoClock } from "./useVideoClock";

interface TimelineStripProps {
  videoRef: React.RefObject<HTMLVideoElement | null>;
  doc: PredictionsDocument;
  threshold: number;
  events: FlickerEvent[];
  durationMs: number;
  onSeek: (ms: number) => void;
}

const MAX_BUCKETS = 1600;

const LEGEND: { level: StripLevel; label: string }[] = [
  { level: "strong", label: "≥ 0.7" },
  { level: "moderate", label: "above threshold" },
  { level: "weak", label: "below threshold" },
  { level: "none", label: "nothing" },
];

// Memoised: the playhead re-renders the strip every frame, and there can be
// hundreds of marks that do not change with it.
const FlickerMarks = memo(function FlickerMarks({
  events,
  durationMs,
}: {
  events: FlickerEvent[];
  durationMs: number;
}) {
  return (
    <>
      {events.map((event, i) => (
        <span
          key={`${event.classId}-${event.kind}-${event.startMs}-${i}`}
          aria-hidden="true"
          className="pointer-events-none absolute top-0 h-2 w-2 -translate-x-1/2 rounded-full border-2"
          style={{
            left: `${Math.min(Math.max(event.startMs / durationMs, 0), 1) * 100}%`,
            borderColor: colorForClass(event.classId),
            backgroundColor: event.kind === "blink" ? colorForClass(event.classId) : "transparent",
          }}
        />
      ))}
    </>
  );
});

/** A full-width timeline under the player: coloured by the best confidence
 * in each slice of time, flicker marks on top, a playhead, click to seek.
 * The native controls cannot be decorated, hence a strip of our own. */
export function TimelineStrip({ videoRef, doc, threshold, events, durationMs, onSeek }: TimelineStripProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [width, setWidth] = useState(0);
  const [hover, setHover] = useState<{ ms: number; x: number } | null>(null);
  const timeMs = useVideoClock(videoRef);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const update = () => setWidth(Math.floor(el.clientWidth));
    update();
    const observer = new ResizeObserver(update);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const buckets = useMemo(
    () => buildStrip(doc, durationMs, Math.min(width, MAX_BUCKETS), threshold),
    [doc, durationMs, width, threshold],
  );

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || buckets.length === 0) return;
    canvas.width = buckets.length;
    canvas.height = 1;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    buckets.forEach((bucket, i) => {
      ctx.fillStyle = LEVEL_COLORS[bucket.level];
      ctx.fillRect(i, 0, 1, 1);
    });
  }, [buckets]);

  function msAt(clientX: number): { ms: number; x: number } {
    const rect = containerRef.current!.getBoundingClientRect();
    const x = Math.min(Math.max(clientX - rect.left, 0), rect.width);
    return { ms: (x / rect.width) * durationMs, x };
  }

  const hoveredBucket = hover
    ? buckets[Math.min(buckets.length - 1, Math.floor((hover.ms / durationMs) * buckets.length))]
    : undefined;
  const percent = (ms: number) => `${Math.min(Math.max(ms / durationMs, 0), 1) * 100}%`;

  return (
    <div className="flex flex-col gap-1">
      <div
        ref={containerRef}
        role="img"
        aria-label="Detection timeline. Colour shows the best confidence over time; marks show flicker events. Click to seek."
        className="relative h-5 w-full cursor-pointer overflow-visible rounded bg-gray-900"
        onClick={(e) => onSeek(msAt(e.clientX).ms)}
        onMouseMove={(e) => setHover(msAt(e.clientX))}
        onMouseLeave={() => setHover(null)}
      >
        <canvas ref={canvasRef} className="pointer-events-none absolute inset-0 h-full w-full rounded" />

        <FlickerMarks events={events} durationMs={durationMs} />

        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-y-0 w-0.5 bg-white"
          style={{ left: percent(timeMs) }}
        />

        {hover && (
          <div
            className="pointer-events-none absolute -top-7 -translate-x-1/2 whitespace-nowrap rounded bg-gray-800 px-2 py-0.5 text-xs text-gray-100"
            style={{ left: width > 0 ? Math.min(Math.max(hover.x, 40), width - 40) : hover.x }}
          >
            {formatClock(hover.ms)}
            {hoveredBucket ? ` · max ${hoveredBucket.maxConfidence.toFixed(2)}` : ""}
          </div>
        )}
      </div>

      <ul className="flex flex-wrap items-center gap-3 text-xs text-gray-400">
        {LEGEND.map(({ level, label }) => (
          <li key={level} className="flex items-center gap-1">
            <span className="inline-block h-2 w-3 rounded-sm" style={{ backgroundColor: LEVEL_COLORS[level] }} />
            {label}
          </li>
        ))}
        <li className="flex items-center gap-1">
          <span className="inline-block h-2 w-2 rounded-full bg-gray-300" /> blink
        </li>
        <li className="flex items-center gap-1">
          <span className="inline-block h-2 w-2 rounded-full border-2 border-gray-300" /> dropout
        </li>
      </ul>
    </div>
  );
}
