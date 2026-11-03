import { useState } from "react";

interface ReferenceStatusProps {
  status: "none" | "clean" | "compromised";
  compromisedAt: string | null;
  onRestore: () => void;
}

const BADGE: Record<ReferenceStatusProps["status"], { text: string; className: string }> = {
  none: { text: "No reference", className: "border-gray-700 bg-gray-800 text-gray-400" },
  clean: { text: "Clean", className: "border-emerald-700 bg-emerald-900/40 text-emerald-300" },
  compromised: { text: "Compromised", className: "border-red-700 bg-red-900/40 text-red-300" },
};

/** The reference status badge; a compromised reference can be restored to
 * clean after an explicit confirm step (the same arm/confirm as RunsTable). */
export function ReferenceStatus({ status, compromisedAt, onRestore }: ReferenceStatusProps) {
  const [armed, setArmed] = useState(false);
  const badge = BADGE[status];
  return (
    <div className="flex flex-wrap items-center gap-2 text-xs">
      <span className={`rounded border px-2 py-0.5 ${badge.className}`}>{badge.text}</span>
      {status === "compromised" && compromisedAt && (
        <span className="text-gray-400">since {new Date(compromisedAt).toLocaleString()}</span>
      )}
      {status === "compromised" &&
        (armed ? (
          <>
            <span className="text-gray-400">Only if this video never reached the training data.</span>
            <button
              type="button"
              className="rounded bg-red-700 px-2 py-1 text-white"
              onClick={() => {
                onRestore();
                setArmed(false);
              }}
            >
              Confirm restore
            </button>
            <button
              type="button"
              className="rounded border border-gray-700 px-2 py-1 text-gray-300 hover:text-gray-100"
              onClick={() => setArmed(false)}
            >
              Cancel
            </button>
          </>
        ) : (
          <button
            type="button"
            className="rounded border border-gray-700 px-2 py-1 text-gray-300 hover:text-gray-100"
            onClick={() => setArmed(true)}
          >
            Restore clean
          </button>
        ))}
    </div>
  );
}
