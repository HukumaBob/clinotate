import { useEffect, useRef, useState } from "react";

import type { components } from "../../shared/api/generated/schema";
import type { DatasetOption } from "./DatasetSummary";
import { RunSummary } from "./RunSummary";
import { SettingsForm } from "./SettingsForm";
import {
  allFields,
  applyPreset,
  changedSettings,
  defaultValues,
  isChanged,
  validateSettings,
  type SettingsSchema,
  type SettingsValues,
} from "./settingsLogic";

type BaseModelOption = components["schemas"]["BaseModelOption"];

export type { DatasetOption } from "./DatasetSummary";

export interface TrainConfigValues {
  datasetId: number;
  baseModel: string | null;
  baseModelVersionId: number | null;
  name: string;
  note: string;
  settings: Record<string, number | boolean | string>;
}

interface TrainConfigFormProps {
  dataset: DatasetOption | null;
  disabled: boolean;
  onSubmit: (values: TrainConfigValues) => void;
  baseModels?: BaseModelOption[];
  baseModelsError?: string | null;
  settingsSchema?: SettingsSchema | null;
  settingsSchemaError?: string | null;
  // Settings and base model of an earlier run, applied once per nonce.
  prefill?: { nonce: number; baseKey: string; values: SettingsValues } | null;
  // Changing this value clears the run name and note (not the settings).
  clearTextSignal?: number;
}

const keyOf = (option: BaseModelOption) =>
  option.kind === "model_version"
    ? `version:${option.model_version_id}`
    : `pretrained:${option.weights}`;

const optionText = (option: BaseModelOption) => {
  const name = option.kind === "model_version" ? option.label : option.weights;
  return option.note ? `${name} — ${option.note}` : name;
};

const firstPretrainedKey = (options: BaseModelOption[]) => {
  const first = options.find((option) => option.kind === "pretrained");
  return first ? keyOf(first) : "";
};

export function TrainConfigForm({
  dataset,
  disabled,
  onSubmit,
  baseModels = [],
  baseModelsError = null,
  settingsSchema = null,
  settingsSchemaError = null,
  prefill = null,
  clearTextSignal,
}: TrainConfigFormProps) {
  const [baseKey, setBaseKey] = useState("");
  // The list changes with the dataset; a selection that is no longer offered
  // falls back to the first pretrained model.
  useEffect(() => {
    if (!baseModels.some((option) => keyOf(option) === baseKey)) {
      setBaseKey(firstPretrainedKey(baseModels));
    }
  }, [baseModels, baseKey]);
  const pretrainedOptions = baseModels.filter((option) => option.kind === "pretrained");
  const versionOptions = baseModels.filter((option) => option.kind === "model_version");
  const [values, setValues] = useState<SettingsValues>(() =>
    settingsSchema ? defaultValues(settingsSchema) : {},
  );
  const [name, setName] = useState("");
  const [note, setNote] = useState("");
  // The page passes a new schema object only when a new schema arrives (a
  // different dataset), so edits survive unrelated re-renders.
  useEffect(() => {
    if (settingsSchema) {
      setValues(defaultValues(settingsSchema));
    }
  }, [settingsSchema]);

  // Declared after the schema-reset effect so a prefill wins over the defaults
  // set in the same commit. Waits until the catalog and the schema are loaded.
  const appliedPrefillRef = useRef<number | null>(null);
  useEffect(() => {
    if (!prefill || appliedPrefillRef.current === prefill.nonce) return;
    if (baseModels.length === 0 || !settingsSchema) return;
    appliedPrefillRef.current = prefill.nonce;
    setBaseKey(
      baseModels.some((option) => keyOf(option) === prefill.baseKey)
        ? prefill.baseKey
        : firstPretrainedKey(baseModels),
    );
    setValues(prefill.values);
  }, [prefill, baseModels, settingsSchema]);

  const firstSignalRef = useRef(true);
  useEffect(() => {
    if (firstSignalRef.current) {
      firstSignalRef.current = false;
      return;
    }
    setName("");
    setNote("");
  }, [clearTextSignal]);

  const errors = settingsSchema ? validateSettings(settingsSchema, values) : {};
  const errorCount = Object.keys(errors).length;
  const changes = settingsSchema
    ? allFields(settingsSchema)
        .filter((field) => isChanged(field, values[field.key]))
        .map((field) => ({
          label: field.label,
          value: String(values[field.key] ?? "none"),
          defaultValue: field.default === null ? "none" : String(field.default),
        }))
    : [];
  const selectedBase = baseModels.find((option) => keyOf(option) === baseKey);
  const baseLabel = selectedBase
    ? selectedBase.kind === "model_version"
      ? selectedBase.label
      : (selectedBase.weights ?? "")
    : "";

  function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (!dataset || !dataset.exported || baseKey === "" || settingsSchema === null) {
      return;
    }
    const isVersion = baseKey.startsWith("version:");
    onSubmit({
      datasetId: dataset.id,
      baseModel: isVersion ? null : baseKey.slice("pretrained:".length),
      baseModelVersionId: isVersion ? Number(baseKey.slice("version:".length)) : null,
      name: name.trim(),
      note: note.trim(),
      settings: changedSettings(settingsSchema, values),
    });
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-4 text-sm text-gray-200">
      <div className="flex flex-col gap-1">
        <label htmlFor="train-base-model" className="text-xs uppercase tracking-wide text-gray-400">
          Base model
        </label>
        <select
          id="train-base-model"
          className="rounded border border-gray-700 bg-gray-950 px-2 py-1 text-gray-100"
          value={baseKey}
          disabled={baseModels.length === 0}
          onChange={(e) => setBaseKey(e.target.value)}
        >
          <optgroup label="Pretrained (YOLO11)">
            {pretrainedOptions.map((option) => (
              <option key={keyOf(option)} value={keyOf(option)}>
                {optionText(option)}
              </option>
            ))}
          </optgroup>
          {versionOptions.length > 0 && (
            <optgroup label="Your models (fine-tune)">
              {versionOptions.map((option) => (
                <option key={keyOf(option)} value={keyOf(option)}>
                  {optionText(option)}
                </option>
              ))}
            </optgroup>
          )}
        </select>
        {baseKey.startsWith("version:") && (
          <p className="text-xs text-gray-500">
            Matching layers are kept. If this dataset's classes differ from the parent's, the
            model's head is re-initialised — see the log.
          </p>
        )}
        {baseModelsError && <p className="text-xs text-red-300">{baseModelsError}</p>}
      </div>

      <div className="flex flex-col gap-1">
        <label htmlFor="train-name" className="text-xs uppercase tracking-wide text-gray-400">
          Run name (optional)
        </label>
        <input
          id="train-name"
          type="text"
          maxLength={200}
          className="rounded border border-gray-700 bg-gray-950 px-2 py-1 text-gray-100"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
      </div>

      <div className="flex flex-col gap-1">
        <label htmlFor="train-note" className="text-xs uppercase tracking-wide text-gray-400">
          Note (optional)
        </label>
        <textarea
          id="train-note"
          maxLength={5000}
          rows={2}
          className="rounded border border-gray-700 bg-gray-950 px-2 py-1 text-gray-100"
          value={note}
          onChange={(e) => setNote(e.target.value)}
        />
      </div>

      {settingsSchema ? (
        <SettingsForm
          schema={settingsSchema}
          values={values}
          errors={errors}
          onChange={(key, value) => setValues((current) => ({ ...current, [key]: value }))}
          onReset={(key) => {
            const field = allFields(settingsSchema).find((candidate) => candidate.key === key);
            setValues((current) => ({ ...current, [key]: field?.default ?? null }));
          }}
          onApplyPreset={(presetId) => setValues(applyPreset(settingsSchema, presetId))}
        />
      ) : settingsSchemaError ? (
        <p className="text-xs text-red-300">{settingsSchemaError}</p>
      ) : (
        <p className="text-xs text-gray-500">Loading settings…</p>
      )}

      <div className="sticky -bottom-4 -mx-4 -mb-4 flex flex-col gap-3 border-t border-gray-800 bg-gray-900 px-4 pb-4 pt-3">
        {settingsSchema && dataset && (
          <RunSummary
            datasetName={dataset.name}
            taskType={dataset.taskType}
            baseLabel={baseLabel}
            changes={changes}
          />
        )}

        {errorCount > 0 && (
          <p role="alert" className="text-xs text-red-300">
            {errorCount === 1 ? "1 setting needs attention" : `${errorCount} settings need attention`}
          </p>
        )}

        <button
          type="submit"
          disabled={
            disabled ||
            !dataset ||
            !dataset.exported ||
            baseKey === "" ||
            !settingsSchema ||
            errorCount > 0
          }
          className="rounded border border-gray-700 bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-500 disabled:cursor-not-allowed disabled:bg-gray-700 disabled:text-gray-400"
        >
          Start training
        </button>
      </div>
    </form>
  );
}
