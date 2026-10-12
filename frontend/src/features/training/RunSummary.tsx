interface Change {
  label: string;
  value: string;
  defaultValue: string;
}

interface RunSummaryProps {
  changes: Change[];
}

// The change counter of the sticky bottom bar; its list opens upward so the
// bar itself keeps its height.
export function RunSummary({ changes }: RunSummaryProps) {
  if (changes.length === 0) {
    return <span className="text-sm text-gray-400">Default settings</span>;
  }
  return (
    <details className="relative text-sm">
      <summary className="cursor-pointer text-gray-300 hover:text-gray-100">
        {changes.length === 1 ? "1 change" : `${changes.length} changes`}
      </summary>
      <ul className="absolute bottom-full left-0 mb-2 flex max-h-[40vh] w-80 flex-col gap-1 overflow-y-auto rounded border border-gray-700 bg-gray-900 p-3 text-[13px] text-gray-300 shadow-lg">
        {changes.map((change) => (
          <li key={change.label} className="flex justify-between gap-2">
            <span>{change.label}</span>
            <span>
              {change.value} <span className="text-gray-400">(default {change.defaultValue})</span>
            </span>
          </li>
        ))}
      </ul>
    </details>
  );
}
