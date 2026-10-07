import { useEffect, useRef, useState } from "react";

interface CommitDialogProps {
  fpCount: number;
  fnCount: number;
  defaultName: string;
  error: string | null;
  submitting: boolean;
  onConfirm: (name: string) => void;
  onCancel: () => void;
}

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

export function CommitDialog({
  fpCount,
  fnCount,
  defaultName,
  error,
  submitting,
  onConfirm,
  onCancel,
}: CommitDialogProps) {
  const [name, setName] = useState(defaultName);
  const nameRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    nameRef.current?.focus();
  }, []);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") onCancel();
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onCancel]);

  const canConfirm = name.trim().length > 0 && !submitting;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Send frames to training"
        className="w-full max-w-md rounded border border-gray-800 bg-gray-900 p-4 text-sm text-gray-200"
      >
        <h2 className="mb-3 text-base font-semibold text-gray-100">Send frames to training</h2>

        <label htmlFor="qc-sequence-name" className="mb-1 block text-gray-300">
          Sequence name
        </label>
        <input
          id="qc-sequence-name"
          ref={nameRef}
          type="text"
          maxLength={255}
          value={name}
          onChange={(e) => setName(e.target.value)}
          className="mb-3 w-full rounded border border-gray-700 bg-gray-900 px-2 py-1.5 text-gray-100"
        />

        <ul className="mb-3 list-disc pl-5 text-gray-300">
          {fpCount > 0 && (
            <li>{plural(fpCount, "false positive", "false positives")} will be saved as {fpCount === 1 ? "a negative" : "negatives"}</li>
          )}
          {fnCount > 0 && (
            <li>{plural(fnCount, "missed object", "missed objects")} will wait for annotation</li>
          )}
        </ul>

        <p className="mb-3 rounded border border-yellow-700 bg-yellow-950 px-2 py-1 text-xs text-yellow-200">
          After sending, this video is no longer an unbiased test for future runs.
        </p>

        {error && (
          <p role="alert" className="mb-3 text-xs text-red-400">
            {error}
          </p>
        )}

        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            className="rounded border border-gray-700 px-3 py-1 text-xs text-gray-300 hover:text-gray-100"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={!canConfirm}
            onClick={() => onConfirm(name.trim())}
            className="rounded bg-blue-600 px-3 py-1 text-xs text-white disabled:opacity-50"
          >
            {submitting ? "Sending…" : "Confirm"}
          </button>
        </div>
      </div>
    </div>
  );
}
