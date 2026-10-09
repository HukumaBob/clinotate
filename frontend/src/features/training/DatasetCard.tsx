// DatasetCard.tsx
export interface DatasetOption {
  id: number;
  name: string;
  exported: boolean;
  taskType: string;
  itemCount: number;
  splitCounts: Record<string, number>;
  classes: { name: string; instances: number }[];
}

export function DatasetCard({
  dataset,
  runCount,
}: {
  dataset: DatasetOption | null;
  runCount?: number;
}) {
  if (dataset === null) {
    return null;
  }
  const splits = ["train", "val", "test"].filter((split) => split in dataset.splitCounts);
  return (
    <div className="rounded border border-gray-800 bg-gray-950 p-3 text-xs text-gray-300">
      <div className="flex items-center justify-between">
        <span className="rounded bg-gray-800 px-2 py-0.5 text-gray-200">{dataset.taskType}</span>
        {runCount !== undefined && <span>{runCount} {runCount === 1 ? "run" : "runs"}</span>}
        <span>{dataset.itemCount} frames</span>
      </div>
      <p className="mt-2 text-gray-400">
        {splits.map((split) => `${split} ${dataset.splitCounts[split]}`).join(" · ")}
      </p>
      <div className="mt-2">
        <p className="mb-1 uppercase tracking-wide text-gray-500">Classes</p>
        {dataset.classes.length === 0 ? (
          <p className="text-gray-500">No classes in this dataset.</p>
        ) : (
          <ul className="max-h-40 overflow-y-auto">
            {dataset.classes.map((entry) => (
              <li key={entry.name} className="flex justify-between gap-2 py-0.5">
                <span className="truncate">{entry.name}</span>
                <span className="text-gray-400">{entry.instances}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
      {!dataset.exported && (
        <p role="status" className="mt-2 rounded border border-yellow-800 bg-yellow-950 px-2 py-1 text-yellow-300">
          This dataset has no export yet. Export it on the Dataset screen before training.
        </p>
      )}
    </div>
  );
}
