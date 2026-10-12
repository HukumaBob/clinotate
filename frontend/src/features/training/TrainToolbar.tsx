import { DatasetSummary, type DatasetOption } from "./DatasetSummary";

interface TrainToolbarProps {
  datasets: DatasetOption[];
  selectedId: number | null;
  onSelect: (id: number | null) => void;
  runCount?: number;
  onNewRun: () => void;
  formOpen: boolean;
  onCloseForm: () => void;
}

export function TrainToolbar({
  datasets,
  selectedId,
  onSelect,
  runCount,
  onNewRun,
  formOpen,
  onCloseForm,
}: TrainToolbarProps) {
  const selected = datasets.find((dataset) => dataset.id === selectedId) ?? null;
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
      <select
        aria-label="Dataset"
        className="h-8 rounded border border-gray-700 bg-gray-950 px-2 text-sm text-gray-100"
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
      <DatasetSummary dataset={selected} runCount={selected ? runCount : undefined} />
      <button
        type="button"
        disabled={!formOpen && selected === null}
        onClick={formOpen ? onCloseForm : onNewRun}
        className="ml-auto h-8 rounded bg-blue-600 px-3 text-sm font-medium text-white hover:bg-blue-500 disabled:cursor-not-allowed disabled:bg-gray-800 disabled:text-gray-400"
      >
        {formOpen ? "← Runs" : "+ New run"}
      </button>
    </div>
  );
}
