import { DatasetCard, type DatasetOption } from "./DatasetCard";

interface DatasetRailProps {
  datasets: DatasetOption[];
  selectedId: number | null;
  onSelect: (id: number | null) => void;
  runCount?: number;
}

export function DatasetRail({ datasets, selectedId, onSelect, runCount }: DatasetRailProps) {
  const selected = datasets.find((dataset) => dataset.id === selectedId) ?? null;
  return (
    <div className="flex flex-col gap-3">
      <label htmlFor="train-dataset" className="text-xs uppercase tracking-wide text-gray-400">
        Dataset
      </label>
      <select
        id="train-dataset"
        className="rounded border border-gray-700 bg-gray-950 px-2 py-1 text-sm text-gray-100"
        value={selectedId ?? ""}
        onChange={(event) => onSelect(event.target.value === "" ? null : Number(event.target.value))}
      >
        <option value="" disabled>
          Select a dataset
        </option>
        {datasets.map((dataset) => (
          <option key={dataset.id} value={dataset.id} disabled={!dataset.exported}>
            {`${dataset.name} · ${dataset.taskType} · ${dataset.itemCount} frames`}
            {!dataset.exported ? " — export it first" : ""}
          </option>
        ))}
      </select>
      <DatasetCard dataset={selected} runCount={runCount} />
    </div>
  );
}
