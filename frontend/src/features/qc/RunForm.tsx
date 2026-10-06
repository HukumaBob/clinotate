import { useState } from "react";

export interface ModelOption {
  id: number;
  name: string;
  task_type: string;
}

export interface VideoOption {
  id: number;
  title: string;
}

interface RunFormProps {
  models: ModelOption[];
  videos: VideoOption[];
  videoId: number | null;
  onVideoChange: (id: number | null) => void;
  onSubmit: (values: { modelVersionId: number; videoId: number; frameStride: number }) => void;
  submitting: boolean;
  error: string | null;
}

const FIELD =
  "rounded border border-gray-700 bg-gray-900 px-2 py-1.5 text-sm text-gray-100 focus:border-blue-500 focus:outline-none";

export function RunForm({
  models,
  videos,
  videoId,
  onVideoChange,
  onSubmit,
  submitting,
  error,
}: RunFormProps) {
  const [modelId, setModelId] = useState<number | null>(null);
  const [stride, setStride] = useState(1);

  const canRun = modelId !== null && videoId !== null && stride >= 1 && !submitting;

  function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (modelId === null || videoId === null) return;
    onSubmit({ modelVersionId: modelId, videoId, frameStride: stride });
  }

  return (
    <form
      onSubmit={handleSubmit}
      className="flex flex-col gap-3 rounded border border-gray-800 bg-gray-900 p-4"
    >
      <h2 className="text-sm font-semibold text-gray-200">Run inference</h2>

      {models.length === 0 ? (
        <p className="text-sm text-gray-500">Train a detect or segment model first.</p>
      ) : (
        <label className="flex flex-col gap-1 text-sm text-gray-300">
          Model
          <select
            value={modelId ?? ""}
            onChange={(e) => setModelId(e.target.value ? Number(e.target.value) : null)}
            className={FIELD}
          >
            <option value="" disabled>
              Select a model
            </option>
            {models.map((model) => (
              <option key={model.id} value={model.id}>
                {model.name} ({model.task_type})
              </option>
            ))}
          </select>
        </label>
      )}

      <label className="flex flex-col gap-1 text-sm text-gray-300">
        Video
        <select
          value={videoId ?? ""}
          onChange={(e) => onVideoChange(e.target.value ? Number(e.target.value) : null)}
          className={FIELD}
        >
          <option value="" disabled>
            Select a video
          </option>
          {videos.map((video) => (
            <option key={video.id} value={video.id}>
              {video.title}
            </option>
          ))}
        </select>
      </label>

      <div className="flex flex-col gap-1">
        <label className="flex flex-col gap-1 text-sm text-gray-300">
          Frame stride
          <input
            type="number"
            min={1}
            max={1000}
            value={stride}
            onChange={(e) => setStride(Number(e.target.value))}
            aria-describedby="frame-stride-help"
            className={FIELD}
          />
        </label>
        <p id="frame-stride-help" className="text-xs text-gray-500">
          1 runs every frame; 5 runs every fifth frame, which is much faster on a long video.
        </p>
      </div>

      {error && <p className="text-sm text-red-400">{error}</p>}

      <button
        type="submit"
        disabled={!canRun}
        className="rounded bg-blue-600 px-3 py-1.5 text-sm text-white disabled:opacity-50"
      >
        Run
      </button>
    </form>
  );
}
