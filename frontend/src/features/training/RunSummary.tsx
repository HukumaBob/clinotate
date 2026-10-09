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
      <h3 className="mb-2 text-sm font-medium text-gray-200">What will run</h3>
      <p>
        {taskType} on <span className="text-gray-100">{datasetName}</span>, starting from{" "}
        <span className="text-gray-100">{baseLabel}</span>
      </p>
      {changes.length === 0 ? (
        <p className="mt-2 text-gray-500">Default settings.</p>
      ) : (
        <ul className="mt-2 flex flex-col gap-0.5">
          {changes.map((change) => (
            <li key={change.label} className="flex justify-between gap-2">
              <span>{change.label}</span>
              <span>
                {change.value} <span className="text-gray-500">(default {change.defaultValue})</span>
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
