export interface DatasetOption {
  id: number;
  name: string;
  exported: boolean;
  taskType: string;
  itemCount: number;
  splitCounts: Record<string, number>;
  classes: { name: string; instances: number }[];
}

interface DatasetSummaryProps {
  dataset: DatasetOption | null;
  runCount?: number;
}

export function DatasetSummary({ dataset, runCount }: DatasetSummaryProps) {
  if (dataset === null) {
    return null;
  }
  const splits = ["train", "val", "test"].filter((split) => split in dataset.splitCounts);
  const withExamples = dataset.classes.filter((entry) => entry.instances > 0);
  const withoutExamples = dataset.classes.length - withExamples.length;
  const line = [
    dataset.taskType,
    `${dataset.itemCount} frames`,
    ...(splits.length > 0
      ? [splits.map((split) => `${split} ${dataset.splitCounts[split]}`).join(" / ")]
      : []),
  ].join(" · ");

  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[13px] text-gray-400">
      <span>{line}</span>
      {dataset.classes.length === 0 ? (
        <span>No classes in this dataset.</span>
      ) : (
        <details className="relative">
          <summary className="cursor-pointer select-none text-gray-300 hover:text-white">
            {`${withExamples.length} ${withExamples.length === 1 ? "class" : "classes"}`}
          </summary>
          <div className="absolute left-0 z-10 mt-1 min-w-56 rounded border border-gray-700 bg-gray-900 p-3 shadow-lg">
            {withExamples.length > 0 && (
              <ul className="max-h-60 overflow-y-auto text-sm text-gray-200">
                {withExamples.map((entry) => (
                  <li key={entry.name} className="flex justify-between gap-4 py-0.5">
                    <span className="truncate">{entry.name}</span>
                    <span className="text-gray-400">{entry.instances}</span>
                  </li>
                ))}
              </ul>
            )}
            {withoutExamples > 0 && (
              <p className="mt-1 text-[13px] text-gray-400">
                {`+${withoutExamples} ${withoutExamples === 1 ? "class" : "classes"} without examples`}
              </p>
            )}
          </div>
        </details>
      )}
      {runCount !== undefined && <span>{`${runCount} ${runCount === 1 ? "run" : "runs"}`}</span>}
      {!dataset.exported && (
        <span
          role="status"
          className="rounded border border-yellow-800 bg-yellow-950 px-2 py-0.5 text-yellow-300"
        >
          This dataset has no export yet. Export it on the Dataset screen before training.
        </span>
      )}
    </div>
  );
}
