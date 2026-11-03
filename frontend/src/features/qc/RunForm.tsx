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

export type PerturbationKind = "gaussian_noise" | "blur" | "brightness" | "jpeg";
export interface PerturbationValue {
  kind: PerturbationKind;
  strength: number;
}

// Ranges mirror backend/app/inference/schemas.py PERTURBATION_RANGES.
const PERTURBATIONS: Record<
  PerturbationKind,
  { label: string; min: number; max: number; def: number }
> = {
  gaussian_noise: { label: "Noise", min: 1, max: 100, def: 10 },
  blur: { label: "Blur", min: 0.5, max: 20, def: 2 },
  brightness: { label: "Brightness", min: -100, max: 100, def: 30 },
  jpeg: { label: "JPEG quality", min: 5, max: 95, def: 30 },
};

export const MAX_AXES = 6;

interface AxisRow {
  modelId: number | null;
  name: string;
}

export type RunFormValues =
  | {
      modelVersionId: number;
      videoId: number;
      frameStride: number;
      perturbation: PerturbationValue | null;
    }
  | {
      classifiers: { modelVersionId: number; name?: string }[];
      videoId: number;
      frameStride: number;
      perturbation: PerturbationValue | null;
    };

interface RunFormProps {
  models: ModelOption[];
  classifyModels: ModelOption[];
  videos: VideoOption[];
  videoId: number | null;
  onVideoChange: (id: number | null) => void;
  onSubmit: (values: RunFormValues) => void;
  submitting: boolean;
  error: string | null;
}

const FIELD =
  "rounded border border-gray-700 bg-gray-900 px-2 py-1.5 text-sm text-gray-100 focus:border-blue-500 focus:outline-none";

export function RunForm({
  models,
  classifyModels,
  videos,
  videoId,
  onVideoChange,
  onSubmit,
  submitting,
  error,
}: RunFormProps) {
  const [mode, setMode] = useState<"detect" | "classify">("detect");
  const [axes, setAxes] = useState<AxisRow[]>([]);
  const [modelId, setModelId] = useState<number | null>(null);
  const [stride, setStride] = useState(1);
  const [kind, setKind] = useState<PerturbationKind | "">("");
  const [strength, setStrength] = useState(0);

  const spec = kind ? PERTURBATIONS[kind] : null;
  const strengthProblem =
    spec && kind
      ? !Number.isFinite(strength) ||
        strength < spec.min ||
        strength > spec.max ||
        (kind === "brightness" && strength === 0)
        ? `${spec.label} strength must be ${spec.min} to ${spec.max}${kind === "brightness" ? ", not 0" : ""}`
        : null
      : null;

  const usedIds = axes.flatMap((a) => (a.modelId === null ? [] : [a.modelId]));
  const canAddAxis = axes.length < MAX_AXES && usedIds.length < classifyModels.length;
  const modelReady =
    mode === "detect" ? modelId !== null : axes.length > 0 && axes.every((a) => a.modelId !== null);
  const canRun = modelReady && videoId !== null && stride >= 1 && !strengthProblem && !submitting;

  function updateAxis(index: number, patch: Partial<AxisRow>) {
    setAxes((rows) => rows.map((row, i) => (i === index ? { ...row, ...patch } : row)));
  }

  function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (videoId === null) return;
    const common = {
      videoId,
      frameStride: stride,
      perturbation: kind ? { kind, strength } : null,
    };
    if (mode === "classify") {
      if (!modelReady) return;
      onSubmit({
        classifiers: axes.map((a) => {
          const name = a.name.trim();
          return name
            ? { modelVersionId: a.modelId as number, name }
            : { modelVersionId: a.modelId as number };
        }),
        ...common,
      });
      return;
    }
    if (modelId === null) return;
    onSubmit({ modelVersionId: modelId, ...common });
  }

  return (
    <form
      onSubmit={handleSubmit}
      className="flex flex-col gap-3 rounded border border-gray-800 bg-gray-900 p-4"
    >
      <h2 className="text-sm font-semibold text-gray-200">Run inference</h2>

      <div className="flex gap-2" role="group" aria-label="Run mode">
        {(
          [
            ["detect", "Detect / segment"],
            ["classify", "Classify"],
          ] as const
        ).map(([value, label]) => (
          <button
            key={value}
            type="button"
            aria-pressed={mode === value}
            onClick={() => setMode(value)}
            className={`rounded border px-3 py-1 text-sm ${
              mode === value
                ? "border-blue-500 bg-blue-600/20 text-white"
                : "border-gray-700 text-gray-300 hover:text-white"
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {mode === "detect" ? (
        models.length === 0 ? (
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
        )
      ) : classifyModels.length === 0 ? (
        <p className="text-sm text-gray-500">Train a classification model first.</p>
      ) : (
        <div className="flex flex-col gap-2">
          {axes.map((axis, index) => (
            <div key={index} className="flex gap-2">
              <select
                aria-label={`Axis ${index + 1} model`}
                value={axis.modelId ?? ""}
                onChange={(e) =>
                  updateAxis(index, {
                    modelId: e.target.value ? Number(e.target.value) : null,
                  })
                }
                className={`${FIELD} flex-1`}
              >
                <option value="" disabled>
                  Select a model
                </option>
                {classifyModels.map((model) => (
                  <option
                    key={model.id}
                    value={model.id}
                    disabled={usedIds.includes(model.id) && model.id !== axis.modelId}
                  >
                    {model.name}
                  </option>
                ))}
              </select>
              <input
                type="text"
                aria-label={`Axis ${index + 1} name`}
                placeholder="Axis name (optional)"
                value={axis.name}
                onChange={(e) => updateAxis(index, { name: e.target.value })}
                className={`${FIELD} flex-1`}
              />
              <button
                type="button"
                aria-label={`Remove axis ${index + 1}`}
                onClick={() => setAxes((rows) => rows.filter((_, i) => i !== index))}
                className="text-sm text-gray-400 hover:text-white"
              >
                Remove
              </button>
            </div>
          ))}
          <button
            type="button"
            disabled={!canAddAxis}
            onClick={() => setAxes((rows) => [...rows, { modelId: null, name: "" }])}
            className="self-start text-sm text-blue-400 hover:underline disabled:opacity-50 disabled:no-underline"
          >
            Add axis
          </button>
        </div>
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

      <div className="flex flex-col gap-1">
        <label className="flex flex-col gap-1 text-sm text-gray-300">
          Perturbation
          <select
            value={kind}
            onChange={(e) => {
              const next = e.target.value as PerturbationKind | "";
              setKind(next);
              if (next) setStrength(PERTURBATIONS[next].def);
            }}
            className={FIELD}
          >
            <option value="">None</option>
            {(Object.keys(PERTURBATIONS) as PerturbationKind[]).map((k) => (
              <option key={k} value={k}>
                {PERTURBATIONS[k].label}
              </option>
            ))}
          </select>
        </label>
        {spec && (
          <label className="flex flex-col gap-1 text-sm text-gray-300">
            Perturbation strength
            <input
              type="number"
              step="any"
              value={Number.isNaN(strength) ? "" : strength}
              onChange={(e) => setStrength(e.target.value === "" ? NaN : Number(e.target.value))}
              className={FIELD}
            />
          </label>
        )}
        {strengthProblem && <p className="text-xs text-red-400">{strengthProblem}</p>}
        {spec && !strengthProblem && (
          <p className="text-xs text-gray-500">
            The frames are degraded before the model sees them (a stress test).
          </p>
        )}
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
