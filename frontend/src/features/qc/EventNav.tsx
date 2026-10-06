interface EventNavProps {
  count: number;
  onPrev: () => void;
  onNext: () => void;
}

const BUTTON =
  "rounded border border-gray-700 px-2 py-1 text-xs text-gray-300 hover:text-gray-100 disabled:opacity-50";

export function EventNav({ count, onPrev, onNext }: EventNavProps) {
  const none = count === 0;
  return (
    <div className="flex items-center gap-2">
      <button type="button" className={BUTTON} disabled={none} onClick={onPrev} title="Previous event ([)">
        Previous event
      </button>
      <button type="button" className={BUTTON} disabled={none} onClick={onNext} title="Next event (])">
        Next event
      </button>
      {none && <span className="text-xs text-gray-500">No flicker events at these settings</span>}
    </div>
  );
}
