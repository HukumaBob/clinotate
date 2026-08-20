import { useEffect, useState } from "react";

export interface DatasetOption {
  id: number;
  name: string;
  exported: boolean;
}

export interface TrainConfigValues {
  datasetId: number;
  baseModel: string;
  epochs: number;
  batch: number;
  imgsz: number;
}

interface TrainConfigFormProps {
  datasets: DatasetOption[];
  disabled: boolean;
  onSubmit: (values: TrainConfigValues) => void;
}

const BASE_MODELS = ["yolo11n.pt", "yolo11s.pt", "yolo11m.pt"];

export function TrainConfigForm({ datasets, disabled, onSubmit }: TrainConfigFormProps) {
  const firstExported = datasets.find((dataset) => dataset.exported);

  const [datasetId, setDatasetId] = useState<number | "">(firstExported?.id ?? "");

  // TrainPage renders this form before its /datasets fetch resolves, so on a
  // real page load `datasets` is still empty when the useState initializer
  // above runs -- and an initializer runs only once. Without this effect the
  // field stays empty even after the datasets arrive, making the user pick a
  // dataset by hand on every visit. Only fills an *unset* field, so a manual
  // choice survives any later refresh of the list.
  useEffect(() => {
    if (datasetId === "" && firstExported) {
      setDatasetId(firstExported.id);
    }
  }, [datasetId, firstExported]);
  const [baseModel, setBaseModel] = useState(BASE_MODELS[0]);
  const [epochs, setEpochs] = useState(50);
  const [batch, setBatch] = useState(8);
  const [imgsz, setImgsz] = useState(640);
  const [advancedOpen, setAdvancedOpen] = useState(false);

  function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (datasetId === "") {
      return;
    }
    onSubmit({ datasetId, baseModel, epochs, batch, imgsz });
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-4 text-sm text-gray-200">
      <div className="flex flex-col gap-1">
        <label htmlFor="train-dataset" className="text-xs uppercase tracking-wide text-gray-400">
          Dataset
        </label>
        <select
          id="train-dataset"
          className="rounded border border-gray-700 bg-gray-950 px-2 py-1 text-gray-100"
          value={datasetId}
          onChange={(e) => setDatasetId(e.target.value === "" ? "" : Number(e.target.value))}
        >
          <option value="" disabled>
            Select a dataset
          </option>
          {datasets.map((dataset) => (
            <option key={dataset.id} value={dataset.id} disabled={!dataset.exported}>
              {dataset.name}
              {!dataset.exported ? " — export it first" : ""}
            </option>
          ))}
        </select>
      </div>

      <div className="flex flex-col gap-1">
        <label htmlFor="train-base-model" className="text-xs uppercase tracking-wide text-gray-400">
          Base model
        </label>
        <select
          id="train-base-model"
          className="rounded border border-gray-700 bg-gray-950 px-2 py-1 text-gray-100"
          value={baseModel}
          onChange={(e) => setBaseModel(e.target.value)}
        >
          {BASE_MODELS.map((model) => (
            <option key={model} value={model}>
              {model}
            </option>
          ))}
        </select>
      </div>

      <div className="flex flex-col gap-1">
        <label htmlFor="train-epochs" className="text-xs uppercase tracking-wide text-gray-400">
          Epochs
        </label>
        <input
          id="train-epochs"
          type="number"
          min={1}
          max={1000}
          className="rounded border border-gray-700 bg-gray-950 px-2 py-1 text-gray-100"
          value={epochs}
          onChange={(e) => setEpochs(Number(e.target.value))}
        />
      </div>

      <div className="flex flex-col gap-1">
        <label htmlFor="train-batch" className="text-xs uppercase tracking-wide text-gray-400">
          Batch
        </label>
        <input
          id="train-batch"
          type="number"
          min={1}
          max={256}
          className="rounded border border-gray-700 bg-gray-950 px-2 py-1 text-gray-100"
          value={batch}
          onChange={(e) => setBatch(Number(e.target.value))}
        />
      </div>

      <div className="flex flex-col gap-2">
        <button
          type="button"
          className="self-start text-xs text-gray-400 hover:text-gray-100"
          onClick={() => setAdvancedOpen((open) => !open)}
        >
          {advancedOpen ? "▾" : "▸"} Advanced
        </button>
        {advancedOpen && (
          <div className="flex flex-col gap-1">
            <label htmlFor="train-imgsz" className="text-xs uppercase tracking-wide text-gray-400">
              Image size
            </label>
            <input
              id="train-imgsz"
              type="number"
              min={32}
              step={32}
              className="rounded border border-gray-700 bg-gray-950 px-2 py-1 text-gray-100"
              value={imgsz}
              onChange={(e) => setImgsz(Number(e.target.value))}
            />
          </div>
        )}
      </div>

      <button
        type="submit"
        disabled={disabled}
        className="rounded border border-gray-700 bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-500 disabled:cursor-not-allowed disabled:bg-gray-700 disabled:text-gray-400"
      >
        Start training
      </button>
    </form>
  );
}
