import { Link } from "react-router-dom";

import type { QcFlag } from "../../entities/useQcFlags";
import { formatClock } from "./analysis/strip";

interface FlagsPanelProps {
  flags: QcFlag[];
  loadFailed: boolean;
  onRetry: () => void;
  onSeek: (ms: number) => void;
  onRemove: (flagId: number) => void;
  onNoteChange: (flag: QcFlag, note: string) => void;
  onSend: () => void;
  lastSequence: { id: number; name: string } | null;
}

export function FlagsPanel({
  flags,
  loadFailed,
  onRetry,
  onSeek,
  onRemove,
  onNoteChange,
  onSend,
  lastSequence,
}: FlagsPanelProps) {
  const pending = flags.filter((f) => f.committed_at === null);
  const sent = flags.length - pending.length;
  const sequenceIds = [
    ...new Set(flags.map((f) => f.sequence_id).filter((id): id is number => id !== null)),
  ];

  return (
    <section aria-label="Flags" className="flex flex-col gap-2 text-sm text-gray-300">
      <h2 className="text-sm font-semibold text-gray-200">Flags</h2>

      {loadFailed ? (
        <div className="flex items-center gap-2 text-xs text-red-400">
          <span>Could not load the flags.</span>
          <button
            type="button"
            onClick={onRetry}
            className="rounded border border-gray-700 px-2 py-0.5 text-gray-300 hover:text-gray-100"
          >
            Retry
          </button>
        </div>
      ) : (
        <>
          <p className="text-xs text-gray-400">{`${pending.length} pending · ${sent} sent`}</p>

          {pending.length > 0 && (
            <ul className="flex flex-col gap-2">
              {pending.map((flag) => {
                const time = formatClock(flag.timestamp_ms);
                return (
                  <li key={flag.id} className="flex flex-col gap-1 rounded border border-gray-800 p-2">
                    <div className="flex items-center justify-between">
                      <span className="flex items-center gap-2">
                        <button
                          type="button"
                          onClick={() => onSeek(flag.timestamp_ms)}
                          className="text-blue-400 hover:underline"
                        >
                          {time}
                        </button>
                        <span
                          className={`rounded px-1.5 py-0.5 text-xs ${
                            flag.kind === "fp" ? "bg-red-900 text-red-100" : "bg-blue-900 text-blue-100"
                          }`}
                        >
                          {flag.kind.toUpperCase()}
                        </span>
                      </span>
                      <button
                        type="button"
                        aria-label={`Remove flag at ${time}`}
                        onClick={() => onRemove(flag.id)}
                        className="text-gray-500 hover:text-gray-200"
                      >
                        ×
                      </button>
                    </div>
                    <input
                      type="text"
                      aria-label={`Note for flag at ${time}`}
                      placeholder="Note (optional)"
                      maxLength={500}
                      defaultValue={flag.note ?? ""}
                      onBlur={(e) => {
                        if (e.target.value !== (flag.note ?? "")) onNoteChange(flag, e.target.value);
                      }}
                      className="rounded border border-gray-700 bg-gray-900 px-2 py-1 text-xs text-gray-100"
                    />
                  </li>
                );
              })}
            </ul>
          )}

          <button
            type="button"
            disabled={pending.length === 0}
            onClick={onSend}
            className="rounded bg-blue-600 px-3 py-1.5 text-xs text-white disabled:opacity-50"
          >
            {pending.length === 0
              ? "Send to training"
              : `Send ${pending.length} ${pending.length === 1 ? "frame" : "frames"} to training`}
          </button>

          {lastSequence && (
            <p className="text-xs text-green-400">
              Created sequence “{lastSequence.name}” ·{" "}
              <Link to={`/sequences/${lastSequence.id}`} className="underline">
                Open in editor
              </Link>
            </p>
          )}

          {sequenceIds.length > 0 && (
            <p className="text-xs text-gray-400">
              Sent into sequences:{" "}
              {sequenceIds.map((id) => (
                <Link key={id} to={`/sequences/${id}`} className="mr-1 text-blue-400 hover:underline">
                  {`#${id}`}
                </Link>
              ))}
            </p>
          )}
        </>
      )}
    </section>
  );
}
