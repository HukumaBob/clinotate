interface Change {
  label: string;
  value: string;
  defaultValue: string;
}

interface RunSummaryProps {
  datasetName: string;
  taskType: string;
  baseLabel: string;
  changes: Change[];
}

export function RunSummary({ datasetName, taskType, baseLabel, changes }: RunSummaryProps) {
  return (
    <section className="rounded border border-gray-800 bg-gray-950 p-3 text-xs text-gray-300">
      <h3 className="mb-1 text-sm font-medium text-gray-200">What will run</h3>
      <p>
        {taskType} on <span className="text-gray-100">{datasetName}</span>, starting from{" "}
        <span className="text-gray-100">{baseLabel}</span>
      </p>
      {changes.length === 0 ? (
        <p className="mt-1 text-gray-500">Default settings.</p>
      ) : (
        <details className="mt-1">
          <summary className="cursor-pointer text-gray-400 hover:text-gray-200">
            {changes.length === 1 ? "1 change" : `${changes.length} changes`}
          </summary>
          <ul className="mt-1 flex max-h-[40vh] flex-col gap-0.5 overflow-y-auto">
            {changes.map((change) => (
              <li key={change.label} className="flex justify-between gap-2">
                <span>{change.label}</span>
                <span>
                  {change.value} <span className="text-gray-500">(default {change.defaultValue})</span>
                </span>
              </li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}
