interface EventNavProps {
  count: number;
  onPrev: () => void;
  onNext: () => void;
}

const BUTTON =
  "inline-flex items-center gap-1.5 rounded border border-gray-700 px-2 py-1 text-xs text-gray-300 hover:border-gray-500 hover:text-gray-100 disabled:opacity-50";
const KEY = "rounded border border-gray-600 px-1 font-mono text-[10px] text-gray-400";

export function EventNav({ count, onPrev, onNext }: EventNavProps) {
  const none = count === 0;
  return (
    <div role="group" aria-label="Events" className="flex items-center gap-2">
      <span className="text-xs font-medium uppercase tracking-wide text-gray-500">Events</span>
      <button type="button" className={BUTTON} disabled={none} onClick={onPrev} title="Previous event ([)">
        Previous event
        <kbd aria-hidden="true" className={KEY}>[</kbd>
      </button>
      <button type="button" className={BUTTON} disabled={none} onClick={onNext} title="Next event (])">
        Next event
        <kbd aria-hidden="true" className={KEY}>]</kbd>
      </button>
      <span className="text-xs text-gray-500">
        {none ? "No flicker events at these settings" : `${count} ${count === 1 ? "event" : "events"}`}
      </span>
    </div>
  );
}
