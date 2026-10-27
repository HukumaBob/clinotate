import type { QcFlagKind } from "../../entities/useQcFlags";

interface FlagButtonsProps {
  disabled: boolean;
  onFlag: (kind: QcFlagKind) => void;
  snapNote: string | null;
  error: string | null;
}

const BUTTON =
  "inline-flex items-center gap-1.5 rounded border px-2 py-1 text-xs disabled:opacity-50";
const FP = `${BUTTON} border-red-800 bg-red-950 text-red-200 hover:border-red-600`;
const FN = `${BUTTON} border-blue-800 bg-blue-950 text-blue-200 hover:border-blue-600`;
const KEY = "rounded border border-current px-1 font-mono text-[10px] opacity-70";

export function FlagButtons({ disabled, onFlag, snapNote, error }: FlagButtonsProps) {
  return (
    <div className="flex flex-col gap-1">
      <div role="group" aria-label="Flag this frame" className="flex items-center gap-2">
        <span className="text-xs font-medium uppercase tracking-wide text-gray-500">Flag this frame</span>
        <button
          type="button"
          className={FP}
          disabled={disabled}
          aria-keyshortcuts="F"
          title="Mark this frame as a false positive (F)"
          onClick={() => onFlag("fp")}
        >
          False positive
          <kbd aria-hidden="true" className={KEY}>F</kbd>
        </button>
        <button
          type="button"
          className={FN}
          disabled={disabled}
          aria-keyshortcuts="N"
          title="Mark this frame as a missed object (N)"
          onClick={() => onFlag("fn")}
        >
          Missed object
          <kbd aria-hidden="true" className={KEY}>N</kbd>
        </button>
        {snapNote && <span role="status" className="text-xs text-gray-400">{snapNote}</span>}
      </div>
      {error && (
        <p role="alert" className="text-xs text-red-400">
          {error}
        </p>
      )}
    </div>
  );
}
