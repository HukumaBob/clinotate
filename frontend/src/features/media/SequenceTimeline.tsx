import type { components } from "../../shared/api/generated/schema";

const SEGMENT_COLORS = ["bg-blue-600", "bg-emerald-600", "bg-amber-600", "bg-purple-600", "bg-pink-600"];

type SequenceRead = components["schemas"]["SequenceRead"];

export function SequenceTimeline({
  durationSeconds,
  sequences,
  markStart,
  markEnd,
  onMarkStart,
  onMarkEnd,
  onOpenSequence,
  onRenameSequence,
  onRecutSequence,
  markStartDisabled,
  markEndDisabled,
}: {
  durationSeconds: number;
  sequences: SequenceRead[];
  markStart: number | null;
  markEnd: number | null;
  onMarkStart: () => void;
  onMarkEnd: () => void;
  onOpenSequence: (id: number) => void;
  onRenameSequence: (id: number) => void;
  onRecutSequence: (id: number) => void;
  markStartDisabled: boolean;
  markEndDisabled: boolean;
}) {
  function pct(seconds: number): number {
    if (durationSeconds <= 0) return 0;
    return (seconds / durationSeconds) * 100;
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="relative h-10 w-full rounded bg-gray-800">
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
          <div
            data-testid="pending-mark-overlay"
            className="absolute top-0 h-full border-2 border-dashed border-yellow-400 bg-yellow-400/20"
            style={{
              left: `${pct(Math.min(markStart, markEnd))}%`,
              width: `${pct(Math.abs(markEnd - markStart))}%`,
            }}
          />
        )}
      </div>
      <div className="flex gap-3">
        <button
          type="button"
          onClick={onMarkStart}
          disabled={markStartDisabled}
          className="rounded border border-gray-700 px-3 py-1 text-sm hover:bg-gray-800 disabled:opacity-50"
        >
          Mark start
        </button>
        <button
          type="button"
          onClick={onMarkEnd}
          disabled={markEndDisabled}
          className="rounded border border-gray-700 px-3 py-1 text-sm hover:bg-gray-800 disabled:opacity-50"
        >
          Mark end
        </button>
      </div>
    </div>
  );
}
