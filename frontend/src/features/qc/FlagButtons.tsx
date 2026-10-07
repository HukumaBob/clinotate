import type { QcFlagKind } from "../../entities/useQcFlags";

interface FlagButtonsProps {
  disabled: boolean;
  onFlag: (kind: QcFlagKind) => void;
  snapNote: string | null;
  error: string | null;
}

const BUTTON =
  "rounded border border-gray-700 px-2 py-1 text-xs text-gray-300 hover:text-gray-100 disabled:opacity-50";

export function FlagButtons({ disabled, onFlag, snapNote, error }: FlagButtonsProps) {
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center gap-2">
        <button
          type="button"
          className={BUTTON}
          disabled={disabled}
          aria-keyshortcuts="F"
          title="Mark this frame as a false positive (F)"
          onClick={() => onFlag("fp")}
        >
          False positive (F)
        </button>
        <button
          type="button"
          className={BUTTON}
          disabled={disabled}
          aria-keyshortcuts="N"
          title="Mark this frame as a missed object (N)"
          onClick={() => onFlag("fn")}
        >
          Missed object (N)
        </button>
        {snapNote && <span className="text-xs text-gray-400">{snapNote}</span>}
      </div>
      {error && (
        <p role="alert" className="text-xs text-red-400">
          {error}
        </p>
      )}
    </div>
  );
}
